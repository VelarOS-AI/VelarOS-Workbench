import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, test } from 'bun:test'

import { AppError } from '@velaros-ai/core/error'

import { createWorkbenchAppParts } from '../src/main/workspace/Parts'
import {
  describeTreeMutationFailures,
  runTreeMutationPerEntry,
  selectDeleteUndoResultsToKeep,
  type WorkbenchUndoableDeleteResult,
} from '../src/renderer/src/models/files/workbenchTreeMutation'

import { createFakeTrash } from './helpers/fakeTrash'

/**
 * 多项移动 / 删除 / 撤销：一项没成不挡住其余的；做成了的照常更新（标签、撤销栈），没成的报出来，
 * 撤销没放回去的留在撤销栈里。
 */

function readSource(relativePath: string): string {
  return readFileSync(relativePath, 'utf8')
}

const translate = (key: string, params: Record<string, string | number> = {}): string => {
  const templates: Record<string, string> = {
    'workbench.treeMutationFailureItem': '{path}: {message}',
    'workbench.treeMutationFailureSeparator': '; ',
    'workbench.treeMutationMoreFailures': 'and {count} more',
  }
  return (templates[key] ?? key).replace(/\{(\w+)\}/gu, (_match, name: string) =>
    String(params[name])
  )
}

function undoable(deletedPath: string, restoreId: string): WorkbenchUndoableDeleteResult {
  return { projectRoot: '/project', parentPath: '.', deletedPath, restoreId }
}

