import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import path, { join } from 'node:path'

import { describe, test } from 'bun:test'

import { translateWorkbenchAppMessage } from '../src/renderer/src/i18n/useStandaloneWorkbenchLocalization'
import { resolveWorkbenchGitHistoryFormerPath } from '../src/renderer/src/models/git/workbenchGitFileHistory'

import { commitAll, createGitService, git, withRepository } from './helpers/gitRepository'

function readSource(relativePath: string): string {
  return readFileSync(path.resolve(process.cwd(), relativePath), 'utf8')
}

void describe('Workbench Git file history', () => {
  void test('commits from before a rename or a move say which path the file had then', async () => {
    await withRepository(async (root) => {
      await mkdir(join(root, 'src'))
      await writeFile(join(root, 'src', '旧名.ts'), 'v1\n')
      await commitAll(root, 'create')
      await git(root, ['mv', 'src/旧名.ts', 'src/renamed.ts'])
      await commitAll(root, 'rename')
      await mkdir(join(root, 'lib'))
      await git(root, ['mv', 'src/renamed.ts', 'lib/renamed.ts'])
      await commitAll(root, 'move')
      await writeFile(join(root, 'lib', 'renamed.ts'), 'v2\n')
      await commitAll(root, 'edit')

      const log = await createGitService().getLog(root, { path: 'lib/renamed.ts' })
      assert.deepEqual(
        log.commits.map((commit) => [
          commit.subject,
          resolveWorkbenchGitHistoryFormerPath(commit, 'lib/renamed.ts'),
        ]),
        [
          ['edit', null],
          ['move', null],
          ['rename', 'src/renamed.ts'],
          ['create', 'src/旧名.ts'],
        ]
      )
    })
  })

  void test('the history list writes the former path on those commits', () => {
    const hook = readSource('src/renderer/src/hooks/useWorkbenchFileHistory.ts')
    const view = readSource('src/renderer/src/components/editor/FileHistoryView.tsx')

    assert.match(hook, /formerPath: toOptional\(resolveWorkbenchGitHistoryFormerPath\(commit, path\)\)/u)
    assert.match(view, /t\('workbench\.fileHistoryFormerPath', \{ path: record\.formerPath \}\)/u)
    assert.match(view, /<HistoryTimeline\s+items=\{timelineItems\}/u)
    assert.equal(
      translateWorkbenchAppMessage('en-US', 'workbench.fileHistoryFormerPath', { path: 'src/old.ts' }),
      'was src/old.ts'
    )
    assert.equal(
      translateWorkbenchAppMessage('zh-CN', 'workbench.fileHistoryFormerPath', { path: 'src/old.ts' }),
      '当时是 src/old.ts'
    )
  })
})
