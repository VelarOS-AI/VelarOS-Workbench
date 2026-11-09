import assert from 'node:assert/strict'

import { describe, test } from 'bun:test'

import {
  getWorkbenchDebugStatus,
  installWorkbenchDebugActionRunner,
  isWorkbenchDebugActionAvailable,
  publishWorkbenchDebugStatus,
  runWorkbenchDebugAction,
  subscribeWorkbenchDebugStatus,
  type WorkbenchDebugStatus,
} from '../src/renderer/src/models/debug/workbenchDebugBridge'
import {
  readWorkbenchDebugPausedLine,
  workbenchBreakpointKey,
  WorkbenchDebugSessionController,
} from '../src/renderer/src/models/debug/workbenchDebugSession'
import type {
  WorkbenchDebuggerBreakpoint,
  WorkbenchDebuggerBridge,
  WorkbenchDebuggerEvent,
  WorkbenchDebuggerFrame,
  WorkbenchDebuggerStartRequest,
} from '../src/shared/workbenchDebugger'

/**
 * 界面这一侧的调试会话：主进程那头换成假的桥，看它怎么起调试、怎么把推来的事件变成面板和编辑器要的状态、
 * 怎么把断点的变化同步过去。
 */

const Root = '/projects/shop'

function frame(
  id: string,
  functionName: string,
  path: Nullable<string>,
  line: number
): WorkbenchDebuggerFrame {
  return {
    id,
    functionName,
    location: { path, source: path ? `${Root}/${path}` : 'node:internal/timers', line, column: 3 },
    scopes: [{ type: 'local', name: null, objectId: `${id}-scope` }],
  }
}

