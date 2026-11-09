import assert from 'node:assert/strict'
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  unlink,
  utimes,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, test } from 'bun:test'

import { AppError } from '@velaros-ai/velaros/core/error'

import {
  DefaultWorkbenchDeleteUndoLimits,
  type WorkbenchDeleteUndoLimits,
  WorkbenchDeleteUndoStore,
} from '../src/main/workspace/DeleteUndoStore'
import { createWorkbenchAppParts } from '../src/main/workspace/Parts'
import { partitionDeleteResultsByUndo } from '../src/renderer/src/models/files/workbenchTreeMutation'

import { createFakeTrash, type FakeTrash } from './helpers/fakeTrash'

/**
 * 文件树的删除一律进系统废纸篓（测试里是假的废纸篓目录）；小的另留私有副本给 ⌘Z，
 * 大的只能去废纸篓找。
 * 副本不能越攒越多：本会话按总量淘汰，以前会话的在启动时清掉。
 */

interface Sandbox {
  projectRoot: string
  dataRoot: string
  undoRoot: string
  trash: FakeTrash
}

async function withSandbox(run: (sandbox: Sandbox) => Promise<void>): Promise<void> {
  const projectRoot = await realpath(await mkdtemp(join(tmpdir(), 'workbench-trash-project-')))
  const dataRoot = await realpath(await mkdtemp(join(tmpdir(), 'workbench-trash-data-')))
  try {
    await run({
      projectRoot,
      dataRoot,
      undoRoot: join(dataRoot, 'workbench-delete-undo'),
      trash: createFakeTrash(join(dataRoot, 'fake-trash')),
    })
  } finally {
    await rm(projectRoot, { recursive: true, force: true })
    await rm(dataRoot, { recursive: true, force: true })
  }
}

function createStore(sandbox: Sandbox, limits: Partial<WorkbenchDeleteUndoLimits> = {}) {
  return new WorkbenchDeleteUndoStore(() => sandbox.undoRoot, sandbox.trash.moveToTrash, {
    ...DefaultWorkbenchDeleteUndoLimits,
    ...limits,
  })
}

function deletedEntry(sandbox: Sandbox, path: string) {
  return {
    projectRoot: sandbox.projectRoot,
    deletedPath: path,
    parentPath: path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '.',
    entryPath: join(sandbox.projectRoot, path),
  }
}

async function listCopies(undoRoot: string): Promise<string[]> {
  const sessions = await readdir(undoRoot).catch(() => [])
  const copies: string[] = []
  for (const session of sessions) {
    for (const id of await readdir(join(undoRoot, session))) copies.push(`${session}/${id}`)
  }
  return copies
}

