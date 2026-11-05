import assert from 'node:assert/strict'
import { join } from 'node:path'

import { describe, setDefaultTimeout, test } from 'bun:test'

import { currentPlatform } from '@velaros-ai/velaros/core/platform'

import { resolveWorkbenchNodeExecutable } from '../src/main/conversation/WorkbenchNodeRuntime'

import {
  createDebugTestProject,
  frameSummary,
  isProcessAlive,
  variablesOf,
} from './helpers/debugSessions'

/**
 * 调试会话的另一半：程序怎么起（三种起法）、归哪个窗口、怎么停、起不来时怎么收场。与
 * `workbench-debugger.test.ts` 一样调试的是真的 Node 程序，只连本机回环地址。
 */

// 每一步都要等子进程与检查器：机器忙的时候默认的 5 秒不够。
setDefaultTimeout(30_000)

async function waitFor(condition: () => boolean, what: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

void describe('starting a debug session', () => {
  void test('debug fixtures ignore inherited Node options but keep explicit launch options', async () => {
    const inherited = process.env.NODE_OPTIONS
    const project = await createDebugTestProject({ 'main.cjs': 'debugger\n' })
    try {
      // 若漏隔离，Node 会在调试器连上前因这个不存在的预加载模块退出。
      process.env.NODE_OPTIONS = '--require=./missing-host-preload.cjs'
      const first = await project.start({ target: { kind: 'node-script', script: 'main.cjs' } })
      assert.equal((await project.next('paused')).sessionId, first.sessionId)
      assert.equal(project.launched[0]!.env.NODE_OPTIONS, '')
      await project.sessions.controlDebugSession(
        { sessionId: first.sessionId, action: 'continue' },
        1
      )
      await project.next('ended')
      const second = await project.start({
        target: { kind: 'node-script', script: 'main.cjs' },
        env: { NODE_OPTIONS: '--no-warnings' },
      })
      assert.equal((await project.next('paused')).sessionId, second.sessionId)
      assert.equal(project.launched[1]!.env.NODE_OPTIONS, '--no-warnings')
      await project.sessions.controlDebugSession(
        { sessionId: second.sessionId, action: 'continue' },
        1
      )
      await project.next('ended')
    } finally {
      if (inherited === undefined) delete process.env.NODE_OPTIONS
      else process.env.NODE_OPTIONS = inherited
      await project.dispose()
    }
  })

  void test('a tool that takes --inspect-brk itself: its own first stop is not shown to the user', async () => {
    const project = await createDebugTestProject({
      // 与 Vitest 同样的做法：自己认开关、自己开检查器、等调试器连上，然后在跑测试文件之前自己先停一下。
      'tool.cjs': [
        "const inspector = require('node:inspector')",
        "const flag = process.argv.find((argument) => argument.startsWith('--inspect-brk='))",
        "const [host, port] = flag.slice('--inspect-brk='.length).split(':')",
        'inspector.open(Number(port), host, true)',
        'debugger',
        "require('./case.cjs')",
        '',
      ].join('\n'),
      'case.cjs': [
        'const answer = 6 * 7', // 1
        "console.log('answer', answer)", // 2
        'debugger', // 3
        "console.log('done')", // 4
        '',
      ].join('\n'),
    })
    try {
      const started = await project.start({
        target: { kind: 'inspect-command', command: 'node tool.cjs' },
        breakpoints: [{ path: 'case.cjs', line: 2 }],
      })
      assert.match(started.command, /^node tool\.cjs --inspect-brk=127\.0\.0\.1:\d+$/u)

      const first = await project.next('paused')
      assert.equal(first.reason, 'breakpoint')
      assert.equal(frameSummary(first.frames[0]), '(anonymous)@case.cjs:2')
      assert.equal(
        (await variablesOf(project, started.sessionId, first.frames[0]!, 'local')).answer?.text,
        '42'
      )

      // 只有开头那一下不算：后面程序自己的 debugger 语句照样停。
      await project.sessions.controlDebugSession(
        { sessionId: started.sessionId, action: 'continue' },
        1
      )
      const statement = await project.next('paused')
      assert.equal(statement.reason, 'other')
      assert.equal(frameSummary(statement.frames[0]), '(anonymous)@case.cjs:3')

      await project.sessions.controlDebugSession(
        { sessionId: started.sessionId, action: 'continue' },
        1
      )
      assert.equal((await project.next('ended')).exitCode, 0)
      assert.match(project.launched[0]!.output(), /answer 42\ndone/u)
    } finally {
      await project.dispose()
    }
  })

  void test('the executable of a dependency is started by node itself, found from the working directory upwards', async () => {
    const project = await createDebugTestProject({
      'node_modules/fake-runner/package.json': JSON.stringify({
        name: 'fake-runner',
        version: '1.0.0',
        bin: { 'fake-runner': './bin/run.cjs', escape: '../../outside.cjs' },
      }),
      'node_modules/fake-runner/bin/run.cjs': [
        "const path = require('node:path')",
        "console.log('arguments', JSON.stringify(process.argv.slice(2)))",
        'require(path.resolve(process.argv[2]))',
        '',
      ].join('\n'),
      'outside.cjs': '',
      'packages/app/case.cjs': [
        'const label = process.env.DEBUG_LABEL', // 1
        "console.log('label', label)", // 2
        '',
      ].join('\n'),
    })
    try {
      const started = await project.start({
        target: {
          kind: 'node-package-bin',
          packageName: 'fake-runner',
          args: `case.cjs --name ${currentPlatform.quoteShellArg('two words')}`,
        },
        cwd: 'packages/app',
        env: { DEBUG_LABEL: 'from the configuration' },
        breakpoints: [{ path: 'packages/app/case.cjs', line: 2 }],
      })
      // 包装在工作目录之上：命令行里写绝对路径；参数原样交给 shell 去拆。
      assert.equal(
        started.command.replace(/:\d+ /u, ':PORT '),
        `node --inspect-brk=127.0.0.1:PORT ${currentPlatform.quoteShellArg(join(project.root, 'node_modules/fake-runner/bin/run.cjs'))} case.cjs --name ${currentPlatform.quoteShellArg('two words')}`
      )
      assert.equal(started.cwd, join(project.root, 'packages/app'))

      const paused = await project.next('paused')
      // 两个文件之间隔着 Node 自己的模块加载代码：那些帧也在调用栈里，只是不属于项目（没有可打开的文件）。
      const internal = paused.frames.filter((frame) => frame.location.path === null)
      assert.ok(internal.length > 0)
      assert.ok(internal.every((frame) => frame.location.source.startsWith('node:internal/')))
      assert.deepEqual(
        paused.frames.filter((frame) => frame.location.path !== null).map(frameSummary),
        [
          '(anonymous)@packages/app/case.cjs:2',
          '(anonymous)@node_modules/fake-runner/bin/run.cjs:3',
        ]
      )
      assert.equal(
        (await variablesOf(project, started.sessionId, paused.frames[0]!, 'local')).label?.text,
        '"from the configuration"'
      )
      await project.sessions.controlDebugSession(
        { sessionId: started.sessionId, action: 'continue' },
        1
      )
      assert.equal((await project.next('ended')).exitCode, 0)
      assert.match(project.launched[0]!.output(), /arguments \["case\.cjs","--name","two words"\]/u)

      // 没装的包、清单里没有这个入口、入口指到包外面去：都不起进程。
      for (const target of [
        { kind: 'node-package-bin', packageName: 'not-installed' },
        { kind: 'node-package-bin', packageName: 'fake-runner', binName: 'missing' },
        { kind: 'node-package-bin', packageName: 'fake-runner', binName: 'escape' },
        { kind: 'node-package-bin', packageName: '../outside' },
      ] as const) {
        await assert.rejects(project.start({ target }), /的可执行入口/u)
      }
      assert.equal(project.launched.length, 1)
    } finally {
      await project.dispose()
    }
  })

  void test('refuses targets outside the project before anything is started', async () => {
    const project = await createDebugTestProject({ 'main.js': '', 'folder/file.js': '' })
    try {
      await assert.rejects(project.start({ target: { kind: 'node-script', script: 'missing.js' } }))
      await assert.rejects(
        project.start({ target: { kind: 'node-script', script: '../outside.js' } })
      )
      await assert.rejects(project.start({ target: { kind: 'node-script', script: '/etc/hosts' } }))
      await assert.rejects(
        project.start({ target: { kind: 'node-script', script: 'folder' } }),
        /要调试的脚本不是文件：folder/u
      )
      await assert.rejects(
        project.start({ target: { kind: 'node-script', script: 'main.js' }, cwd: 'main.js' }),
        /必须是目录/u
      )
      await assert.rejects(
        project.start({ target: { kind: 'node-script', script: 'main.js' }, cwd: '..' })
      )
      await assert.rejects(
        project.start({ target: { kind: 'inspect-command', command: '   ' } }),
        /命令不能为空/u
      )
      assert.equal(project.launched.length, 0)

      // 脚本在工作目录之外（但在项目里）：命令行里写它的绝对路径。
      const started = await project.start({
        target: { kind: 'node-script', script: 'main.js', args: '--flag' },
        cwd: 'folder',
      })
      assert.equal(
        started.command.replace(/:\d+ /u, ':PORT '),
        `node --inspect-brk=127.0.0.1:PORT ${currentPlatform.quoteShellArg(join(project.root, 'main.js'))} --flag`
      )
      assert.equal((await project.next('ended')).exitCode, 0)
    } finally {
      await project.dispose()
    }
  })

  void test('reports a program that never opens its debug port, and one that exits before attaching', async () => {
    const project = await createDebugTestProject({}, { attachTimeoutMs: 600 })
    try {
      // `--` 之后的开关不归 node：程序照常跑，但没有检查器。
      await project.start({
        target: { kind: 'inspect-command', command: 'node -e "setTimeout(() => {}, 60000)" --' },
      })
      const failed = await project.next('ended')
      assert.deepEqual([failed.reason, failed.exitCode], ['failed', null])
      assert.match(failed.message ?? '', /没有等到程序的调试端口/u)
      // 等不到就把程序结束掉，不留一个没人管的进程。
      await waitFor(() => !isProcessAlive(project.launched[0]!.pid), 'the program to be stopped')

      const { sessionId } = await project.start({
        target: { kind: 'inspect-command', command: 'node -e "process.exit(3)" --' },
      })
      const exited = await project.next('ended')
      assert.deepEqual([exited.reason, exited.exitCode, exited.message], ['exited', 3, null])
      assert.equal(
        project.events.some((event) => event.type === 'attached'),
        false
      )
      await assert.rejects(
        project.sessions.controlDebugSession({ sessionId, action: 'pause' }, 1),
        /调试会话已结束/u
      )
    } finally {
      await project.dispose()
    }
  })
})

/** 一个不会自己结束的程序：还带着一个子进程。 */
const LongRunningScript = [
  "const { spawn } = require('node:child_process')",
  "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })",
  "console.log('child', child.pid)",
  'let ticks = 0',
  'setInterval(function tick() {',
  '  ticks += 1', // 6
  '}, 5)',
  '',
].join('\n')

void describe('controlling a running debug session', () => {
  void test('pauses a running program on request, steps into another file, and evaluates without a frame', async () => {
    const project = await createDebugTestProject({
      'main.js': [
        "const { double } = require('./lib.js')", // 1
        'let ticks = 0', // 2
        'setInterval(function tick() {', // 3
        '  ticks = double(ticks + 1)', // 4
        '}, 5)', // 5
        "console.log('started')", // 6
        '',
      ].join('\n'),
      'lib.js': ['exports.double = function double(n) {', '  return n * 2', '}', ''].join('\n'),
    })
    try {
      const { sessionId } = await project.start({
        target: { kind: 'node-script', script: 'main.js' },
      })
      await project.next('attached')
      const control = (
        action: 'continue' | 'pause' | 'step-into' | 'step-out' | 'step-over'
      ): Promise<void> => project.sessions.controlDebugSession({ sessionId, action }, 1)

      // 等它进了事件循环（只剩定时器在跑）再动手。
      await waitFor(
        () => /^started\r?$/mu.test(project.launched[0]!.output()),
        'the program to start'
      )

      // 程序在跑的时候按单步、继续：没有意义，也不报错，更不会把下一次停下算成「单步」。
      await control('step-over')
      await control('continue')

      await control('pause')
      const paused = await project.next('paused')
      assert.equal(paused.reason, 'pause')
      // 停在程序自己的代码里，不停在 Node 内部的定时器代码里。
      assert.match(frameSummary(paused.frames[0]), /^(?:tick@main\.js:4|double@lib\.js:2)$/u)
      // 已经停着再按暂停：什么也不发生。
      await control('pause')

      // 在这一处下个断点跑过去，好从一个确定的位置开始单步。
      await project.sessions.setBreakpoints(
        { sessionId, breakpoints: [{ path: 'main.js', line: 4 }] },
        1
      )
      await control('continue')
      await project.next('resumed')
      const atCall = await project.next('paused')
      assert.deepEqual(
        [atCall.reason, frameSummary(atCall.frames[0])],
        ['breakpoint', 'tick@main.js:4']
      )

      await control('step-into')
      const inside = await project.next('paused')
      assert.deepEqual([inside.reason, frameSummary(inside.frames[0])], ['step', 'double@lib.js:2'])
      assert.equal(frameSummary(inside.frames[1]), 'tick@main.js:4')
      await control('step-out')
      const outside = await project.next('paused')
      // 调用所在的那一句已经没有可停的地方了：停在它后面（函数的收尾）。
      assert.deepEqual(
        [outside.reason, frameSummary(outside.frames[0])],
        ['step', 'tick@main.js:5']
      )

      // 不给帧：在全局求值，看不到模块里的变量。
      const evaluate = (expression: string, frameId?: string) =>
        project.sessions.evaluate({ sessionId, expression, frameId }, 1)
      assert.equal((await evaluate('typeof process.pid')).value?.text, '"number"')
      assert.equal(
        (await evaluate(`process.execPath === ${JSON.stringify(resolveWorkbenchNodeExecutable())}`))
          .value?.text,
        'true'
      )
      assert.match((await evaluate('ticks')).error ?? '', /ReferenceError: ticks is not defined/u)
      assert.equal((await evaluate('typeof ticks', outside.frames[0]!.id)).value?.text, '"number"')
      // 表达式自己写错了：是一次没求出来的求值，不是调试器的故障。
      assert.match((await evaluate('ticks +', outside.frames[0]!.id)).error ?? '', /SyntaxError/u)

      await project.sessions.stopDebugSession({ sessionId }, 1)
      assert.deepEqual([(await project.next('ended')).reason], ['stopped'])
    } finally {
      await project.dispose()
    }
  })

  void test('stopping ends the program together with the processes it started', async () => {
    const project = await createDebugTestProject({ 'main.js': LongRunningScript })
    try {
      const { sessionId } = await project.start({
        target: { kind: 'node-script', script: 'main.js' },
        breakpoints: [{ path: 'main.js', line: 6 }],
      })
      const paused = await project.next('paused')
      assert.equal(frameSummary(paused.frames[0]), 'tick@main.js:6')
      const childPid = Number(/child (\d+)/u.exec(project.launched[0]!.output())?.[1])
      assert.ok(childPid > 0)
      assert.equal(isProcessAlive(childPid), true)

      // 停在断点上时结束调试。
      await project.sessions.stopDebugSession({ sessionId }, 1)
      const ended = await project.next('ended')
      assert.equal(ended.reason, 'stopped')
      await waitFor(
        () => !isProcessAlive(project.launched[0]!.pid) && !isProcessAlive(childPid),
        'the program and its child to be gone'
      )

      // 已经结束的会话再结束一次不算错；别的命令说它已经结束了。
      await project.sessions.stopDebugSession({ sessionId }, 1)
      await assert.rejects(
        project.sessions.getVariables({ sessionId, objectId: 'x' }, 1),
        /调试会话已结束/u
      )
      assert.equal(project.events.filter((event) => event.type === 'ended').length, 1)
    } finally {
      await project.dispose()
    }
  })

  void test('a session belongs to the window that started it', async () => {
    const project = await createDebugTestProject({ 'main.js': LongRunningScript })
    try {
      const { sessionId } = await project.start(
        {
          target: { kind: 'node-script', script: 'main.js' },
          breakpoints: [{ path: 'main.js', line: 6 }],
        },
        7
      )
      const paused = await project.next('paused')
      const frame = paused.frames[0]!
      const scopeId = frame.scopes[0]!.objectId

      // 别的窗口（8）碰不了它。
      const foreign = 8
      const denied = /调试会话不属于当前项目窗口/u
      await assert.rejects(
        project.sessions.controlDebugSession({ sessionId, action: 'continue' }, foreign),
        denied
      )
      await assert.rejects(
        project.sessions.setBreakpoints({ sessionId, breakpoints: [] }, foreign),
        denied
      )
      await assert.rejects(
        project.sessions.setExceptionPause({ sessionId, uncaught: true }, foreign),
        denied
      )
      await assert.rejects(
        project.sessions.getVariables({ sessionId, objectId: scopeId }, foreign),
        denied
      )
      await assert.rejects(
        project.sessions.evaluate({ sessionId, expression: 'ticks', frameId: frame.id }, foreign),
        denied
      )
      await assert.rejects(project.sessions.stopDebugSession({ sessionId }, foreign), denied)
      // 别的窗口关掉也不影响它：还停在原处，自己的窗口照常读得到变量。
      project.sessions.closeSessionsForOwner(foreign)
      assert.equal(
        (
          await project.sessions.evaluate(
            { sessionId, expression: 'typeof ticks', frameId: frame.id },
            7
          )
        ).value?.text,
        '"number"'
      )
      assert.equal(
        project.events.some((event) => event.type === 'ended'),
        false
      )

      // 自己的窗口关掉：调试器断开，之后的命令都说会话已经结束。（进程由那个窗口的终端会话结束；这里的
      // 测试进程没有终端，由 dispose 收掉。）
      project.sessions.closeSessionsForOwner(7)
      await assert.rejects(
        project.sessions.controlDebugSession({ sessionId, action: 'continue' }, 7),
        /调试会话已结束/u
      )
    } finally {
      await project.dispose()
    }
  })
})
