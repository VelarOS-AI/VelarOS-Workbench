import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { join } from 'node:path'

import { describe, setDefaultTimeout, test } from 'bun:test'

import type { WorkbenchDebuggerControlAction } from '../src/shared/workbenchDebugger'

import { createDebugTestProject, type DebugTestProject, frameSummary } from './helpers/debugSessions'

/**
 * 单步走出用户的代码之后停在哪：调试的是真的 Node 程序。Node 自己的代码（模块加载、事件分发、定时器）和
 * 依赖包里的代码不给用户看——单步进去了要接着走，回到用户的代码再停；没有用户的代码可回就让程序跑下去。
 */

setDefaultTimeout(30_000)

type Stop = Awaited<ReturnType<DebugTestProject['nextStop']>>
type PausedStop = Extract<Stop, { type: 'paused' }>

/** 发一个控制命令，等程序下一次停下或者结束。 */
async function act(
  project: DebugTestProject,
  sessionId: string,
  action: WorkbenchDebuggerControlAction
): Promise<Stop> {
  await project.sessions.controlDebugSession({ sessionId, action }, 1)
  return project.nextStop()
}

/** `原因 函数@文件:行`；程序结束了是 `ended 原因 退出码`。 */
function describeStop(stop: Stop): string {
  return stop.type === 'ended'
    ? `ended ${stop.reason} ${stop.exitCode}`
    : `${stop.reason} ${frameSummary(stop.frames[0])}`
}

/**
 * 连着做同一个单步，直到 `isDone` 说到了（或者程序结束）；返回途中每一次停下。走了 `limit` 步还没到就报错，
 * 不让一个走不出去的单步把测试挂住。
 */
async function stepUntil(
  project: DebugTestProject,
  sessionId: string,
  action: WorkbenchDebuggerControlAction,
  isDone: (stop: PausedStop) => boolean,
  limit = 12
): Promise<Stop[]> {
  const stops: Stop[] = []
  for (let count = 0; count < limit; count += 1) {
    const stop = await act(project, sessionId, action)
    stops.push(stop)
    if (stop.type === 'ended' || isDone(stop)) return stops
  }
  throw new Error(`still stepping after ${limit} steps: ${stops.map(describeStop).join(' | ')}`)
}

const never = (): boolean => false
const topPath = (stop: Stop): Nullable<string> =>
  stop.type === 'paused' ? (stop.frames[0]?.location.path ?? null) : null
const topFunction = (stop: Stop): string =>
  stop.type === 'paused' ? (stop.frames[0]?.functionName ?? '') : ''

const RequireFiles = {
  'main.js': [
    'const { helper } = require("./helper.js")', // 1
    'const value = helper(2)', // 2
    'console.log("value", value)', // 3
    '',
  ].join('\n'),
  'helper.js': [
    'exports.helper = function helper(n) {', // 1
    '  return n * 2', // 2
    '}', // 3
    '',
  ].join('\n'),
}

