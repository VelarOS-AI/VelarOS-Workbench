import assert from 'node:assert/strict'

import { describe, setDefaultTimeout, test } from 'bun:test'

import { AppError } from '@velaros-ai/core/error'

import type { WorkbenchDebugStatus } from '../src/renderer/src/models/debug/workbenchDebugBridge'
import {
  readWorkbenchDebugPausedLine,
  workbenchBreakpointKey,
  WorkbenchDebugSessionController,
  type WorkbenchDebugSnapshot,
} from '../src/renderer/src/models/debug/workbenchDebugSession'
import type {
  WorkbenchDebuggerBreakpoint,
  WorkbenchDebuggerBridge,
  WorkbenchDebuggerEvent,
} from '../src/shared/workbenchDebugger'
import type { WorkbenchFsCallResult } from '../src/shared/workbenchFs'

import { createDebugTestProject } from './helpers/debugSessions'

/**
 * 界面这一侧的调试会话接上主进程真的调试服务，调试一个真的 Node 程序：两半之间只隔着一层与 IPC 同形的信封。
 * 应用里这条路经 preload 与 ipcMain；这里验的是两半对得上——事件的形状、断点的同步、选帧读变量、求值。
 */

setDefaultTimeout(30_000)

const Script = [
  'function add(a, b) {', // 1
  '  const sum = a + b', // 2
  '  return sum', // 3
  '}', // 4
  'const total = add(2, 3)', // 5
  'const label = `total ${total}`', // 6
  'debugger', // 7
  'console.log(label)', // 8
  '',
].join('\n')

async function envelope<T>(call: () => Promise<T>): Promise<WorkbenchFsCallResult<T>> {
  try {
    return { ok: true, value: await call() }
  } catch (error) {
    const appError = AppError.from(error)
    return { ok: false, message: appError.message, code: appError.code }
  }
}

