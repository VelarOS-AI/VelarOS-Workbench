import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import path, { join } from 'node:path'

import { describe, test } from 'bun:test'

import { translateWorkbenchAppMessage } from '../src/renderer/src/i18n/useStandaloneWorkbenchLocalization'

import {
  commitAll,
  createGitService,
  entryCodes,
  git,
  initRepository,
  isAppError,
  withTempDirectory,
} from './helpers/gitRepository'

interface Clones {
  origin: string
  /** 用服务操作的那一份。 */
  local: string
  /** 另一个人：往远端推提交，造出分叉。 */
  other: string
}

/** 一个本地的裸仓库当远端，两份克隆：`local` 已经推过 main，跟踪 origin/main。 */
async function withClones(run: (clones: Clones) => Promise<void>): Promise<void> {
  await withTempDirectory(async (base) => {
    const origin = join(base, 'origin.git')
    await git(base, ['init', '-q', '--bare', '-b', 'main', origin])
    const local = join(base, 'local')
    await git(base, ['clone', '-q', origin, local])
    await git(local, ['switch', '-q', '-c', 'main'])
    await initRepository(local)
    await writeFile(join(local, 'shared.txt'), 'base\n')
    await writeFile(join(local, 'mine.txt'), 'base\n')
    await commitAll(local, 'base')
    await git(local, ['push', '-q', '-u', 'origin', 'main'])
    const other = join(base, 'other')
    await git(base, ['clone', '-q', origin, other])
    await git(other, ['config', 'user.name', 'o'])
    await git(other, ['config', 'user.email', 'o@o'])
    await run({ origin, local, other })
  })
}

/** 两边各提交一个：`other` 改 `file`（推到远端），`local` 改 mine.txt。 */
async function diverge({ local, other }: Clones, file = 'shared.txt'): Promise<void> {
  await writeFile(join(other, file), 'from other\n')
  await commitAll(other, 'other change')
  await git(other, ['push', '-q'])
  await writeFile(join(local, 'mine.txt'), 'mine\n')
  await commitAll(local, 'local change')
}

async function parents(root: string, revision = 'HEAD'): Promise<number> {
  return (await git(root, ['rev-list', '--parents', '-n', '1', revision])).trim().split(' ').length - 1
}