void describe('stepping out of the program’s own code', () => {
  void test('stepping past the last statement lets the program finish instead of stopping inside Node', async () => {
    const project = await createDebugTestProject({
      'main.js': [
        'function add(a, b) {', // 1
        '  return a + b', // 2
        '}', // 3
        'const total = add(2, 3)', // 4
        'console.log("total", total)', // 5
        '',
      ].join('\n'),
    })
    try {
      const { sessionId } = await project.start({
        target: { kind: 'node-script', script: 'main.js' },
        breakpoints: [{ path: 'main.js', line: 2 }],
      })
      assert.equal(describeStop(await project.nextStop()), 'breakpoint add@main.js:2')

      const stops = await stepUntil(project, sessionId, 'step-over', never)
      // 途中每一次都停在 main.js 里：从函数回到顶层，再一句句走到最后。
      const pauses = stops.slice(0, -1)
      assert.ok(pauses.length >= 2, stops.map(describeStop).join(' | '))
      for (const stop of pauses) {
        assert.equal(stop.type === 'paused' && stop.reason, 'step')
        assert.equal(topPath(stop), 'main.js', describeStop(stop))
      }
      assert.equal(describeStop(pauses.at(-1)!), 'step (anonymous)@main.js:5')
      // 最后一句之后没有用户的代码了：程序跑完、退出。
      assert.equal(describeStop(stops.at(-1)!), 'ended exited 0')
      assert.match(project.launched[0]!.output(), /total 5/u)
    } finally {
      await project.dispose()
    }
  })

  void test('stepping past the end of a required module comes back to the statement after the require', async () => {
    const project = await createDebugTestProject(RequireFiles)
    try {
      const { sessionId } = await project.start({
        target: { kind: 'node-script', script: 'main.js' },
        breakpoints: [{ path: 'helper.js', line: 1 }],
      })
      assert.equal(describeStop(await project.nextStop()), 'breakpoint (anonymous)@helper.js:1')

      // 模块顶层走完之后，外面是 Node 加载模块的那几层：不停在那里，回到 require 它的那个文件。
      const leaving = await stepUntil(
        project,
        sessionId,
        'step-over',
        (stop) => topPath(stop) !== 'helper.js'
      )
      assert.equal(describeStop(leaving.at(-1)!), 'step (anonymous)@main.js:2')

      const rest = await stepUntil(project, sessionId, 'step-over', never)
      for (const stop of rest.slice(0, -1)) assert.equal(topPath(stop), 'main.js', describeStop(stop))
      assert.equal(describeStop(rest.at(-1)!), 'ended exited 0')
      assert.match(project.launched[0]!.output(), /value 4/u)
    } finally {
      await project.dispose()
    }
  })

  void test('step into on a require line goes to the first statement of the required module', async () => {
    const project = await createDebugTestProject(RequireFiles)
    try {
      const { sessionId } = await project.start({
        target: { kind: 'node-script', script: 'main.js' },
        breakpoints: [{ path: 'main.js', line: 1 }],
      })
      assert.equal(describeStop(await project.nextStop()), 'breakpoint (anonymous)@main.js:1')

      // 中间隔着 Node 加载模块的上万步：不一步步走过去，也不把模块整个跳过。
      assert.equal(
        describeStop(await act(project, sessionId, 'step-into')),
        'step (anonymous)@helper.js:1'
      )
      assert.equal(
        describeStop(await act(project, sessionId, 'step-out')),
        'step (anonymous)@main.js:2'
      )
      assert.equal(describeStop(await act(project, sessionId, 'continue')), 'ended exited 0')
      // 途中没有在别处多停。
      assert.equal(project.events.filter((event) => event.type === 'paused').length, 3)
    } finally {
      await project.dispose()
    }
  })

  void test('step over on a require line does not stop inside the module, also when it has a breakpoint further down', async () => {
    const project = await createDebugTestProject(RequireFiles)
    try {
      const { sessionId } = await project.start({
        target: { kind: 'node-script', script: 'main.js' },
        // helper.js 里有断点：调试器会在它开始执行前自己停一下（把断点落好），那一下不能算这次单步的终点。
        breakpoints: [
          { path: 'main.js', line: 1 },
          { path: 'helper.js', line: 2 },
        ],
      })
      assert.equal(describeStop(await project.nextStop()), 'breakpoint (anonymous)@main.js:1')
      assert.equal(
        describeStop(await act(project, sessionId, 'step-over')),
        'step (anonymous)@main.js:2'
      )
      // 下一步调用的函数里有断点：照常停。
      assert.equal(
        describeStop(await act(project, sessionId, 'step-over')),
        'breakpoint helper@helper.js:2'
      )
      assert.equal(
        describeStop(await act(project, sessionId, 'step-out')),
        'step (anonymous)@main.js:3'
      )
      assert.equal(describeStop(await act(project, sessionId, 'continue')), 'ended exited 0')
    } finally {
      await project.dispose()
    }
  })

  void test('step over stays in the function it started in when the module is loaded through the project’s own code', async () => {
    const project = await createDebugTestProject({
      ...RequireFiles,
      'load.js': [
        'module.exports = function load(name) {', // 1
        '  return require(name)', // 2
        '}', // 3
        '',
      ].join('\n'),
      'main.js': [
        'const load = require("./load.js")', // 1
        'const { helper } = load("./helper.js")', // 2
        'console.log("value", helper(2))', // 3
        '',
      ].join('\n'),
    })
    try {
      const { sessionId } = await project.start({
        target: { kind: 'node-script', script: 'main.js' },
        breakpoints: [
          { path: 'main.js', line: 2 },
          { path: 'helper.js', line: 2 },
        ],
      })
      assert.equal(describeStop(await project.nextStop()), 'breakpoint (anonymous)@main.js:2')
      // helper.js 开始执行前调试器停了一下，此刻调用栈上离得最近的用户代码是 load()：这一步是从 main.js
      // 出发的「跳过」，不停在比它深的 load() 里。
      assert.equal(
        describeStop(await act(project, sessionId, 'step-over')),
        'step (anonymous)@main.js:3'
      )
      assert.equal(
        describeStop(await act(project, sessionId, 'step-over')),
        'breakpoint helper@helper.js:2'
      )
      assert.equal(describeStop(await act(project, sessionId, 'continue')), 'ended exited 0')
    } finally {
      await project.dispose()
    }
  })

  void test('a listener called by Node: step into reaches it, stepping past its end returns to the caller, also in a loop', async () => {
    const project = await createDebugTestProject({
      'emit.js': [
        'const { EventEmitter } = require("node:events")', // 1
        'const path = require("node:path")', // 2
        'const emitter = new EventEmitter()', // 3
        'emitter.on("ping", function onPing(count) {', // 4
        '  const doubled = count * 2', // 5
        '  console.log("ping", doubled)', // 6
        '})', // 7
        'emitter.emit("ping", 1)', // 8
        'const joined = path.join("a", "b")', // 9
        'console.log("joined", joined)', // 10
        'for (let index = 0; index < 2; index += 1) {', // 11
        '  emitter.emit("ping", index + 10)', // 12
        '}', // 13
        'console.log("done")', // 14
        '',
      ].join('\n'),
    })
    try {
      const { sessionId } = await project.start({
        target: { kind: 'node-script', script: 'emit.js' },
        breakpoints: [{ path: 'emit.js', line: 8 }],
      })
      assert.equal(describeStop(await project.nextStop()), 'breakpoint (anonymous)@emit.js:8')

      // emit 是 Node 的代码，它转手调了监听函数：单步进入停在监听函数里。调用栈里 emit 那一帧还在。
      const inListener = await act(project, sessionId, 'step-into')
      assert.equal(describeStop(inListener), 'step onPing@emit.js:5')
      assert.ok(inListener.type === 'paused')
      assert.deepEqual(
        inListener.frames.slice(1, 3).map((frame) => [frame.location.path, frame.location.source]),
        [
          [null, 'node:events'],
          ['emit.js', join(project.root, 'emit.js')],
        ]
      )

      // 监听函数走完，回到调用 emit 的那一句后面。
      const leaving = await stepUntil(
        project,
        sessionId,
        'step-over',
        (stop) => topFunction(stop) !== 'onPing'
      )
      for (const stop of leaving.slice(0, -1)) assert.equal(topPath(stop), 'emit.js')
      assert.equal(describeStop(leaving.at(-1)!), 'step (anonymous)@emit.js:9')

      // 单步进入 Node 自己的函数（不回调用户代码的）：相当于跳过它。
      assert.equal(
        describeStop(await act(project, sessionId, 'step-into')),
        'step (anonymous)@emit.js:10'
      )
      assert.equal(
        describeStop(await act(project, sessionId, 'step-into')),
        'step (anonymous)@emit.js:11'
      )

      // 循环里调的监听函数：步出之后先到的是循环头（在调用那一行的上面），不是循环后面的语句。
      await project.sessions.setBreakpoints(
        { sessionId, breakpoints: [{ path: 'emit.js', line: 5 }] },
        1
      )
      const inLoop = await act(project, sessionId, 'continue')
      assert.equal(describeStop(inLoop), 'breakpoint onPing@emit.js:5')
      assert.ok(inLoop.type === 'paused')
      assert.equal(frameSummary(inLoop.frames[2]), '(anonymous)@emit.js:12')
      assert.equal(
        describeStop(await act(project, sessionId, 'step-out')),
        'step (anonymous)@emit.js:11'
      )
      assert.equal(
        describeStop(await act(project, sessionId, 'continue')),
        'breakpoint onPing@emit.js:5'
      )
      await project.sessions.setBreakpoints({ sessionId, breakpoints: [] }, 1)
      const leavingLoop = await stepUntil(
        project,
        sessionId,
        'step-over',
        (stop) => topFunction(stop) !== 'onPing'
      )
      assert.equal(describeStop(leavingLoop.at(-1)!), 'step (anonymous)@emit.js:11')

      const rest = await stepUntil(project, sessionId, 'step-over', never)
      for (const stop of rest.slice(0, -1)) assert.equal(topPath(stop), 'emit.js', describeStop(stop))
      assert.equal(describeStop(rest.at(-1)!), 'ended exited 0')
      assert.deepEqual(
        project.launched[0]!.output().match(/^(?:ping \d+|joined .+|done)$/gmu),
        ['ping 2', 'joined a/b', 'ping 20', 'ping 22', 'done']
      )
    } finally {
      await project.dispose()
    }
  })

  void test('stepping out of a listener called in a loop inside a function lands on the loop, not after it', async () => {
    const project = await createDebugTestProject({
      'loops.js': [
        'const { EventEmitter } = require("node:events")', // 1
        'const emitter = new EventEmitter()', // 2
        'emitter.on("ping", function onPing(label) {', // 3
        '  return label.length', // 4
        '})', // 5
        'function plain() {', // 6
        '  for (let index = 0; index < 2; index += 1) {', // 7
        '    emitter.emit("ping", "plain")', // 8
        '  }', // 9
        '  return "plain done"', // 10
        '}', // 11
        'class Runner {', // 12
        '  run() {', // 13
        '    let count = 0', // 14
        '    while (count < 2) {', // 15
        '      count += 1', // 16
        '      emitter.emit("ping", "method")', // 17
        '    }', // 18
        '    return "method done"', // 19
        '  }', // 20
        '}', // 21
        'console.log(plain(), new Runner().run())', // 22
        '',
      ].join('\n'),
    })
    try {
      const { sessionId } = await project.start({
        target: { kind: 'node-script', script: 'loops.js' },
        breakpoints: [{ path: 'loops.js', line: 4 }],
      })
      // 监听函数一共被调四次，每次都步出：回到的是调用它的那个函数的循环头（在调用那一行的上面）。
      const landings: string[] = []
      let stop = await project.nextStop()
      while (stop.type === 'paused') {
        assert.equal(describeStop(stop), 'breakpoint onPing@loops.js:4')
        landings.push(describeStop(await act(project, sessionId, 'step-out')))
        stop = await act(project, sessionId, 'continue')
      }
      assert.deepEqual(landings, [
        'step plain@loops.js:7',
        'step plain@loops.js:7',
        'step run@loops.js:15',
        'step run@loops.js:15',
      ])
      assert.equal(describeStop(stop), 'ended exited 0')
      assert.match(project.launched[0]!.output(), /plain done method done/u)
    } finally {
      await project.dispose()
    }
  })

  void test('stepping past the end of a timer callback lets the program run on to the next breakpoint', async () => {
    const project = await createDebugTestProject({
      'timers.js': [
        'setTimeout(function first() {', // 1
        '  console.log("first")', // 2
        '}, 5)', // 3
        'setTimeout(function second() {', // 4
        '  console.log("second")', // 5
        '}, 60)', // 6
        '',
      ].join('\n'),
    })
    try {
      const { sessionId } = await project.start({
        target: { kind: 'node-script', script: 'timers.js' },
        breakpoints: [
          { path: 'timers.js', line: 2 },
          { path: 'timers.js', line: 5 },
        ],
      })
      assert.equal(describeStop(await project.nextStop()), 'breakpoint first@timers.js:2')

      // 回调是定时器调的，外面没有用户的代码：走完它就是继续运行，下一次停下是因为断点。
      const leaving = await stepUntil(
        project,
        sessionId,
        'step-over',
        (stop) => topFunction(stop) !== 'first'
      )
      for (const stop of leaving.slice(0, -1)) assert.equal(describeStop(stop).slice(0, 21), 'step first@timers.js:')
      assert.equal(describeStop(leaving.at(-1)!), 'breakpoint second@timers.js:5')

      const rest = await stepUntil(project, sessionId, 'step-over', never)
      for (const stop of rest.slice(0, -1)) assert.equal(topPath(stop), 'timers.js', describeStop(stop))
      assert.equal(describeStop(rest.at(-1)!), 'ended exited 0')
    } finally {
      await project.dispose()
    }
  })
})