void describe('debugging a real program from the window', () => {
  void test('start, stop at a breakpoint, inspect, step, add a breakpoint, run to the end', async () => {
    const project = await createDebugTestProject({ 'main.js': Script })
    const owner = 1
    let listener: (event: WorkbenchDebuggerEvent) => void = () => undefined
    const { sessions } = project
    const bridge: WorkbenchDebuggerBridge = {
      start: (request) =>
        envelope(() =>
          sessions.startDebugSession(
            request,
            { emit: (event) => listener(event), terminalOutput: () => undefined },
            owner
          )
        ),
      stop: (request) => envelope(() => sessions.stopDebugSession(request, owner)),
      control: (request) => envelope(() => sessions.controlDebugSession(request, owner)),
      setBreakpoints: (request) => envelope(() => sessions.setBreakpoints(request, owner)),
      setExceptionPause: (request) => envelope(() => sessions.setExceptionPause(request, owner)),
      getVariables: (request) => envelope(() => sessions.getVariables(request, owner)),
      evaluate: (request) => envelope(() => sessions.evaluate(request, owner)),
      onEvent: (next) => {
        listener = next
        return () => undefined
      },
    }

    let breakpoints: readonly WorkbenchDebuggerBreakpoint[] = [{ path: 'main.js', line: 2 }]
    const breakpointListeners = new Set<() => void>()
    const statuses: WorkbenchDebugStatus[] = []
    const revealed: string[] = []
    const session = new WorkbenchDebugSessionController({
      debuggerBridge: () => bridge,
      readBreakpoints: () => breakpoints,
      readExceptionPause: () => false,
      subscribeBreakpoints: (next) => {
        breakpointListeners.add(next)
        return () => breakpointListeners.delete(next)
      },
      publishStatus: (status) => statuses.push(status),
      revealLocation: (location) => revealed.push(`${location.path}:${location.line}`),
      openPanel: () => undefined,
    })
    /** 等快照满足条件。 */
    const until = async (
      what: string,
      condition: (snapshot: WorkbenchDebugSnapshot) => boolean
    ): Promise<WorkbenchDebugSnapshot> => {
      const deadline = Date.now() + 15_000
      while (!condition(session.getSnapshot())) {
        if (Date.now() > deadline)
          throw new Error(`timed out waiting for ${what}: ${project.launched[0]?.output()}`)
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      return session.getSnapshot()
    }

    try {
      const started = await session.start({
        projectRoot: project.root,
        target: { kind: 'node-script', script: 'main.js' },
      })
      assert.match(started.command, /^node --inspect-brk=127\.0\.0\.1:\d+ ['"]main\.js['"]$/u)

      // 停在断点上：编辑器要高亮的就是这一行，页面把它带到眼前。
      const atBreakpoint = await until('the breakpoint', (snapshot) => snapshot.pause?.sequence === 1)
      assert.equal(atBreakpoint.pause?.reason, 'breakpoint')
      assert.deepEqual(readWorkbenchDebugPausedLine(atBreakpoint, project.root, 'main.js'), {
        line: 2,
        topFrame: true,
      })
      assert.deepEqual(revealed, ['main.js:2'])
      assert.equal(
        atBreakpoint.breakpointStatuses.get(workbenchBreakpointKey('main.js', 2))?.verified,
        true
      )

      // 面板的变量栏：选中那一帧的局部作用域。
      const frame = atBreakpoint.pause!.frames[0]!
      const locals = await session.getVariables(frame.scopes[0]!.objectId)
      assert.deepEqual(
        locals?.variables.map((variable) => `${variable.name}=${variable.value.type}:${variable.value.text}`),
        ['a=number:2', 'b=number:3', 'sum=unavailable:']
      )
      // 表达式框与悬停：在选中的那一帧里求值；悬停那种不许有副作用。
      assert.equal((await session.evaluate('a * 10 + b')).value?.text, '23')
      assert.equal((await session.evaluate('a', { sideEffectFree: true })).value?.text, '2')
      assert.equal((await session.evaluate('console.log(a)', { sideEffectFree: true })).value, null)
      // 选外层的一帧：求值换到那一帧的作用域里。
      session.selectFrame(1)
      assert.match((await session.evaluate('a')).error ?? '', /a is not defined/u)
      assert.equal((await session.evaluate('typeof add')).value?.text, '"function"')
      assert.deepEqual(revealed, ['main.js:2', 'main.js:5'])

      // 单步跳过：新的一次停下。
      session.runAction('step-over')
      const stepped = await until('the step', (snapshot) => snapshot.pause?.sequence === 2)
      assert.deepEqual(
        [stepped.pause?.reason, stepped.pause?.frames[0]?.location.line, stepped.pause?.selectedFrameIndex],
        ['step', 3, 0]
      )

      // 调试中在第 8 行下一个断点（点行号）：同步给正在跑的程序，回来的状态说它对上了。
      breakpoints = [
        { path: 'main.js', line: 2 },
        { path: 'main.js', line: 8 },
      ]
      for (const notify of [...breakpointListeners]) notify()
      await until(
        'the new breakpoint',
        (snapshot) => snapshot.breakpointStatuses.get(workbenchBreakpointKey('main.js', 8))?.verified === true
      )

      // 继续：先到 debugger 语句，再到新下的断点，然后跑完。
      session.runAction('continue')
      const statement = await until('the debugger statement', (snapshot) => snapshot.pause?.sequence === 3)
      assert.deepEqual([statement.pause?.reason, statement.pause?.frames[0]?.location.line], ['other', 7])
      session.runAction('continue')
      const added = await until('the added breakpoint', (snapshot) => snapshot.pause?.sequence === 4)
      assert.deepEqual([added.pause?.reason, added.pause?.frames[0]?.location.line], ['breakpoint', 8])
      assert.equal((await session.evaluate('label')).value?.text, '"total 5"')

      session.runAction('continue')
      const ended = await until('the end', (snapshot) => snapshot.session === null)
      assert.deepEqual(ended.lastEnd, { reason: 'exited', exitCode: 0, message: null })
      assert.equal(ended.pause, null)
      assert.equal(ended.breakpointStatuses.size, 0)
      assert.match(project.launched[0]!.output(), /total 5/u)
      assert.deepEqual(statuses, [
        'running',
        'paused',
        'running',
        'paused',
        'running',
        'paused',
        'running',
        'paused',
        'running',
        'idle',
      ])
    } finally {
      await project.dispose()
    }
  })

  void test('a target that cannot be started is reported, and stopping ends a running program', async () => {
    const project = await createDebugTestProject({
      'loop.js': 'setInterval(() => {}, 1000)\n',
    })
    let listener: (event: WorkbenchDebuggerEvent) => void = () => undefined
    const { sessions } = project
    const bridge = {
      start: (request) =>
        envelope(() =>
          sessions.startDebugSession(
            request,
            { emit: (event) => listener(event), terminalOutput: () => undefined },
            1
          )
        ),
      stop: (request) => envelope(() => sessions.stopDebugSession(request, 1)),
      onEvent: (next) => {
        listener = next
        return () => undefined
      },
    } as WorkbenchDebuggerBridge
    const session = new WorkbenchDebugSessionController({
      debuggerBridge: () => bridge,
      readBreakpoints: () => [],
      readExceptionPause: () => true,
      subscribeBreakpoints: () => () => undefined,
      publishStatus: () => undefined,
      revealLocation: () => undefined,
      openPanel: () => undefined,
    })
    try {
      // 运行卡那边拿到的是带着原因的错误（弹给用户看）。
      await assert.rejects(
        session.start({ projectRoot: project.root, target: { kind: 'node-script', script: 'missing.js' } })
      )
      assert.equal(session.getSnapshot().session, null)

      await session.start({ projectRoot: project.root, target: { kind: 'node-script', script: 'loop.js' } })
      assert.ok(session.getSnapshot().session)
      await session.stop()
      assert.equal(session.getSnapshot().session, null)
      assert.equal(session.getSnapshot().lastEnd?.reason, 'stopped')
    } finally {
      await project.dispose()
    }
  })
})
