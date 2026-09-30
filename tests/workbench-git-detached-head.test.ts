import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import path, { join } from 'node:path'

import { describe, test } from 'bun:test'

import type { WorkbenchI18nContextValue } from '../src/renderer/src/i18n'
import { translateWorkbenchAppMessage } from '../src/renderer/src/i18n/useStandaloneWorkbenchLocalization'
import {
  buildWorkbenchGitTopBarSummary,
  describeWorkbenchGitHead,
  resolveWorkbenchCanShowGitBranchControl,
} from '../src/renderer/src/models/git/workbenchGitTopBarModel'
import type {
  AppLocale,
  SystemWorkspaceGitLineStatsSnapshot,
} from '../src/shared/contracts'

import {
  commitAll,
  createGitService,
  git,
  initRepository,
  isAppError,
  withRepository,
  withTempDirectory,
} from './helpers/gitRepository'

function readSource(relativePath: string): string {
  return readFileSync(path.resolve(process.cwd(), relativePath), 'utf8')
}

function translator(locale: AppLocale): WorkbenchI18nContextValue['t'] {
  return (key, params) => translateWorkbenchAppMessage(locale, key, params)
}

void describe('Workbench Git on a detached HEAD', () => {
  void test('the status names the commit HEAD is detached at, and a branch can be switched back to', async () => {
    await withRepository(async (root) => {
      const service = createGitService()
      // 还没有提交：HEAD 指着还没出生的分支，不是分离的。
      const unborn = await service.getSummary(root)
      assert.equal(unborn.status?.branch, 'main')
      assert.equal(unborn.status?.detachedHead, null)

      await writeFile(join(root, 'a.txt'), 'one\n')
      await commitAll(root, 'first')
      await writeFile(join(root, 'a.txt'), 'two\n')
      await commitAll(root, 'second')
      const first = (await git(root, ['rev-parse', 'HEAD~1'])).trim()
      const onBranch = await service.getSummary(root)
      assert.equal(onBranch.status?.branch, 'main')
      assert.equal(onBranch.status?.detachedHead, null)
      assert.equal((await service.getLineStats(root)).detachedHead, null)

      await git(root, ['checkout', '-q', '--detach', first])
      const detached = await service.getSummary(root)
      assert.equal(detached.status?.branch, null)
      assert.deepEqual(detached.status?.detachedHead, {
        sha: first,
        shortSha: (await git(root, ['rev-parse', '--short', first])).trim(),
      })
      const lineStats = await service.getLineStats(root)
      assert.equal(lineStats.branch, null)
      assert.deepEqual(lineStats.detachedHead, detached.status?.detachedHead)

      // 从分离的 HEAD 切回分支、或从这个提交新建分支。
      const switched = await service.switchBranch(root, 'main')
      assert.equal(switched.previousBranch, null)
      assert.equal(switched.summary.status?.branch, 'main')
      assert.equal(switched.summary.status?.detachedHead, null)
      await git(root, ['checkout', '-q', '--detach', first])
      const created = await service.switchBranch(root, 'from-commit', { create: true })
      assert.equal(created.summary.status?.branch, 'from-commit')
      assert.equal((await git(root, ['rev-parse', 'from-commit'])).trim(), first)
    })
  })

  void test('fetch and pushing a named branch still work; pull, sync and a bare push say why they cannot', async () => {
    await withTempDirectory(async (base) => {
      const origin = join(base, 'origin.git')
      await git(base, ['init', '-q', '--bare', '-b', 'main', origin])
      const root = join(base, 'work')
      await git(base, ['clone', '-q', origin, root])
      await git(root, ['switch', '-q', '-c', 'main'])
      await initRepository(root)
      await writeFile(join(root, 'a.txt'), 'one\n')
      await commitAll(root, 'first')
      await git(root, ['push', '-q', '-u', 'origin', 'main'])
      await writeFile(join(root, 'a.txt'), 'two\n')
      await commitAll(root, 'second')
      await git(root, ['checkout', '-q', '--detach'])

      const service = createGitService()
      const fetched = await service.performRemoteAction(root, 'fetch')
      assert.equal(fetched.action.branch, null)
      assert.equal(fetched.summary.status?.detachedHead?.sha.length, 40)

      for (const action of ['pull', 'sync', 'upload'] as const)
        await assert.rejects(
          service.performRemoteAction(root, action),
          isAppError('VALIDATION', /分离的 HEAD/)
        )

      // 分支菜单里推送点名的分支：不看 HEAD 在哪儿。
      const pushed = await service.performRemoteAction(root, 'upload', { branch: 'main' })
      assert.equal(pushed.action.branch, 'main')
      assert.equal(
        (await git(origin, ['rev-parse', 'main'])).trim(),
        (await git(root, ['rev-parse', 'main'])).trim()
      )
    })
  })

  void test('the toolbar keeps the Git control and labels it with the short commit', () => {
    const detachedHead = { sha: '1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d', shortSha: '1a2b3c4' }
    assert.equal(
      describeWorkbenchGitHead({ branch: null, detachedHead }, translator('en-US')),
      'Detached HEAD · 1a2b3c4'
    )
    assert.equal(
      describeWorkbenchGitHead({ branch: null, detachedHead }, translator('zh-CN')),
      '分离的 HEAD · 1a2b3c4'
    )
    assert.equal(
      describeWorkbenchGitHead({ branch: 'feature/x', detachedHead: null }, translator('en-US')),
      'feature/x'
    )
    assert.equal(
      describeWorkbenchGitHead({ branch: null, detachedHead: null }, translator('en-US')),
      null
    )

    // 完整快照还没到：轻量快照说 HEAD 是分离的，顶栏的 Git 控件照样出现。
    const lineStats: SystemWorkspaceGitLineStatsSnapshot = {
      rootPath: '/project',
      repository: true,
      checkedAt: 1,
      lineStats: { additions: 0, deletions: 0, changedFiles: 0, binaryFiles: 0 },
      branch: null,
      detachedHead,
    }
    const partial = buildWorkbenchGitTopBarSummary(null, lineStats)
    assert.deepEqual(partial?.status?.detachedHead, detachedHead)
    assert.equal(partial?.status?.branch, null)
    assert.equal(resolveWorkbenchCanShowGitBranchControl(null, lineStats), true)
    assert.equal(
      resolveWorkbenchCanShowGitBranchControl(null, { ...lineStats, detachedHead: null }),
      false
    )
  })

  void test('controls that need a branch stay visible, disabled, with the reason', () => {
    const toolbar = readSource('src/renderer/src/components/chrome/TopToolbar.tsx')
    const branchMenu = readSource('src/renderer/src/components/git/WorkbenchGitCommitControl.tsx')
    const sync = readSource('src/renderer/src/components/git/WorkbenchGitSyncControl.tsx')
    const commitPanel = readSource('src/renderer/src/components/git/WorkbenchCommitPanel.tsx')

    // 控件出不出现看的是「有没有 HEAD 可显示」，不再只认分支。
    assert.doesNotMatch(toolbar, /gitSummary\.status\?\.branch/u)
    assert.match(toolbar, /hasWorkbenchGitHead\(gitSummary\.status\)/u)
    assert.match(branchMenu, /describeWorkbenchGitHead\(status, t\)/u)
    assert.match(branchMenu, /branch: headLabel/u)
    assert.match(branchMenu, /workbench\.gitBranchCreateFromDetachedDescription/u)
    // 同步按钮：分离的 HEAD 上不隐藏，禁用并说明原因；菜单里只有获取远端还能点。
    assert.doesNotMatch(sync, /!status\?\.branch\) return null/u)
    assert.match(sync, /workbench\.gitDetachedHeadReason/u)
    assert.match(sync, /disabled: detached \|\| !upstream/u)
    assert.match(commitPanel, /workbench\.gitDetachedHeadReason/u)
    for (const key of [
      'workbench.gitDetachedHead',
      'workbench.gitDetachedHeadReason',
      'workbench.gitBranchCreateFromDetachedDescription',
    ]) {
      const zh = translateWorkbenchAppMessage('zh-CN', key, { sha: '1a2b3c4' })
      const en = translateWorkbenchAppMessage('en-US', key, { sha: '1a2b3c4' })
      assert.match(en, /1a2b3c4/u, `en-US is missing ${key}`)
      assert.match(zh, /1a2b3c4/u, `zh-CN is missing ${key}`)
      assert.notEqual(zh, en)
    }
  })
})