const DependencyFiles = {
  'node_modules/dep/index.js': [
    'exports.twice = function twice(callback, value) {', // 1
    '  const first = callback(value)', // 2
    '  const second = callback(first)', // 3
    '  return second', // 4
    '}', // 5
    '',
  ].join('\n'),
  'main.js': [
    'const { twice } = require("dep")', // 1
    'function increment(n) {', // 2
    '  return n + 1', // 3
    '}', // 4
    'const result = twice(increment, 1)', // 5
    'console.log("result", result)', // 6
    '',
  ].join('\n'),
}

void describe('stepping and code in node_modules', () => {
  void test('from project code, stepping goes through a dependency without stopping in it', async () => {
    const project = await createDebugTestProject(DependencyFiles)
    try {
      const { sessionId } = await project.start({
        target: { kind: 'node-script', script: 'main.js' },
        breakpoints: [{ path: 'main.js', line: 5 }],
      })
      assert.equal(describeStop(await project.nextStop()), 'breakpoint (anonymous)@main.js:5')

      // 单步进入依赖包的函数：不停在它里面，停在它回调的项目代码里。依赖包那一帧照样在调用栈里，能点开。
      const inCallback = await act(project, sessionId, 'step-into')
      assert.equal(describeStop(inCallback), 'step increment@main.js:3')
      assert.ok(inCallback.type === 'paused')
      assert.equal(frameSummary(inCallback.frames[1]), 'twice@node_modules/dep/index.js:2')

      // 回调走完回到依赖包里：不停，一直到回到项目代码（依赖包再调一次回调也不停，与步出一样）。
      const leaving = await stepUntil(
        project,
        sessionId,
        'step-over',
        (stop) => topFunction(stop) !== 'increment'
      )
      assert.equal(describeStop(leaving.at(-1)!), 'step (anonymous)@main.js:6')
      assert.equal(describeStop(await act(project, sessionId, 'continue')), 'ended exited 0')
      assert.match(project.launched[0]!.output(), /result 3/u)
    } finally {
      await project.dispose()
    }
  })

  void test('after a breakpoint inside a dependency, stepping there works line by line', async () => {
    const project = await createDebugTestProject(DependencyFiles)
    try {
      const { sessionId } = await project.start({
        target: { kind: 'node-script', script: 'main.js' },
        breakpoints: [{ path: 'node_modules/dep/index.js', line: 3 }],
      })
      assert.equal(
        describeStop(await project.nextStop()),
        'breakpoint twice@node_modules/dep/index.js:3'
      )
      assert.equal(
        describeStop(await act(project, sessionId, 'step-over')),
        'step twice@node_modules/dep/index.js:4'
      )
      assert.equal(
        describeStop(await act(project, sessionId, 'step-out')),
        'step (anonymous)@main.js:6'
      )
      assert.equal(describeStop(await act(project, sessionId, 'continue')), 'ended exited 0')
    } finally {
      await project.dispose()
    }
  })
})

