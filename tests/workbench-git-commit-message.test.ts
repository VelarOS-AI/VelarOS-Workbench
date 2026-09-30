import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import path, { join } from 'node:path'

import { describe, test } from 'bun:test'

import type { WorkbenchI18nContextValue } from '../src/renderer/src/i18n'
import { translateWorkbenchAppMessage } from '../src/renderer/src/i18n/useStandaloneWorkbenchLocalization'
import {
  buildWorkbenchGitChangeItems,
  buildWorkbenchGitCommitDraft,
} from '../src/renderer/src/models/git/workbenchGitModel'
import type { AppLocale, WorkspaceGitFileStatusEntry } from '../src/shared/contracts'

import { commitAll, createGitService, withRepository } from './helpers/gitRepository'

function translator(locale: AppLocale): WorkbenchI18nContextValue['t'] {
  return (key, params) => translateWorkbenchAppMessage(locale, key, params)
}

function draft(locale: AppLocale, entries: WorkspaceGitFileStatusEntry[]): string {
  return buildWorkbenchGitCommitDraft(buildWorkbenchGitChangeItems(entries), translator(locale))
}

const modified = (file: string): WorkspaceGitFileStatusEntry => ({
  path: file,
  indexStatus: ' ',
  workTreeStatus: 'M',
})
const untracked = (file: string): WorkspaceGitFileStatusEntry => ({
  path: file,
  indexStatus: '?',
  workTreeStatus: '?',
})
const deleted = (file: string): WorkspaceGitFileStatusEntry => ({
  path: file,
  indexStatus: ' ',
  workTreeStatus: 'D',
})

void describe('Workbench Git suggested commit messages', () => {
  void test('the commit panel drafts its placeholder in the interface language', () => {
    const cases: Array<[WorkspaceGitFileStatusEntry[], string, string]> = [
      [[untracked('README.md')], 'Add README.md', '添加 README.md'],
      [[deleted('src/old.ts')], 'Remove old.ts', '删除 old.ts'],
      [[modified('src/app.ts')], 'Update app.ts', '更新 app.ts'],
      [[untracked('a.ts'), untracked('b.ts')], 'Add 2 files', '添加 2 个文件'],
      [[modified('src/a.ts'), untracked('src/b.ts')], 'Update src changes', '更新 src 相关改动'],
      [[modified('src/a.ts'), modified('docs/b.md'), deleted('c.ts')], 'Update 3 files', '更新 3 个文件'],
    ]
    for (const [entries, english, chinese] of cases) {
      assert.equal(draft('en-US', entries), english)
      assert.equal(draft('zh-CN', entries), chinese)
    }
    assert.equal(draft('en-US', []), '')
    // 暂存了一部分的文件两侧各一条：按一个文件算。
    assert.equal(
      draft('en-US', [{ path: 'src/app.ts', indexStatus: 'M', workTreeStatus: 'M' }]),
      'Update app.ts'
    )
  })

  void test('the message Git writes for an empty commit box follows the requested language', async () => {
    await withRepository(async (root) => {
      await mkdir(join(root, 'src'))
      await writeFile(join(root, 'src', 'kept.ts'), 'kept\n')
      await writeFile(join(root, 'src', 'gone.ts'), 'gone\n')
      await commitAll(root, 'base')
      const service = createGitService()
      const both = async (paths?: string[]): Promise<Array<string | null>> => [
        (await service.generateCommitMessage(root, 'en-US', paths)).message,
        (await service.generateCommitMessage(root, 'zh-CN', paths)).message,
      ]

      await writeFile(join(root, 'src', 'kept.ts'), 'kept\nedited\n')
      assert.deepEqual(await both(), ['Update kept.ts', '更新 kept.ts'])
      await writeFile(join(root, 'src', 'gone.ts'), 'gone\nedited\n')
      assert.deepEqual(await both(), ['Update 2 files', '更新 2 个文件'])
      await rm(join(root, 'src', 'gone.ts'))
      assert.deepEqual(await both(['src/gone.ts']), ['Remove gone.ts', '删除 gone.ts'])
      await writeFile(join(root, 'new.ts'), 'new\n')
      assert.deepEqual(await both(['new.ts']), ['Add new.ts', '新增 new.ts'])

      // 没写说明就提交：用的是同一条，按请求的语言。
      const added = await service.commit(root, 'zh-CN', undefined, ['new.ts'])
      assert.equal(added.commit.message, '新增 new.ts')
      const removed = await service.commit(root, 'en-US', undefined, ['src/gone.ts'])
      assert.equal(removed.commit.message, 'Remove gone.ts')
    })
  })

  void test('neither side keeps the wording in code', () => {
    const model = readFileSync(
      path.resolve(process.cwd(), 'src/renderer/src/models/git/workbenchGitModel.ts'),
      'utf8'
    )
    const service = readFileSync(
      path.resolve(process.cwd(), 'src/main/workspace/git/WorkbenchGitService.ts'),
      'utf8'
    )
    const userFacingCode = (source: string): string =>
      source
        .replace(/\/\*[\s\S]*?\*\//gu, '')
        .replace(/^\s*\/\/.*$/gmu, '')
        .replace(/\s\/\/ .*$/gmu, '')
        .replace(/^.*\blog\.(?:debug|info|warn|error)\(.*$/gmu, '')
    // 给用户看的字都在文案表里：代码里（注释、日志之外）不留中文。
    assert.doesNotMatch(userFacingCode(model), /[一-鿿]/u)
    assert.doesNotMatch(userFacingCode(service), /[一-鿿]/u)
  })
})