function createHarness(options: { startResults?: Array<'ok' | 'fail' | 'hold'> } = {}) {
  const calls: Array<[string, unknown]> = []
  const statuses: WorkbenchDebugStatus[] = []
  const revealed: string[] = []
  let panelOpened = 0
  let listener: (event: WorkbenchDebuggerEvent) => void = () => undefined
  let breakpoints: readonly WorkbenchDebuggerBreakpoint[] = [{ path: 'src/a.ts', line: 3 }]
  let exceptionPause = true
  const breakpointListeners = new Set<() => void>()
  let started = 0
  /** 被压着没回的「起好了」：测试里决定什么时候放行。 */
  const held: Array<() => void> = []
  const startResults = options.startResults ?? []

  const bridge: WorkbenchDebuggerBridge = {
    start: async (request: WorkbenchDebuggerStartRequest) => {
      calls.push(['start', request])
      started += 1
      const sessionId = `debug-${started}`
      const result = startResults[started - 1] ?? 'ok'
      if (result === 'fail') return { ok: false, message: '要调试的脚本不是文件：src', code: 'VALIDATION' }
      if (result === 'hold') await new Promise<void>((resolve) => held.push(resolve))
      return {
        ok: true,
        value: {
          sessionId,
          terminalSessionId: `terminal-${started}`,
          command: 'node --inspect-brk=127.0.0.1:9229 src/main.js',
          cwd: Root,
          shell: '/bin/zsh',
        },
      }
    },
    stop: async (request) => {
      calls.push(['stop', request])
      // 主进程结束了会话之后才回：这期间先把「结束了」推过来。
      listener({ type: 'ended', sessionId: request.sessionId, reason: 'stopped', exitCode: null, message: null })
      return { ok: true, value: undefined }
    },
    control: async (request) => {
      calls.push(['control', request])
      return { ok: true, value: undefined }
    },
    setBreakpoints: async (request) => {
      calls.push(['setBreakpoints', request])
      return {
        ok: true,
        value: {
          breakpoints: request.breakpoints.map((breakpoint) => ({
            ...breakpoint,
            verified: breakpoint.line < 100,
            resolvedLine: breakpoint.line < 100 ? breakpoint.line : null,
          })),
        },
      }
    },
    setExceptionPause: async (request) => {
      calls.push(['setExceptionPause', request])
      return { ok: true, value: undefined }
    },
    getVariables: async (request) => {
      calls.push(['getVariables', request])
      return request.objectId === 'gone'
        ? { ok: false, message: '调试会话已结束。', code: 'CLOSED' }
        : {
            ok: true,
            value: {
              variables: [{ name: 'n', value: { type: 'number', text: '2', objectId: null } }],
              truncated: false,
            },
          }
    },
    evaluate: async (request) => {
      calls.push(['evaluate', request])
      return { ok: true, value: { value: { type: 'number', text: '5', objectId: null }, error: null } }
    },
    onEvent: (next) => {
      listener = next
      return () => undefined
    },
  }

  const session = new WorkbenchDebugSessionController({
    debuggerBridge: () => bridge,
    readBreakpoints: () => breakpoints,
    readExceptionPause: () => exceptionPause,
    subscribeBreakpoints: (next) => {
      breakpointListeners.add(next)
      return () => breakpointListeners.delete(next)
    },
    publishStatus: (status) => statuses.push(status),
    revealLocation: (location) => revealed.push(`${location.path}:${location.line}:${location.column}`),
    openPanel: () => {
      panelOpened += 1
    },
  })

  return {
    bridge,
    session,
    calls,
    statuses,
    revealed,
    panelOpened: () => panelOpened,
    emit: (event: WorkbenchDebuggerEvent) => listener(event),
    release: () => held.shift()?.(),
    setBreakpoints: (next: readonly WorkbenchDebuggerBreakpoint[]) => {
      breakpoints = next
      for (const notify of [...breakpointListeners]) notify()
    },
    setExceptionPause: (next: boolean) => {
      exceptionPause = next
      for (const notify of [...breakpointListeners]) notify()
    },
    start: () =>
      session.start({
        projectRoot: Root,
        target: { kind: 'node-script', script: 'src/main.js', argv: [] },
        cwd: 'packages/api',
        env: { PORT: '4100' },
      }),
  }
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

void describe('debug session in the window', () => {
  void test('starts with the breakpoints of the project and follows the program', async () => {
    const harness = createHarness()
    const { session } = harness
    let notified = 0
    session.subscribe(() => {
      notified += 1
    })
    assert.deepEqual(session.getSnapshot().session, null)

    const started = await harness.start()
    assert.equal(started.terminalSessionId, 'terminal-1')
    assert.deepEqual(harness.calls, [
      [
        'start',
        {
          projectRoot: Root,
          target: { kind: 'node-script', script: 'src/main.js', argv: [] },
          cwd: 'packages/api',
          env: { PORT: '4100' },
          breakpoints: [{ path: 'src/a.ts', line: 3 }],
          pauseOnUncaughtExceptions: true,
        },
      ],
    ])
    assert.deepEqual(session.getSnapshot().session, {
      sessionId: 'debug-1',
      terminalSessionId: 'terminal-1',
      projectRoot: Root,
    })
    assert.deepEqual(harness.statuses, ['running'])

    // 断点对没对上：按「文件 + 行」查。
    harness.emit({
      type: 'breakpoints',
      sessionId: 'debug-1',
      breakpoints: [{ path: 'src/a.ts', line: 3, verified: false, resolvedLine: null }],
    })
    assert.equal(
      session.getSnapshot().breakpointStatuses.get(workbenchBreakpointKey('src\\a.ts', 3))?.verified,
      false
    )

    // 停下：最里层是 Node 内部的代码时，选中最靠里的、项目里有文件的那一帧，把它带到眼前，打开面板。
    harness.emit({
      type: 'paused',
      sessionId: 'debug-1',
      reason: 'exception',
      frames: [
        frame('f0', 'readFileSync', null, 40),
        frame('f1', 'load', 'src/a.ts', 3),
        frame('f2', '', 'src/main.ts', 12),
      ],
      exception: { type: 'object', text: 'Error: ENOENT', objectId: 'e1' },
    })
    const pause = session.getSnapshot().pause
    assert.deepEqual(
      [pause?.reason, pause?.selectedFrameIndex, pause?.exception?.text, pause?.sequence],
      ['exception', 1, 'Error: ENOENT', 1]
    )
    assert.deepEqual(harness.statuses, ['running', 'paused'])
    assert.deepEqual(harness.revealed, ['src/a.ts:3:3'])
    assert.equal(harness.panelOpened(), 1)

    // 编辑器里要高亮哪一行：选中的那一帧所在的文件才有；别的文件、别的项目没有。
    assert.deepEqual(readWorkbenchDebugPausedLine(session.getSnapshot(), Root, 'src/a.ts'), {
      line: 3,
      topFrame: false,
    })
    assert.equal(readWorkbenchDebugPausedLine(session.getSnapshot(), Root, 'src/main.ts'), null)
    assert.equal(readWorkbenchDebugPausedLine(session.getSnapshot(), '/projects/other', 'src/a.ts'), null)

    // 在调用栈里选外层的一帧：变量与求值按它来，文件带到眼前。项目之外的帧能选，但没有文件可开。
    session.selectFrame(2)
    assert.equal(session.getSnapshot().pause?.selectedFrameIndex, 2)
    assert.deepEqual(readWorkbenchDebugPausedLine(session.getSnapshot(), Root, 'src\\main.ts'), {
      line: 12,
      topFrame: false,
    })
    session.selectFrame(0)
    session.selectFrame(9)
    assert.equal(session.getSnapshot().pause?.selectedFrameIndex, 0)
    assert.deepEqual(harness.revealed, ['src/a.ts:3:3', 'src/main.ts:12:3'])

    // 求值在选中的那一帧里；读变量。
    session.selectFrame(1)
    assert.deepEqual(await session.evaluate('n + 3'), {
      value: { type: 'number', text: '5', objectId: null },
      error: null,
    })
    await session.evaluate('n', { sideEffectFree: true })
    assert.deepEqual((await session.getVariables('f1-scope'))?.variables[0]?.name, 'n')
    assert.equal(await session.getVariables('gone'), null)
    assert.deepEqual(harness.calls.slice(1), [
      ['evaluate', { sessionId: 'debug-1', expression: 'n + 3', frameId: 'f1', sideEffectFree: false }],
      ['evaluate', { sessionId: 'debug-1', expression: 'n', frameId: 'f1', sideEffectFree: true }],
      ['getVariables', { sessionId: 'debug-1', objectId: 'f1-scope' }],
      ['getVariables', { sessionId: 'debug-1', objectId: 'gone' }],
    ])

    // 继续：现场没有了；再停一次是新的一次（上一次拿到的对象作废）。
    session.runAction('step-over')
    harness.emit({ type: 'resumed', sessionId: 'debug-1' })
    assert.equal(session.getSnapshot().pause, null)
    harness.emit({
      type: 'paused',
      sessionId: 'debug-1',
      reason: 'step',
      frames: [frame('f3', 'load', 'src/a.ts', 4)],
      exception: null,
    })
    assert.deepEqual(
      [session.getSnapshot().pause?.sequence, session.getSnapshot().pause?.selectedFrameIndex],
      [2, 0]
    )
    assert.deepEqual(readWorkbenchDebugPausedLine(session.getSnapshot(), Root, 'src/a.ts'), {
      line: 4,
      topFrame: true,
    })
    assert.deepEqual(harness.calls.at(-1), ['control', { sessionId: 'debug-1', action: 'step-over' }])
    // 单步走出来的停顿把位置带到眼前，但不去动底部的面板（用户可能正看着输出）。
    assert.deepEqual(harness.revealed.at(-1), 'src/a.ts:4:3')
    assert.equal(harness.panelOpened(), 1)

    // 别的会话（上一次调试的尾巴）的事件不算数。
    harness.emit({ type: 'ended', sessionId: 'debug-0', reason: 'exited', exitCode: 1, message: null })
    assert.ok(session.getSnapshot().session)

    // 程序退出：回到没有在调试，记着是怎么结束的。
    harness.emit({ type: 'ended', sessionId: 'debug-1', reason: 'exited', exitCode: 3, message: null })
    assert.deepEqual(session.getSnapshot(), {
      session: null,
      pause: null,
      breakpointStatuses: new Map(),
      lastEnd: { reason: 'exited', exitCode: 3, message: null },
    })
    assert.deepEqual(harness.statuses, ['running', 'paused', 'running', 'paused', 'idle'])
    assert.ok(notified >= 7)
    // 没有在调试时这些动作什么也不做。
    const callCount = harness.calls.length
    session.runAction('continue')
    session.selectFrame(0)
    assert.deepEqual(await session.evaluate('1'), { value: null, error: '' })
    assert.equal(await session.getVariables('x'), null)
    assert.equal(harness.calls.length, callCount)
  })

  void test('keeps events that arrive before the start call returns', async () => {
    const harness = createHarness({ startResults: ['hold'] })
    const starting = harness.start()
    await tick()
    // 「起好了」还没回来，它的事件先到了。
    harness.emit({ type: 'attached', sessionId: 'debug-1' })
    harness.emit({
      type: 'paused',
      sessionId: 'debug-1',
      reason: 'breakpoint',
      frames: [frame('f0', 'main', 'src/main.ts', 1)],
      exception: null,
    })
    assert.equal(harness.session.getSnapshot().pause, null)

    harness.release()
    await starting
    assert.equal(harness.session.getSnapshot().pause?.reason, 'breakpoint')
    assert.deepEqual(harness.statuses, ['running', 'paused'])
  })

  void test('reconciles settings changed while the program is starting', async () => {
    const harness = createHarness({ startResults: ['hold'] })
    const starting = harness.start()
    await tick()
    harness.setBreakpoints([{ path: 'src/b.ts', line: 8 }])
    harness.setExceptionPause(false)
    assert.deepEqual(harness.calls.map(([method]) => method), ['start'])

    harness.release()
    await starting
    assert.deepEqual(harness.calls.slice(1), [
      ['setExceptionPause', { sessionId: 'debug-1', uncaught: false }],
      ['setBreakpoints', { sessionId: 'debug-1', breakpoints: [{ path: 'src/b.ts', line: 8 }] }],
    ])
    assert.equal(
      harness.session
        .getSnapshot()
        .breakpointStatuses.get(workbenchBreakpointKey('src/b.ts', 8))?.verified,
      true
    )
  })

  void test('retries rejected breakpoints on the next settings change', async () => {
    const harness = createHarness()
    await harness.start()
    const sendBreakpoints = harness.bridge.setBreakpoints
    let attempts = 0
    harness.bridge.setBreakpoints = async (request) => {
      attempts += 1
      if (attempts === 1) return { ok: false, code: 'UNAVAILABLE', message: 'Inspector unavailable' }
      return sendBreakpoints(request)
    }

    harness.setBreakpoints([{ path: 'src/b.ts', line: 8 }])
    await tick()
    assert.equal(attempts, 1)
    assert.equal(harness.session.getSnapshot().breakpointStatuses.size, 0)

    harness.setExceptionPause(false)
    await tick()
    assert.equal(attempts, 2)
    assert.equal(
      harness.session
        .getSnapshot()
        .breakpointStatuses.get(workbenchBreakpointKey('src/b.ts', 8))?.verified,
      true
    )
  })

  void test('retries rejected exception settings on the next breakpoint change', async () => {
    const harness = createHarness()
    await harness.start()
    const sendExceptionPause = harness.bridge.setExceptionPause
    let attempts = 0
    harness.bridge.setExceptionPause = async (request) => {
      attempts += 1
      if (attempts === 1) return { ok: false, code: 'UNAVAILABLE', message: 'Inspector unavailable' }
      return sendExceptionPause(request)
    }

    harness.setExceptionPause(false)
    await tick()
    assert.equal(attempts, 1)

    harness.setBreakpoints([{ path: 'src/b.ts', line: 8 }])
    await tick()
    assert.equal(attempts, 2)
    assert.deepEqual(harness.calls.slice(1), [
      ['setExceptionPause', { sessionId: 'debug-1', uncaught: false }],
      ['setBreakpoints', { sessionId: 'debug-1', breakpoints: [{ path: 'src/b.ts', line: 8 }] }],
    ])
  })

  void test('shows the panel when the debugger could not attach, so the reason is seen', async () => {
    const harness = createHarness()
    await harness.start()
    harness.emit({
      type: 'ended',
      sessionId: 'debug-1',
      reason: 'failed',
      exitCode: null,
      message: '没有等到程序的调试端口',
    })
    assert.deepEqual(harness.session.getSnapshot().lastEnd, {
      reason: 'failed',
      exitCode: null,
      message: '没有等到程序的调试端口',
    })
    assert.equal(harness.panelOpened(), 1)
    assert.deepEqual(harness.statuses, ['running', 'idle'])

    // 程序自己退出、用户结束的：不去动底部的面板。
    await harness.start()
    harness.emit({ type: 'ended', sessionId: 'debug-2', reason: 'exited', exitCode: 0, message: null })
    assert.equal(harness.panelOpened(), 1)
  })

  void test('reports why a debug run could not start and stays idle', async () => {
    const harness = createHarness({ startResults: ['fail', 'ok'] })
    await assert.rejects(harness.start(), /要调试的脚本不是文件/u)
    assert.equal(harness.session.getSnapshot().session, null)
    assert.deepEqual(harness.statuses, [])
    // 之后照常能起。
    await harness.start()
    assert.equal(harness.session.getSnapshot().session?.sessionId, 'debug-2')
  })

  void test('debugs one program at a time: a new start ends the previous one', async () => {
    const harness = createHarness()
    await harness.start()
    // 连点两下：一个接一个起，后一个开始之前先结束前一个。
    const [second, third] = await Promise.all([harness.start(), harness.start()])
    assert.deepEqual([second.sessionId, third.sessionId], ['debug-2', 'debug-3'])
    assert.deepEqual(
      harness.calls.map(([method, request]) => `${method}:${(request as { sessionId?: string }).sessionId ?? ''}`),
      ['start:', 'stop:debug-1', 'start:', 'stop:debug-2', 'start:']
    )
    assert.equal(harness.session.getSnapshot().session?.sessionId, 'debug-3')
    assert.equal(harness.session.getSnapshot().lastEnd, null)

    harness.session.runAction('stop')
    await tick()
    assert.equal(harness.session.getSnapshot().session, null)
    assert.equal(harness.session.getSnapshot().lastEnd?.reason, 'stopped')
  })

  void test('sends breakpoint changes to the running program', async () => {
    const harness = createHarness()
    // 没在调试时断点变了：没有程序可同步。
    harness.setBreakpoints([{ path: 'src/a.ts', line: 5 }])
    await tick()
    assert.deepEqual(harness.calls, [])

    await harness.start()
    harness.setBreakpoints([
      { path: 'src/a.ts', line: 5 },
      { path: 'src/b.ts', line: 400 },
    ])
    await tick()
    assert.deepEqual(harness.calls.at(-1), [
      'setBreakpoints',
      {
        sessionId: 'debug-1',
        breakpoints: [
          { path: 'src/a.ts', line: 5 },
          { path: 'src/b.ts', line: 400 },
        ],
      },
    ])
    // 回来的结果就是各个断点此刻对没对上。
    const statuses = harness.session.getSnapshot().breakpointStatuses
    assert.equal(statuses.get(workbenchBreakpointKey('src/a.ts', 5))?.verified, true)
    assert.equal(statuses.get(workbenchBreakpointKey('src/b.ts', 400))?.verified, false)

    // 只改了「未捕获的异常时暂停」：只发这一项，断点不重发。
    const before = harness.calls.length
    harness.setExceptionPause(false)
    await tick()
    assert.deepEqual(harness.calls.slice(before), [
      ['setExceptionPause', { sessionId: 'debug-1', uncaught: false }],
    ])
  })
})

void describe('debug status seen by the workspace shell', () => {
  void test('says which actions make sense right now and passes them on', () => {
    assert.equal(isWorkbenchDebugActionAvailable('stop', 'idle'), false)
    assert.equal(isWorkbenchDebugActionAvailable('stop', 'running'), true)
    assert.equal(isWorkbenchDebugActionAvailable('stop', 'paused'), true)
    assert.equal(isWorkbenchDebugActionAvailable('pause', 'running'), true)
    assert.equal(isWorkbenchDebugActionAvailable('pause', 'paused'), false)
    for (const action of ['continue', 'step-over', 'step-into', 'step-out'] as const) {
      assert.equal(isWorkbenchDebugActionAvailable(action, 'paused'), true)
      assert.equal(isWorkbenchDebugActionAvailable(action, 'running'), false)
      assert.equal(isWorkbenchDebugActionAvailable(action, 'idle'), false)
    }

    const changes: WorkbenchDebugStatus[] = []
    const unsubscribe = subscribeWorkbenchDebugStatus(() => changes.push(getWorkbenchDebugStatus()))
    const ran: string[] = []
    installWorkbenchDebugActionRunner((action) => ran.push(action))
    try {
      assert.equal(getWorkbenchDebugStatus(), 'idle')
      assert.equal(runWorkbenchDebugAction('continue'), false)

      publishWorkbenchDebugStatus('running')
      publishWorkbenchDebugStatus('running')
      assert.equal(runWorkbenchDebugAction('continue'), false)
      assert.equal(runWorkbenchDebugAction('pause'), true)
      publishWorkbenchDebugStatus('paused')
      assert.equal(runWorkbenchDebugAction('step-into'), true)
      assert.equal(runWorkbenchDebugAction('stop'), true)
      publishWorkbenchDebugStatus('idle')
      assert.equal(runWorkbenchDebugAction('stop'), false)

      assert.deepEqual(ran, ['pause', 'step-into', 'stop'])
      // 状态没变不通知。
      assert.deepEqual(changes, ['running', 'paused', 'idle'])
    } finally {
      unsubscribe()
      installWorkbenchDebugActionRunner(null)
      publishWorkbenchDebugStatus('idle')
    }
  })
})