void describe('Workbench delete to trash', () => {
  void test('small deletions go to the trash and can still be undone in the app', async () => {
    await withSandbox(async (sandbox) => {
      const { projectRoot } = sandbox
      const parts = createWorkbenchAppParts(sandbox.dataRoot, {
        moveToTrash: sandbox.trash.moveToTrash,
      })
      await mkdir(join(projectRoot, 'src', 'lib'), { recursive: true })
      await writeFile(join(projectRoot, 'src', 'lib', 'util.ts'), 'export {}\n', 'utf8')
      const modifiedAt = new Date('2024-05-01T10:00:00Z')
      await utimes(join(projectRoot, 'src', 'lib', 'util.ts'), modifiedAt, modifiedAt)

      const deleted = await parts.files.deleteEntry({
        projectRoot,
        path: 'src/lib',
        recursive: true,
      })
      assert.deepEqual(sandbox.trash.trashed, [join(projectRoot, 'src', 'lib')])
      assert.equal(deleted.deletedPath, 'src/lib')
      assert.equal(deleted.parentPath, 'src')
      assert.ok(deleted.restoreId)
      await assert.rejects(() => stat(join(projectRoot, 'src', 'lib')), /ENOENT/u)

      const restored = await parts.files.restoreDeletedEntry({
        projectRoot,
        restoreId: deleted.restoreId,
      })
      assert.equal(restored.restoredPath, 'src/lib')
      assert.equal(restored.entry.path, 'src/lib')
      assert.equal(restored.entry.type, 'directory')
      const utilPath = join(projectRoot, 'src', 'lib', 'util.ts')
      assert.equal(await readFile(utilPath, 'utf8'), 'export {}\n')
      assert.equal((await stat(utilPath)).mtimeMs, modifiedAt.getTime())
      // 放回之后副本与记录都清掉了：同一条记录不能再用。
      assert.deepEqual(await listCopies(sandbox.undoRoot), [])
      await assert.rejects(
        () => parts.files.restoreDeletedEntry({ projectRoot, restoreId: deleted.restoreId! }),
        (error: unknown) => error instanceof AppError && error.code === 'NOT_FOUND'
      )
    })
  })

  void test('large deletions only go to the trash and offer no in-app undo', async () => {
    await withSandbox(async (sandbox) => {
      const store = createStore(sandbox, { maxEntryBytes: 1024, maxEntryCount: 5 })
      await writeFile(join(sandbox.projectRoot, 'big.bin'), Buffer.alloc(2048, 1))
      await mkdir(join(sandbox.projectRoot, 'many'))
      for (let index = 0; index < 8; index += 1) {
        await writeFile(join(sandbox.projectRoot, 'many', `f${index}.txt`), 'x', 'utf8')
      }
      await writeFile(join(sandbox.projectRoot, 'small.txt'), 'small', 'utf8')

      assert.equal(await store.trash(deletedEntry(sandbox, 'big.bin')), null)
      assert.equal(await store.trash(deletedEntry(sandbox, 'many')), null)
      assert.ok(await store.trash(deletedEntry(sandbox, 'small.txt')))
      assert.equal(sandbox.trash.trashed.length, 3)
      assert.deepEqual(await readdir(sandbox.projectRoot), [])
      // 大的没有副本；小的那一份在本会话的目录里。
      assert.equal((await listCopies(sandbox.undoRoot)).length, 1)

      const result = { projectRoot: sandbox.projectRoot, parentPath: '.' }
      const { undoable, trashOnly } = partitionDeleteResultsByUndo([
        { ...result, deletedPath: 'big.bin', restoreId: null },
        { ...result, deletedPath: 'small.txt', restoreId: 'id' },
      ])
      assert.deepEqual(
        undoable.map((result) => result.deletedPath),
        ['small.txt']
      )
      assert.deepEqual(
        trashOnly.map((result) => result.deletedPath),
        ['big.bin']
      )
    })
  })

  void test('a failed move to the trash keeps the entry and leaves no copy behind', async () => {
    await withSandbox(async (sandbox) => {
      const store = new WorkbenchDeleteUndoStore(
        () => sandbox.undoRoot,
        async () => {
          throw new Error('Trash is not available on this volume')
        }
      )
      await writeFile(join(sandbox.projectRoot, 'keep.txt'), 'still here', 'utf8')

      await assert.rejects(
        () => store.trash(deletedEntry(sandbox, 'keep.txt')),
        (error: unknown) =>
          error instanceof AppError &&
          /废纸篓/u.test(error.message) &&
          /not available/u.test(error.message)
      )
      assert.equal(await readFile(join(sandbox.projectRoot, 'keep.txt'), 'utf8'), 'still here')
      assert.deepEqual(await listCopies(sandbox.undoRoot), [])
      assert.throws(
        () => new WorkbenchDeleteUndoStore(() => sandbox.undoRoot, undefined as never),
        (error: unknown) => error instanceof AppError && error.code === 'INVARIANT'
      )
    })
  })

  void test('copies are bounded within a session and the oldest undo expires first', async () => {
    await withSandbox(async (sandbox) => {
      const store = createStore(sandbox, { maxRecords: 2 })
      const ids: string[] = []
      for (const name of ['a.txt', 'b.txt', 'c.txt']) {
        await writeFile(join(sandbox.projectRoot, name), name, 'utf8')
        ids.push((await store.trash(deletedEntry(sandbox, name)))!)
      }

      assert.equal(store.find(sandbox.projectRoot, ids[0]!), null)
      assert.ok(store.find(sandbox.projectRoot, ids[1]!))
      assert.ok(store.find(sandbox.projectRoot, ids[2]!))
      // 记录只认自己的工程。
      assert.equal(store.find(join(sandbox.projectRoot, 'other'), ids[2]!), null)
      await new Promise((resolve) => setTimeout(resolve, 20))
      assert.equal((await listCopies(sandbox.undoRoot)).length, 2)

      const byBytes = createStore(sandbox, { maxTotalBytes: 10 })
      await writeFile(join(sandbox.projectRoot, 'd.txt'), '123456', 'utf8')
      await writeFile(join(sandbox.projectRoot, 'e.txt'), '123456', 'utf8')
      const d = (await byBytes.trash(deletedEntry(sandbox, 'd.txt')))!
      const e = (await byBytes.trash(deletedEntry(sandbox, 'e.txt')))!
      assert.equal(byBytes.find(sandbox.projectRoot, d), null)
      assert.ok(byBytes.find(sandbox.projectRoot, e))
    })
  })

  void test('undo never overwrites a new entry at the old path and keeps the copy', async () => {
    await withSandbox(async (sandbox) => {
      const parts = createWorkbenchAppParts(sandbox.dataRoot, {
        moveToTrash: sandbox.trash.moveToTrash,
      })
      const { projectRoot } = sandbox
      await writeFile(join(projectRoot, 'notes.md'), 'old notes', 'utf8')
      const deleted = await parts.files.deleteEntry({ projectRoot, path: 'notes.md' })
      assert.ok(deleted.restoreId)

      await writeFile(join(projectRoot, 'notes.md'), 'new notes', 'utf8')
      await assert.rejects(
        () => parts.files.restoreDeletedEntry({ projectRoot, restoreId: deleted.restoreId! }),
        (error: unknown) => error instanceof AppError && error.code === 'CONFLICT'
      )
      assert.equal(await readFile(join(projectRoot, 'notes.md'), 'utf8'), 'new notes')

      // 挪开冲突的那一个之后还能撤销。
      await rm(join(projectRoot, 'notes.md'))
      await parts.files.restoreDeletedEntry({ projectRoot, restoreId: deleted.restoreId })
      assert.equal(await readFile(join(projectRoot, 'notes.md'), 'utf8'), 'old notes')
    })
  })

  void test('undo rejects an ancestor redirected outside the project and retains the copy for retry', async () => {
    await withSandbox(async (sandbox) => {
      const parts = createWorkbenchAppParts(sandbox.dataRoot, {
        moveToTrash: sandbox.trash.moveToTrash,
      })
      const ancestor = join(sandbox.projectRoot, 'ancestor')
      const originalAncestor = join(sandbox.projectRoot, 'original-ancestor')
      const outside = join(sandbox.dataRoot, 'outside')
      await mkdir(join(ancestor, 'nested'), { recursive: true })
      await mkdir(join(outside, 'nested'), { recursive: true })
      await writeFile(join(ancestor, 'nested', 'notes.md'), 'kept notes', 'utf8')
      const deleted = await parts.files.deleteEntry({
        projectRoot: sandbox.projectRoot,
        path: 'ancestor/nested/notes.md',
      })
      assert.ok(deleted.restoreId)

      await rename(ancestor, originalAncestor)
      await symlink(outside, ancestor, process.platform === 'win32' ? 'junction' : 'dir')
      await assert.rejects(
        parts.files.restoreDeletedEntry({
          projectRoot: sandbox.projectRoot,
          restoreId: deleted.restoreId,
        }),
        (error: unknown) => error instanceof AppError && error.code === 'PERMISSION'
      )
      await assert.rejects(stat(join(outside, 'nested', 'notes.md')), { code: 'ENOENT' })
      assert.equal((await listCopies(sandbox.undoRoot)).length, 1)

      await unlink(ancestor)
      await rename(originalAncestor, ancestor)
      await parts.files.restoreDeletedEntry({
        projectRoot: sandbox.projectRoot,
        restoreId: deleted.restoreId,
      })
      assert.equal(await readFile(join(ancestor, 'nested', 'notes.md'), 'utf8'), 'kept notes')
      assert.deepEqual(await listCopies(sandbox.undoRoot), [])
    })
  })

  void test('copies left by earlier sessions are purged at startup', async () => {
    await withSandbox(async (sandbox) => {
      // 以前会话的目录与旧版的 `<restoreId>/<basename>` 布局都要清掉。
      await mkdir(join(sandbox.undoRoot, 'previous-session', 'record'), { recursive: true })
      await writeFile(join(sandbox.undoRoot, 'previous-session', 'record', 'a.txt'), 'a', 'utf8')
      await mkdir(join(sandbox.undoRoot, 'legacy-restore-id'), { recursive: true })

      const store = createStore(sandbox)
      await writeFile(join(sandbox.projectRoot, 'current.txt'), 'current', 'utf8')
      const id = await store.trash(deletedEntry(sandbox, 'current.txt'))
      assert.ok(id)
      await store.purgePreviousSessions()

      const copies = await listCopies(sandbox.undoRoot)
      assert.equal(copies.length, 1)
      assert.ok(copies[0]!.endsWith(`/${id}`))
      await store.restore(store.find(sandbox.projectRoot, id)!)
      assert.equal(await readFile(join(sandbox.projectRoot, 'current.txt'), 'utf8'), 'current')

      const parts = createWorkbenchAppParts(sandbox.dataRoot, {
        moveToTrash: sandbox.trash.moveToTrash,
      })
      await parts.files.purgePreviousDeleteUndoCopies()
      assert.deepEqual(await readdir(sandbox.undoRoot), [])
    })
  })
})
