import assert from 'node:assert/strict'

import { describe, mock, test } from 'bun:test'

import { WorkbenchDebuggerChannels, type WorkbenchDebuggerEvent } from '../src/shared/workbenchDebugger'
import { WorkbenchTerminalChannels } from '../src/shared/workbenchTerminal'

/**
 * 调试器的 IPC 是 renderer 进来的边界：请求的形状在这里验一次，不合规的整份不收；会话归发请求的那个窗口，
 * 状态变化与程序输出只送回那个窗口。
 */

const ipcHandlers = new Map<string, (...args: unknown[]) => unknown>()

void mock.module('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) => {
      ipcHandlers.set(channel, handler)
    },
    removeHandler: (channel: string) => {
      ipcHandlers.delete(channel)
    },
  },
}))

interface Envelope {
  ok: boolean
  value?: unknown
  message?: string
  code?: string
}

interface RecordedCall {
  method: string
  request: unknown
  ownerId: Nullable<number>
}

interface StartHandlers {
  emit: (event: WorkbenchDebuggerEvent) => void
  terminalOutput: (event: unknown) => void
}

async function registerDebugIpc(): Promise<{
  invoke: (channel: string, request: unknown, senderId?: number) => Promise<Envelope>
  calls: RecordedCall[]
  startHandlers: StartHandlers[]
  sent: Array<{ senderId: number; channel: string; payload: unknown }>
  destroy: (senderId: number) => void
  dispose: () => void
}> {
  const { registerWorkbenchDebugIpc } = await import('../src/main/workspace/debug/WorkbenchDebugIpc')
  const calls: RecordedCall[] = []
  const startHandlers: StartHandlers[] = []
  const record =
    (method: string, result: unknown = undefined) =>
    async (request: unknown, ownerId: Nullable<number>): Promise<unknown> => {
      calls.push({ method, request, ownerId })
      return result
    }

  const dispose = registerWorkbenchDebugIpc({
    startDebugSession: async (request: unknown, handlers: StartHandlers, ownerId: Nullable<number>) => {
      calls.push({ method: 'start', request, ownerId })
      startHandlers.push(handlers)
      return { sessionId: 'debug-1', terminalSessionId: 'terminal-1', command: 'node x', cwd: '/p', shell: 'sh' }
    },
    stopDebugSession: record('stop'),
    controlDebugSession: record('control'),
    setBreakpoints: record('setBreakpoints', { breakpoints: [] }),
    setExceptionPause: record('setExceptionPause'),
    getVariables: record('variables', { variables: [], truncated: false }),
    evaluate: record('evaluate', { value: null, error: 'x' }),
  } as never)

  const sent: Array<{ senderId: number; channel: string; payload: unknown }> = []
  const destroyed = new Set<number>()
  return {
    invoke: async (channel, request, senderId = 7) => {
      const handler = ipcHandlers.get(channel)
      assert.ok(handler, `no handler for ${channel}`)
      const sender = {
        id: senderId,
        isDestroyed: () => destroyed.has(senderId),
        send: (sentChannel: string, payload: unknown) => sent.push({ senderId, channel: sentChannel, payload }),
      }
      return (await handler({ sender }, request)) as Envelope
    },
    calls,
    startHandlers,
    sent,
    destroy: (senderId) => destroyed.add(senderId),
    dispose,
  }
}

const Channels = WorkbenchDebuggerChannels

