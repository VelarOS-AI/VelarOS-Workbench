import assert from 'node:assert/strict'

import { describe, mock, test } from 'bun:test'

import type { WorkbenchTerminalStartRequest } from '../src/shared/contracts'
import { WorkbenchTerminalChannels } from '../src/shared/workbenchTerminal'

/**
 * 终端的 start 通道是 renderer 进来的边界：运行配置的环境变量在这里再校验一遍，有一项不对整份请求都不收
 * （悄悄丢掉一个变量，程序会带着错的配置跑起来）。
 */

const ipcHandlers = new Map<string, (...args: unknown[]) => unknown>()

void mock.module('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) => {
      ipcHandlers.set(channel, handler)
    },
    on: () => undefined,
  },
}))

interface Envelope {
  ok: boolean
  message?: string
  code?: string
}

async function registerTerminalIpc(): Promise<{
  start: (request: unknown) => Promise<Envelope>
  started: Array<{ request: WorkbenchTerminalStartRequest; ownerId: Nullable<number> }>
}> {
  const { registerWorkbenchTerminalIpc } = await import(
    '../src/main/workspace/terminal/WorkbenchTerminalIpc'
  )
  const started: Array<{ request: WorkbenchTerminalStartRequest; ownerId: Nullable<number> }> = []
  registerWorkbenchTerminalIpc({
    startTerminalSession: async (
      request: WorkbenchTerminalStartRequest,
      _onOutput: unknown,
      ownerId: Nullable<number>
    ) => {
      started.push({ request, ownerId })
      return { sessionId: 'terminal-1', projectRoot: request.projectRoot, cwd: '/p', shell: 'sh', startedAt: 1 }
    },
  } as never)
  const handler = ipcHandlers.get(WorkbenchTerminalChannels.start)
  assert.ok(handler)
  const sender = { id: 7, isDestroyed: () => false, send: () => undefined }
  return { start: async (request) => (await handler({ sender }, request)) as Envelope, started }
}

void describe('Workbench terminal IPC', () => {
  void test('passes the working directory and variables of a run configuration to the session', async () => {
    const { start, started } = await registerTerminalIpc()

    assert.equal(
      (
        await start({
          projectRoot: '/p',
          initialCommand: 'bun run dev',
          cwd: 'packages/api',
          env: { PORT: '4100', EMPTY: '' },
          unknownField: 'ignored',
        })
      ).ok,
      true
    )
    assert.equal((await start({ projectRoot: '/p', env: {} })).ok, true)
    assert.equal((await start({ projectRoot: '/p' })).ok, true)

    assert.deepEqual(started, [
      {
        request: {
          projectRoot: '/p',
          initialCommand: 'bun run dev',
          cwd: 'packages/api',
          env: { PORT: '4100', EMPTY: '' },
        },
        ownerId: 7,
      },
      { request: { projectRoot: '/p' }, ownerId: 7 },
      { request: { projectRoot: '/p' }, ownerId: 7 },
    ])
  })

  void test('refuses a start request whose variables are not plain named strings', async () => {
    const { start, started } = await registerTerminalIpc()

    for (const env of [
      'PORT=4100',
      ['PORT=4100'],
      { PORT: 4100 },
      { 'NOT A NAME': '1' },
      { 'A=B': '1' },
      { A: 'nul\0byte' },
    ]) {
      const result = await start({ projectRoot: '/p', initialCommand: 'ls', env })
      assert.equal(result.ok, false)
      assert.equal(result.code, 'VALIDATION')
    }
    assert.deepEqual(started, [])
  })
})