void describe('Workbench tree partial failures', () => {
  void test('each entry runs on its own, one after another; failures are collected', async () => {
    const started: string[] = []
    let running = 0
    const outcome = await runTreeMutationPerEntry(
      ['a.ts', 'b.ts', 'c.ts'],
      (path) => path,
      async (path) => {
        assert.equal(running, 0)
        running += 1
        started.push(path)
        await new Promise((resolve) => setTimeout(resolve, 5))
        running -= 1
        if (path === 'b.ts') throw new AppError('CONFLICT', '目标已存在。')
        return `moved ${path}`
      }
    )

    assert.deepEqual(started, ['a.ts', 'b.ts', 'c.ts'])
    assert.deepEqual(
      outcome.succeeded.map(({ item, result }) => [item, result]),
      [
        ['a.ts', 'moved a.ts'],
        ['c.ts', 'moved c.ts'],
      ]
    )
    assert.deepEqual(outcome.failed, [
      { item: 'b.ts', failure: { path: 'b.ts', code: 'CONFLICT', message: '目标已存在。' } },
    ])
  })

  void test('failures are listed with their reasons, the rest only counted', () => {
    const failures = ['a', 'b', 'c', 'd', 'e'].map((name) => ({
      path: `src/${name}.ts`,
      code: 'CONFLICT',
      message: '目标已存在。',
    }))
    assert.equal(
      describeTreeMutationFailures(failures.slice(0, 1), translate),
      'src/a.ts: 目标已存在'
    )
    assert.equal(
      describeTreeMutationFailures(failures, translate),
      'src/a.ts: 目标已存在; src/b.ts: 目标已存在; src/c.ts: 目标已存在; and 2 more'
    )
  })

  void test('undo keeps what it could not put back unless the record has expired', () => {
    const batch = [undoable('a.ts', 'a'), undoable('b.ts', 'b'), undoable('c.ts', 'c')]
    const failed = [
      { item: batch[2]!, failure: { path: 'c.ts', code: 'CONFLICT', message: 'exists' } },
      { item: batch[0]!, failure: { path: 'a.ts', code: 'NOT_FOUND', message: 'expired' } },
    ]
    assert.deepEqual(selectDeleteUndoResultsToKeep(batch, failed), [batch[2]])
    assert.deepEqual(selectDeleteUndoResultsToKeep(batch, []), [])
  })

  void test('a colliding entry does not stop the rest of a multi-item move', async () => {
    const projectRoot = await realpath(await mkdtemp(join(tmpdir(), 'workbench-partial-move-')))
    const dataRoot = await mkdtemp(join(tmpdir(), 'workbench-partial-move-data-'))
    const trash = createFakeTrash(join(dataRoot, 'fake-trash'))
    const parts = createWorkbenchAppParts(dataRoot, { moveToTrash: trash.moveToTrash })
    try {
      await mkdir(join(projectRoot, 'src'))
      await mkdir(join(projectRoot, 'lib'))
      for (const name of ['a.ts', 'b.ts', 'c.ts']) {
        await writeFile(join(projectRoot, 'src', name), name, 'utf8')
      }
      await writeFile(join(projectRoot, 'lib', 'b.ts'), 'already here', 'utf8')

      const moved = await runTreeMutationPerEntry(
        ['src/a.ts', 'src/b.ts', 'src/c.ts'],
        (path) => path,
        (path) => parts.files.moveEntry({ projectRoot, path, parentPath: 'lib' })
      )
      assert.deepEqual(
        moved.succeeded.map(({ result }) => [result.previousPath, result.entry.path]),
        [
          ['src/a.ts', 'lib/a.ts'],
          ['src/c.ts', 'lib/c.ts'],
        ]
      )
      assert.deepEqual(moved.failed.map(({ failure }) => failure.path), ['src/b.ts'])
      assert.deepEqual((await readdir(join(projectRoot, 'src'))).sort(), ['b.ts'])

      // 删两项，其中一项的原处又有了同名文件：另一项照样放回，冲突的那项留着以后再撤销。
      const deleted = await runTreeMutationPerEntry(
        ['lib/a.ts', 'lib/c.ts'],
        (path) => path,
        (path) => parts.files.deleteEntry({ projectRoot, path })
      )
      const batch = deleted.succeeded.map(({ result }) => ({
        ...result,
        restoreId: result.restoreId!,
      }))
      await writeFile(join(projectRoot, 'lib', 'c.ts'), 'recreated', 'utf8')
      const restored = await runTreeMutationPerEntry(
        [...batch].reverse(),
        (result) => result.deletedPath,
        (result) => parts.files.restoreDeletedEntry({ projectRoot, restoreId: result.restoreId })
      )
      assert.deepEqual(restored.succeeded.map(({ result }) => result.restoredPath), ['lib/a.ts'])
      assert.deepEqual(restored.failed.map(({ failure }) => failure.code), ['CONFLICT'])
      assert.deepEqual(
        selectDeleteUndoResultsToKeep(batch, restored.failed).map((result) => result.deletedPath),
        ['lib/c.ts']
      )
    } finally {
      await rm(projectRoot, { recursive: true, force: true })
      await rm(dataRoot, { recursive: true, force: true })
    }
  })

  void test('the tree controller handles every entry and keeps undo for what was deleted', () => {
    const controller = readSource('src/renderer/src/hooks/useWorkbenchMutationController.ts')
    // 移动、检查、删除、撤销都一项一项地做，没有一项失败就整批放弃的 Result.unwrap 循环。
    assert.equal(controller.match(/await runTreeMutationPerEntry\(/gu)?.length, 4)
    assert.doesNotMatch(controller, /for \(const [^)]+\) \{\n\s+const \w+ = Result\.unwrap\(/u)
    // 删掉了的先进撤销栈，再看项目有没有切走。
    const rememberThenCheckProject = new RegExp(
      String.raw`rememberDeletedEntries\(owningProject, undoable\)\n\n\s+` +
        String.raw`if \(activeProjectRef\.current\?\.id !== owningProjectId\) return`,
      'u'
    )
    assert.match(controller, rememberThenCheckProject)
    // 撤销没放回去的重新进撤销栈。
    assert.match(
      controller,
      /rememberDeletedEntries\(\s*owningProject,\s*selectDeleteUndoResultsToKeep\(batch\.results/u
    )
  })
})