void describe('Workbench Git pull, fetch and sync', () => {
  void test('fetch shows how far behind the branch is; pull merges when nothing is configured', async () => {
    await withClones(async (clones) => {
      await diverge(clones)
      const service = createGitService()

      const fetched = await service.performRemoteAction(clones.local, 'fetch')
      assert.equal(fetched.summary.status?.ahead, 1)
      assert.equal(fetched.summary.status?.behind, 1)

      const pulled = await service.performRemoteAction(clones.local, 'pull')
      assert.deepEqual(pulled.action.conflicts, [])
      assert.equal(await parents(clones.local), 2, 'a merge commit, not a rebase')
      assert.equal(await readFile(join(clones.local, 'shared.txt'), 'utf8'), 'from other\n')
      assert.equal(pulled.summary.status?.behind, 0)
      assert.equal(pulled.summary.status?.ahead, 2)
    })
  })

  void test('pull follows pull.rebase and pull.ff instead of overriding them', async () => {
    await withClones(async (clones) => {
      await diverge(clones)
      await git(clones.local, ['config', 'pull.rebase', 'true'])
      const service = createGitService()
      await service.performRemoteAction(clones.local, 'pull')
      assert.equal(await parents(clones.local), 1, 'rebased: the local commit sits on top')
      assert.equal(
        (await git(clones.local, ['log', '-1', '--format=%s', 'HEAD~1'])).trim(),
        'other change'
      )
    })

    await withClones(async (clones) => {
      await diverge(clones)
      await git(clones.local, ['config', 'pull.ff', 'only'])
      await assert.rejects(
        createGitService().performRemoteAction(clones.local, 'pull'),
        isAppError('VALIDATION', /pull\.ff=only 只允许快进/)
      )
    })
  })

  void test('pull refuses to overwrite local changes and names the files', async () => {
    await withClones(async (clones) => {
      await diverge(clones)
      await writeFile(join(clones.local, 'shared.txt'), 'local edit\n')
      await assert.rejects(
        createGitService().performRemoteAction(clones.local, 'pull'),
        isAppError('VALIDATION', /会被这次拉取覆盖：shared\.txt/)
      )
      assert.equal(await readFile(join(clones.local, 'shared.txt'), 'utf8'), 'local edit\n')
    })
  })

  void test('a conflicting pull hands the files to the conflict group, and sync then does not push', async () => {
    await withClones(async (clones) => {
      await writeFile(join(clones.other, 'shared.txt'), 'from other\n')
      await commitAll(clones.other, 'other change')
      await git(clones.other, ['push', '-q'])
      await writeFile(join(clones.local, 'shared.txt'), 'from local\n')
      await commitAll(clones.local, 'local change')
      const remoteHead = (await git(clones.origin, ['rev-parse', 'main'])).trim()

      const service = createGitService()
      const synced = await service.performRemoteAction(clones.local, 'sync')
      assert.deepEqual(synced.action.conflicts, ['shared.txt'])
      assert.equal(synced.action.rebasing, false)
      assert.deepEqual(entryCodes(synced.summary), ['UU shared.txt'])
      assert.equal((await git(clones.origin, ['rev-parse', 'main'])).trim(), remoteHead)

      // 解决、标记、提交，完成这次合并。
      await writeFile(join(clones.local, 'shared.txt'), 'resolved\n')
      await service.performFileAction(clones.local, ['shared.txt'], 'resolve')
      const merged = await service.commitStaged(clones.local, 'en-US')
      assert.match(merged.commit.message, /^Merge branch 'main'/)
      await service.performRemoteAction(clones.local, 'sync')
      assert.equal(
        (await git(clones.origin, ['rev-parse', 'main'])).trim(),
        (await git(clones.local, ['rev-parse', 'HEAD'])).trim()
      )
    })
  })

  void test('a conflicting rebase pull says so, and committing waits for the rebase', async () => {
    await withClones(async (clones) => {
      await writeFile(join(clones.other, 'shared.txt'), 'from other\n')
      await commitAll(clones.other, 'other change')
      await git(clones.other, ['push', '-q'])
      await writeFile(join(clones.local, 'shared.txt'), 'from local\n')
      await commitAll(clones.local, 'local change')
      await git(clones.local, ['config', 'pull.rebase', 'true'])

      const service = createGitService()
      const pulled = await service.performRemoteAction(clones.local, 'pull')
      assert.deepEqual(pulled.action.conflicts, ['shared.txt'])
      assert.equal(pulled.action.rebasing, true)

      await writeFile(join(clones.local, 'shared.txt'), 'resolved\n')
      await service.performFileAction(clones.local, ['shared.txt'], 'resolve')
      await assert.rejects(
        service.commitStaged(clones.local, 'en-US', 'x'),
        isAppError('VALIDATION', /正在变基/)
      )
    })
  })

  void test('sync pulls then pushes; a plain push of a diverged branch is refused in words', async () => {
    await withClones(async (clones) => {
      await diverge(clones)
      const service = createGitService()
      await assert.rejects(
        service.performRemoteAction(clones.local, 'upload'),
        isAppError('VALIDATION', /推送被拒绝/)
      )

      const synced = await service.performRemoteAction(clones.local, 'sync')
      assert.deepEqual(synced.action.conflicts, [])
      assert.equal(synced.summary.status?.ahead, 0)
      assert.equal(synced.summary.status?.behind, 0)
      assert.equal(
        (await git(clones.origin, ['rev-parse', 'main'])).trim(),
        (await git(clones.local, ['rev-parse', 'HEAD'])).trim()
      )
    })
  })

  void test('without an upstream there is nothing to pull or sync', async () => {
    await withClones(async (clones) => {
      await git(clones.local, ['switch', '-q', '-c', 'topic'])
      for (const action of ['pull', 'sync'] as const)
        await assert.rejects(
          createGitService().performRemoteAction(clones.local, action),
          isAppError('VALIDATION', /还没有关联远端分支/)
        )
    })
  })

  void test('the toolbar control pulls, pushes and syncs the current branch, and shows conflicts', () => {
    const control = readFileSync(
      path.resolve(process.cwd(), 'src/renderer/src/components/git/WorkbenchGitBranchControl.tsx'),
      'utf8'
    )
    // 拉取、同步、推送、获取远端都在分支菜单里；同步和推送先确认，获取远端不问。
    assert.match(control, /remoteActions=\{describeWorkbenchGitRemoteActions\(status, t\)\}/)
    assert.match(control, /if \(action === 'sync'\)\s*return window\.confirm\(tLatest\.current\('workbench\.gitSyncConfirm'/)
    assert.match(control, /action !== 'fetch' && warnUnsavedOpenTabs\(\)/)
    assert.match(control, /result\.action\.conflicts\.length > 0[\s\S]*showConflicts/)
    assert.match(control, /onOpenCommitTool\(\)/)
    for (const key of [
      'workbench.gitPull',
      'workbench.gitSync',
      'workbench.gitPullFailedTitle',
      'workbench.gitSyncConfirm',
      'workbench.gitBranchAheadBehind',
      'workbench.gitNoUpstreamNote',
      'workbench.gitPushBranchConfirm',
      'workbench.gitRemoteActionRunning',
      'workbench.gitPullConflictsDescription',
      'workbench.gitPullRebaseConflictsDescription',
      'workbench.gitNoUpstreamHint',
    ]) {
      const zh = translateWorkbenchAppMessage('zh-CN', key)
      const en = translateWorkbenchAppMessage('en-US', key)
      assert.notEqual(en, key, `en-US is missing ${key}`)
      assert.notEqual(zh, en, `zh-CN is missing ${key}`)
    }
  })

  void test.skipIf(process.platform === 'win32')(
    'an SSH remote that rejects the key is reported as an authentication problem',
    async () => {
      await withClones(async (clones) => {
        await git(clones.local, ['remote', 'set-url', 'origin', 'ssh://git@example.invalid/repo.git'])
        const service = createGitService({
          GIT_SSH_COMMAND: `sh -c 'echo "git@example.invalid: Permission denied (publickey)." >&2; exit 255' --`,
        })
        await assert.rejects(
          service.performRemoteAction(clones.local, 'fetch'),
          isAppError('PERMISSION', /远端拒绝了身份验证[\s\S]*Permission denied/)
        )
      })
    }
  )
})