void describe('Workbench debugger IPC', () => {
  void test('starts a session for the requesting window and sends its events and output only there', async () => {
    const ipc = await registerDebugIpc()

    const started = await ipc.invoke(Channels.start, {
      projectRoot: '/p',
      target: { kind: 'node-script', script: 'src/main.js', args: '--port 1' },
      cwd: 'packages/api',
      env: { PORT: '4100' },
      breakpoints: [{ path: 'src/main.js', line: 3, condition: 'dropped' }],
      pauseOnUncaughtExceptions: true,
      cols: 120,
      rows: 30,
      unknownField: 'dropped',
    })
    assert.deepEqual(started, {
      ok: true,
      value: { sessionId: 'debug-1', terminalSessionId: 'terminal-1', command: 'node x', cwd: '/p', shell: 'sh' },
    })
    // 只有认识的字段进得去。
    assert.deepEqual(ipc.calls, [
      {
        method: 'start',
        ownerId: 7,
        request: {
          projectRoot: '/p',
          target: { kind: 'node-script', script: 'src/main.js', args: '--port 1' },
          cwd: 'packages/api',
          env: { PORT: '4100' },
          breakpoints: [{ path: 'src/main.js', line: 3 }],
          pauseOnUncaughtExceptions: true,
          cols: 120,
          rows: 30,
        },
      },
    ])

    const handlers = ipc.startHandlers[0]!
    handlers.emit({ type: 'attached', sessionId: 'debug-1' })
    handlers.terminalOutput({ sessionId: 'terminal-1', stream: 'stdout', chunk: 'hello' })
    assert.deepEqual(ipc.sent, [
      { senderId: 7, channel: Channels.event, payload: { type: 'attached', sessionId: 'debug-1' } },
      { senderId: 7, channel: WorkbenchTerminalChannels.output, payload: { sessionId: 'terminal-1', stream: 'stdout', chunk: 'hello' } },
    ])
    // 窗口已经关了：不再往里送。
    ipc.destroy(7)
    handlers.emit({ type: 'resumed', sessionId: 'debug-1' })
    handlers.terminalOutput({ sessionId: 'terminal-1', stream: 'stdout', chunk: 'late' })
    assert.equal(ipc.sent.length, 2)

    // 另外两种起法；没给的可选项就是没有。
    ipc.calls.length = 0
    for (const target of [
      { kind: 'node-package-bin', packageName: 'jest', binName: 'jest', args: '--runInBand' },
      { kind: 'node-package-bin', packageName: 'jest', argv: [] },
      { kind: 'node-script', script: 'src/main.js', argv: ['', 'two words', '$HOME; literal'] },
      { kind: 'node-script', script: 'src/main.js', args: '  --name "$LABEL"  ' },
      { kind: 'inspect-process', process: { kind: 'package-manager', program: 'pnpm', argv: ['exec', 'vitest', 'run', 'a b.test.ts'] } },
      { kind: 'inspect-command', command: 'npx vitest run a.test.ts' },
    ]) {
      assert.equal((await ipc.invoke(Channels.start, { projectRoot: '/p', target, breakpoints: [] }, 9)).ok, true)
    }
    assert.deepEqual(
      ipc.calls.map((call) => [call.ownerId, call.request]),
      [
        { kind: 'node-package-bin', packageName: 'jest', binName: 'jest', args: '--runInBand' },
        { kind: 'node-package-bin', packageName: 'jest', argv: [] },
        { kind: 'node-script', script: 'src/main.js', argv: ['', 'two words', '$HOME; literal'] },
        { kind: 'node-script', script: 'src/main.js', args: '  --name "$LABEL"  ' },
        { kind: 'inspect-process', process: { kind: 'package-manager', program: 'pnpm', argv: ['exec', 'vitest', 'run', 'a b.test.ts'] } },
        { kind: 'inspect-command', command: 'npx vitest run a.test.ts' },
      ].map((target) => [9, { projectRoot: '/p', target, breakpoints: [], pauseOnUncaughtExceptions: false }])
    )
    ipc.dispose()
  })

  void test('rejects a start request that is not well formed, without starting anything', async () => {
    const ipc = await registerDebugIpc()
    const valid = {
      projectRoot: '/p',
      target: { kind: 'node-script', script: 'main.js', argv: [] },
      breakpoints: [{ path: 'main.js', line: 1 }],
    }
    const invalidRequests: unknown[] = [
      null,
      'text',
      { ...valid, projectRoot: 7 },
      { ...valid, target: undefined },
      { ...valid, target: { kind: 'python-script', script: 'main.py' } },
      { ...valid, target: { kind: 'node-script' } },
      { ...valid, target: { kind: 'node-script', script: 'main.js' } },
      { ...valid, target: { kind: 'node-script', script: 'main.js', argv: [], extra: 'rejected' } },
      { ...valid, target: { kind: 'node-script', script: 'main.js', argv: [], args: '' } },
      { ...valid, target: { kind: 'node-script', script: 'main.js', argv: '--flag' } },
      { ...valid, target: { kind: 'node-script', script: 'main.js', argv: [1] } },
      { ...valid, target: { kind: 'node-script', script: 'main.js', argv: ['bad\0argument'] } },
      { ...valid, target: { kind: 'node-script', script: 'main\0.js', argv: [] } },
      { ...valid, target: { kind: 'node-script', script: 'main.js', args: 'bad\0argument' } },
      { ...valid, target: { kind: 'node-package-bin', packageName: 7 } },
      { ...valid, target: { kind: 'node-package-bin', packageName: 'jest', argv: [], args: '' } },
      { ...valid, target: { kind: 'node-package-bin', packageName: 'jest\0', argv: [] } },
      { ...valid, target: { kind: 'node-package-bin', packageName: 'jest', binName: 'jest\0', argv: [] } },
      { ...valid, target: { kind: 'inspect-command' } },
      { ...valid, target: { kind: 'inspect-command', command: 'node\0bad' } },
      { ...valid, target: { kind: 'inspect-process', process: { kind: 'node-script', script: 'main.js', argv: [] } } },
      { ...valid, target: { kind: 'inspect-process', process: { kind: 'package-manager', program: 'unknown', argv: [] } } },
      { ...valid, target: { kind: 'inspect-process', process: { kind: 'package-manager', program: 'pnpm', argv: ['bad\0'] } } },
      { ...valid, breakpoints: undefined },
      { ...valid, breakpoints: [{ path: 'main.js', line: 0 }] },
      { ...valid, breakpoints: [{ path: 'main.js', line: 1.5 }] },
      { ...valid, breakpoints: [{ path: 'main.js', line: '3' }] },
      { ...valid, breakpoints: [{ line: 3 }] },
      { ...valid, breakpoints: Array.from({ length: 2001 }, (_item, index) => ({ path: 'main.js', line: index + 1 })) },
      // 环境变量有一项不合规就整份拒绝（与运行卡同一条规矩）。
      { ...valid, env: { 'BAD NAME': '1' } },
      { ...valid, env: { PORT: 4100 } },
      { ...valid, env: 'PORT=4100' },
    ]
    for (const request of invalidRequests) {
      const result = await ipc.invoke(Channels.start, request)
      assert.deepEqual([result.ok, result.code], [false, 'VALIDATION'], JSON.stringify(request)?.slice(0, 120))
    }
    assert.deepEqual(ipc.calls, [])

    // 2000 个断点以内、空的环境变量表都收。
    assert.equal((await ipc.invoke(Channels.start, { ...valid, env: {} })).ok, true)
    assert.deepEqual(ipc.calls[0]?.request, { ...valid, pauseOnUncaughtExceptions: false })
    ipc.dispose()
  })

  void test('passes session commands on with the id of the requesting window', async () => {
    const ipc = await registerDebugIpc()

    assert.equal((await ipc.invoke(Channels.control, { sessionId: 's', action: 'step-over' })).ok, true)
    assert.equal((await ipc.invoke(Channels.stop, { sessionId: 's' }, 8)).ok, true)
    assert.deepEqual(
      await ipc.invoke(Channels.setBreakpoints, { sessionId: 's', breakpoints: [{ path: 'a.ts', line: 2 }] }),
      { ok: true, value: { breakpoints: [] } }
    )
    assert.equal((await ipc.invoke(Channels.setExceptionPause, { sessionId: 's', uncaught: true })).ok, true)
    assert.deepEqual(await ipc.invoke(Channels.variables, { sessionId: 's', objectId: 'o' }), {
      ok: true,
      value: { variables: [], truncated: false },
    })
    assert.equal(
      (await ipc.invoke(Channels.evaluate, { sessionId: 's', expression: 'a + 1', frameId: 'f', sideEffectFree: true })).ok,
      true
    )
    assert.equal((await ipc.invoke(Channels.evaluate, { sessionId: 's', expression: 'a' })).ok, true)
    assert.deepEqual(ipc.calls, [
      { method: 'control', ownerId: 7, request: { sessionId: 's', action: 'step-over' } },
      { method: 'stop', ownerId: 8, request: { sessionId: 's' } },
      { method: 'setBreakpoints', ownerId: 7, request: { sessionId: 's', breakpoints: [{ path: 'a.ts', line: 2 }] } },
      { method: 'setExceptionPause', ownerId: 7, request: { sessionId: 's', uncaught: true } },
      { method: 'variables', ownerId: 7, request: { sessionId: 's', objectId: 'o' } },
      {
        method: 'evaluate',
        ownerId: 7,
        request: { sessionId: 's', expression: 'a + 1', frameId: 'f', sideEffectFree: true },
      },
      { method: 'evaluate', ownerId: 7, request: { sessionId: 's', expression: 'a', sideEffectFree: false } },
    ])

    ipc.calls.length = 0
    const invalid: Array<[string, unknown]> = [
      [Channels.control, { sessionId: 's', action: 'restart' }],
      [Channels.control, { sessionId: 's' }],
      [Channels.control, { action: 'continue' }],
      [Channels.stop, {}],
      [Channels.setBreakpoints, { sessionId: 's' }],
      [Channels.setBreakpoints, { sessionId: 's', breakpoints: [{ path: 'a.ts', line: -1 }] }],
      [Channels.setExceptionPause, { sessionId: 's', uncaught: 'yes' }],
      [Channels.variables, { sessionId: 's' }],
      [Channels.evaluate, { sessionId: 's', expression: '   ' }],
      [Channels.evaluate, { sessionId: 's', expression: 'x'.repeat(10_001) }],
      [Channels.evaluate, { sessionId: 's' }],
    ]
    for (const [channel, request] of invalid) {
      const result = await ipc.invoke(channel, request)
      assert.deepEqual([result.ok, result.code], [false, 'VALIDATION'], `${channel} ${JSON.stringify(request).slice(0, 80)}`)
    }
    assert.deepEqual(ipc.calls, [])

    // 注销之后这些通道不再有人接。
    ipc.dispose()
    for (const channel of Object.values(Channels)) assert.equal(ipcHandlers.has(channel), false)
  })
})
