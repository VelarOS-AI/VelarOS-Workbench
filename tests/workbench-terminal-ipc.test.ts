import assert from 'node:assert/strict'

import { describe, mock, test } from 'bun:test'

import { AppError } from '@velaros-ai/velaros/core/error'

import { type WorkbenchTerminalStartRequest } from '../src/shared/contracts/workbench'
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

async function registerTerminalIpc(retiring = false): Promise<{
  start: (request: unknown) => Promise<Envelope>
  started: Array<{ request: WorkbenchTerminalStartRequest; ownerId: Nullable<number> }>
  admissions: Array<{ ownerId: number; projectRoot: string }>
}> {
  const { registerWorkbenchTerminalIpc } = await import(
    '../src/main/workspace/terminal/WorkbenchTerminalIpc'
  )
  const started: Array<{ request: WorkbenchTerminalStartRequest; ownerId: Nullable<number> }> = []
  const admissions: Array<{ ownerId: number; projectRoot: string }> = []
  registerWorkbenchTerminalIpc({
    startTerminalSession: async (
      request: WorkbenchTerminalStartRequest,
      _onOutput: unknown,
      ownerId: Nullable<number>
    ) => {
      assert.deepEqual(admissions.at(-1), { ownerId, projectRoot: request.projectRoot })
      started.push({ request, ownerId })
      return { sessionId: 'terminal-1', projectRoot: request.projectRoot, cwd: '/p', shell: 'sh', startedAt: 1 }
    },
  } as never, {
    assertProjectForWebContents: (sender, projectRoot) => {
      admissions.push({ ownerId: sender.id, projectRoot })
      if (sender.id !== 7 || projectRoot !== '/p')
        throw new AppError('PERMISSION', 'Project does not belong to this window')
      if (retiring) throw new AppError('CANCELLED', 'Project is retiring')
    },
  })
  const handler = ipcHandlers.get(WorkbenchTerminalChannels.start)
  assert.ok(handler)
  const sender = { id: 7, isDestroyed: () => false, send: () => undefined }
  return { start: async (request) => (await handler({ sender }, request)) as Envelope, started, admissions }
}

void describe('Workbench terminal IPC', () => {
  void test('rejects a retiring project before starting its terminal', async () => {
    const { start, started, admissions } = await registerTerminalIpc(true)
    const result = await start({ projectRoot: '/p', initialCommand: 'bun run dev' })
    assert.deepEqual([result.ok, result.code], [false, 'CANCELLED'])
    assert.deepEqual(admissions, [{ ownerId: 7, projectRoot: '/p' }])
    assert.deepEqual(started, [])
  })

  void test('preserves literal process arguments and the selected manager entry', async () => {
    const { start, started } = await registerTerminalIpc()
    const argv = ['', 'src/100%.test.ts', '$HOME $(unchanged)', '`literal`', 'a"b', 'tail\\']
    for (const initialProcess of [
      { kind: 'node-script', script: 'src/main.js', argv },
      { kind: 'python-script', script: 'script.py', argv },
      { kind: 'package-manager', program: 'npx', argv: ['tsx', 'file.ts'] },
      { kind: 'package-manager', program: 'npx', argv: ['--no-install', 'vitest', ...argv] },
      { kind: 'node-script', script: 'src/main.js', args: ' "$VALUE" | cat ' },
    ]) {
      assert.equal((await start({ projectRoot: '/p', initialProcess })).ok, true)
      assert.deepEqual(started.at(-1)?.request.initialProcess, initialProcess)
      assert.equal(started.at(-1)?.request.initialCommand, undefined)
    }
  })

  void test('rejects ambiguous or malformed process inputs without starting a shell', async () => {
    const { start, started } = await registerTerminalIpc()
    const process = { kind: 'node-script', script: 'main.js', argv: [] }
    for (const request of [
      { initialProcess: process, initialCommand: '' },
      { initialProcess: process, initialCommand: 'node main.js' },
      { initialProcess: null },
      { initialProcess: { ...process, args: '' } },
      { initialProcess: { ...process, argv: ['nul\0byte'] } },
      { initialProcess: { ...process, argv: [1] } },
      { initialProcess: { kind: 'node-script', script: 'main.js' } },
      { initialProcess: { kind: 'package-manager', program: 'unknown', argv: [] } },
    ]) {
      const result = await start({ projectRoot: '/p', ...request })
      assert.equal(result.ok, false)
      assert.equal(result.code, 'VALIDATION')
    }
    assert.deepEqual(started, [])
  })

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