void describe('stepping across modules a loader compiles in place', () => {
  // 与 tsx 同样的做法：一个依赖包在加载 .ts 时当场把它转成 JS，脚本地址还是那个 .ts 文件，映射内联在代码
  // 末尾；生成的代码最前面有几句源码里没有的（`Object.defineProperty(exports, "__esModule", …)`）。
  const typescriptPath = createRequire(import.meta.url).resolve('typescript')
  const LoaderFiles = {
    'node_modules/inplace-loader/index.js': [
      `const ts = require(${JSON.stringify(typescriptPath)})`,
      "const fs = require('node:fs')",
      "require.extensions['.ts'] = (module, filename) => {",
      "  const source = fs.readFileSync(filename, 'utf8')",
      '  const { outputText } = ts.transpileModule(source, {',
      '    fileName: filename,',
      '    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, inlineSourceMap: true },',
      '  })',
      '  module._compile(outputText, filename)',
      '}',
      '',
    ].join('\n'),
    'start.cjs': "require('inplace-loader')\nrequire('./app.ts')\n",
    'app.ts': [
      "import { double } from './util'", // 1
      'const value: number = double(4)', // 2
      "console.log('value', value)", // 3
      '',
    ].join('\n'),
    'util.ts': [
      'const base: number = 2', // 1
      'export function double(n: number): number {', // 2
      '  return n * base', // 3
      '}', // 4
      '',
    ].join('\n'),
  }

  void test('step over an import does not stop at the imported module’s entry; its breakpoints still work', async () => {
    const project = await createDebugTestProject(LoaderFiles)
    try {
      const { sessionId } = await project.start({
        target: { kind: 'node-script', script: 'start.cjs' },
        breakpoints: [
          { path: 'app.ts', line: 1 },
          { path: 'util.ts', line: 3 },
        ],
      })
      assert.equal(describeStop(await project.nextStop()), 'breakpoint (anonymous)@app.ts:1')
      // util.ts 里有断点：它开始执行前调试器自己停了一下去落断点，这次单步接着走完。
      assert.equal(
        describeStop(await act(project, sessionId, 'step-over')),
        'step (anonymous)@app.ts:2'
      )
      assert.equal(
        describeStop(await act(project, sessionId, 'continue')),
        'breakpoint double@util.ts:3'
      )
      assert.equal(
        describeStop(await act(project, sessionId, 'step-out')),
        'step (anonymous)@app.ts:3'
      )
      // app.ts 走完：外面是加载器（依赖包）和 Node，回到 require 它的 start.cjs。
      const leaving = await stepUntil(
        project,
        sessionId,
        'step-over',
        (stop) => topPath(stop) !== 'app.ts'
      )
      assert.equal(describeStop(leaving.at(-1)!), 'step (anonymous)@start.cjs:2')
      assert.match(project.launched[0]!.output(), /value 8/u)
      const rest = await stepUntil(project, sessionId, 'step-over', never)
      for (const stop of rest.slice(0, -1))
        assert.equal(topPath(stop), 'start.cjs', describeStop(stop))
      assert.equal(describeStop(rest.at(-1)!), 'ended exited 0')
    } finally {
      await project.dispose()
    }
  })

  void test('step into an import stops at the first statement the source has, not at the code the loader added', async () => {
    const project = await createDebugTestProject(LoaderFiles)
    try {
      const { sessionId } = await project.start({
        target: { kind: 'node-script', script: 'start.cjs' },
        breakpoints: [{ path: 'app.ts', line: 1 }],
      })
      assert.equal(describeStop(await project.nextStop()), 'breakpoint (anonymous)@app.ts:1')
      // 生成的代码开头是 `Object.defineProperty(exports, "__esModule", …)`（源码里没有，不停），接着是提前了的
      // `exports.double = double`——映射说它来自第 2 行的 `export function double`，就停在那里。
      assert.equal(
        describeStop(await act(project, sessionId, 'step-into')),
        'step (anonymous)@util.ts:2'
      )
      const leaving = await stepUntil(
        project,
        sessionId,
        'step-over',
        (stop) => topPath(stop) !== 'util.ts'
      )
      for (const stop of leaving.slice(0, -1)) assert.equal(topPath(stop), 'util.ts', describeStop(stop))
      assert.equal(describeStop(leaving.at(-1)!), 'step (anonymous)@app.ts:2')
      assert.equal(describeStop(await act(project, sessionId, 'continue')), 'ended exited 0')
    } finally {
      await project.dispose()
    }
  })
})
