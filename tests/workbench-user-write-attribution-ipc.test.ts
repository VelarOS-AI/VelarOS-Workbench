import assert from 'node:assert/strict'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, mock, test } from 'bun:test'

import { WorkbenchFsChannels } from '../src/shared/workbenchFs'
import { WorkbenchWorkspaceChannels } from '../src/shared/workbenchWorkspace'

/**
 * 用户在 Workbench 里亲手做的写入（编辑器保存、文件树操作、应用 / 撤销一处改动）要报给改动归属账本：
 * 正在跑的那一轮不能把它们算成 Agent 的改动，回溯时也不能替用户撤掉。只报写成功的。
 */

const ipcHandlers = new Map<string, (...args: unknown[]) => unknown>()
const ipcListeners = new Map<string, (...args: unknown[]) => unknown>()

mock.module('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) => {
      ipcHandlers.set(channel, handler)
    },
    on: (channel: string, listener: (...args: unknown[]) => unknown) => {
      ipcListeners.set(channel, listener)
    },
    removeHandler: (channel: string) => {
      ipcHandlers.delete(channel)
    },
  },
}))

interface RecordedWrite {
  workspaceRoot: string
  paths: readonly string[]
}

function createSink() {
  const writes: RecordedWrite[] = []
  return { writes, sink: { recordUserWrites: (request: RecordedWrite) => void writes.push(request) } }
}

async function invoke(channel: string, request: unknown): Promise<{ ok: boolean; value?: unknown }> {
  const handler = ipcHandlers.get(channel)
  assert.ok(handler, channel)
  return (await handler({ sender: { isDestroyed: () => false, send: () => undefined } }, request)) as {
    ok: boolean
    value?: unknown
  }
}

void describe('user writes reported to the run attribution', () => {
  void test('editor saves and file tree operations report the paths they changed, failed ones nothing', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'workbench-user-writes-')))
    const data = await mkdtemp(join(tmpdir(), 'workbench-user-writes-data-'))
    try {
      await mkdir(join(root, 'src'))
      await writeFile(join(root, 'src', 'a.ts'), 'before\n', 'utf8')
      const { registerWorkbenchFsIpc } = await import('../src/main/workspace/WorkbenchFsIpc')
      const { createWorkbenchAppParts } = await import('../src/main/workspace/Parts')
      const { writes, sink } = createSink()
      registerWorkbenchFsIpc({} as never, createWorkbenchAppParts(data), {} as never, sink)

      assert.equal((await invoke(WorkbenchFsChannels.saveFile, {
        projectRoot: root,
        path: 'src/a.ts',
        content: 'saved in the editor\n',
      })).ok, true)
      const syncEvent: { returnValue?: { ok: boolean } } = {}
      ipcListeners.get(WorkbenchFsChannels.saveFileSync)?.(syncEvent, {
        projectRoot: root,
        path: 'src/a.ts',
        content: 'saved before closing\n',
      })
      assert.equal(syncEvent.returnValue?.ok, true)
      assert.equal((await invoke(WorkbenchFsChannels.createEntry, {
        projectRoot: root,
        parentPath: 'src',
        name: 'b.ts',
        type: 'file',
      })).ok, true)
      assert.equal((await invoke(WorkbenchFsChannels.renameEntry, {
        projectRoot: root,
        path: 'src/b.ts',
        newName: 'c.ts',
      })).ok, true)
      assert.equal((await invoke(WorkbenchFsChannels.deleteEntry, {
        projectRoot: root,
        path: 'src/c.ts',
      })).ok, true)
      // 保存被拒（文件在磁盘上已经变了）：什么都没写，也就不报。
      assert.equal((await invoke(WorkbenchFsChannels.saveFile, {
        projectRoot: root,
        path: 'src/a.ts',
        content: 'stale\n',
        expectedModifiedAt: 1,
        expectedSize: 1,
      })).ok, false)

      assert.deepEqual(writes, [
        { workspaceRoot: root, paths: ['src/a.ts'] },
        { workspaceRoot: root, paths: ['src/a.ts'] },
        { workspaceRoot: root, paths: ['src/b.ts'] },
        { workspaceRoot: root, paths: ['src/b.ts', 'src/c.ts'] },
        { workspaceRoot: root, paths: ['src/c.ts'] },
      ])
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(data, { recursive: true, force: true })
    }
  })

  void test('applying or undoing a change from the UI reports its files; reads report nothing', async () => {
    const { registerWorkbenchWorkspaceIpc } = await import('../src/main/workspace/WorkbenchWorkspaceIpc')
    const { writes, sink } = createSink()
    const dispose = registerWorkbenchWorkspaceIpc(
      {
        invoke: async (request: { operation: string }) =>
          request.operation === 'project:read' ? { files: [] } : { changedFiles: ['src/a.ts', 'src/b.ts'] },
        resolveProject: async () => {
          throw new Error('unused')
        },
        dispose: async () => undefined,
      } as never,
      sink
    )
    try {
      for (const operation of ['project:apply-edit', 'project:rollback', 'project:read']) {
        const result = await invoke(WorkbenchWorkspaceChannels.invoke, {
          projectRoot: '/work/app',
          operation,
          input: {},
        })
        assert.equal(result.ok, true)
      }
      assert.deepEqual(writes, [
        { workspaceRoot: '/work/app', paths: ['src/a.ts', 'src/b.ts'] },
        { workspaceRoot: '/work/app', paths: ['src/a.ts', 'src/b.ts'] },
      ])
    } finally {
      dispose()
    }
  })
})
