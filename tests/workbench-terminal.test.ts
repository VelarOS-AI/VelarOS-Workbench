import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path, { join } from 'node:path'

import { describe, test } from 'bun:test'

import { CommandHelper } from '../src/main/workspace/CommandHelper'
import { PathResolver } from '../src/main/workspace/PathResolver'
import {
  buildTerminalEnvironment,
  clampTerminalDimension,
  TerminalSessions,
} from '../src/main/workspace/terminal/TerminalSessions'
import {
  parseLsofCwd,
  readWorkbenchProcessCwd,
} from '../src/main/workspace/terminal/WorkbenchProcessCwd'
import { collectWorkbenchProcessTree } from '../src/main/workspace/terminal/WorkbenchProcessTree'
import type {
  WorkbenchProcessTreeOps,
  WorkbenchPtyExit,
  WorkbenchPtyFactory,
  WorkbenchPtyProcess,
  WorkbenchPtySpawnOptions,
} from '../src/main/workspace/terminal/WorkbenchPty'
import { markWorkbenchTerminalSessionClosed } from '../src/renderer/src/hooks/workbenchCommand/useWorkbenchCommandIpcSubscriptions'
import type { WorkbenchTerminalSessionView } from '../src/renderer/src/models/commands/workbenchCommandLines'
import {
  attachWorkbenchTerminalOutput,
  discardWorkbenchTerminalOutput,
  onWorkbenchTerminalOutputDiscarded,
  publishWorkbenchTerminalOutput,
  readWorkbenchTerminalOutputBacklog,
  setWorkbenchTerminalOutputAcknowledger,
} from '../src/renderer/src/models/commands/workbenchTerminalOutputBus'
import { type WorkbenchTerminalOutputEvent } from '../src/shared/contracts/workbench'

function readSource(relativePath: string): string {
  return readFileSync(path.resolve(process.cwd(), relativePath), 'utf8')
}

class FakePty implements WorkbenchPtyProcess {
  public readonly pid = 4242
  public readonly written: string[] = []
  public readonly sizes: Array<[number, number]> = []
  public readonly signals: string[] = []
  private readonly dataListeners = new Set<(data: string) => void>()
  private readonly exitListeners = new Set<(event: WorkbenchPtyExit) => void>()

  public constructor(
    public readonly file: string,
    public readonly args: string[],
    public readonly options: WorkbenchPtySpawnOptions
  ) {}

  public onData(listener: (data: string) => void): { dispose(): void } {
    this.dataListeners.add(listener)
    return { dispose: () => this.dataListeners.delete(listener) }
  }

  public onExit(listener: (event: WorkbenchPtyExit) => void): { dispose(): void } {
    this.exitListeners.add(listener)
    return { dispose: () => this.exitListeners.delete(listener) }
  }

  public write(data: string): void {
    this.written.push(data)
  }

  public resize(cols: number, rows: number): void {
    this.sizes.push([cols, rows])
  }

  public kill(signal?: string): void {
    this.signals.push(signal ?? 'default')
  }

  public readonly flow: string[] = []

  public pause(): void {
    this.flow.push('pause')
  }

  public resume(): void {
    this.flow.push('resume')
  }

  public emit(data: string): void {
    for (const listener of this.dataListeners) listener(data)
  }

  public exit(exitCode: number, signal?: number): void {
    for (const listener of this.exitListeners) listener({ exitCode, signal })
  }
}

function createFakeFactory(
  processTree?: WorkbenchProcessTreeOps,
  readCwd?: WorkbenchPtyFactory['readCwd']
): {
  factory: WorkbenchPtyFactory
  spawned: FakePty[]
} {
  const spawned: FakePty[] = []
  return {
    spawned,
    factory: {
      spawn: (file, args, options) => {
        const pty = new FakePty(file, args, options)
        spawned.push(pty)
        return pty
      },
      processTree: processTree ?? { list: async (pid) => [pid], signal: () => undefined },
      readCwd: readCwd ?? (async () => null),
    },
  }
}

async function settle(ms = 30): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

void describe('terminal sessions on a pseudo-terminal', () => {
  void test('spawns an interactive shell with a terminal environment and batches its output', async () => {
    const projectRoot = await realpath(await mkdtemp(join(tmpdir(), 'workbench-terminal-')))
    const { factory, spawned } = createFakeFactory()
    const terminal = new TerminalSessions(new PathResolver(), new CommandHelper(), factory)
    const events: WorkbenchTerminalOutputEvent[] = []
    try {
      const session = await terminal.startTerminalSession(
        { projectRoot, cols: 132, rows: 40 },
        (event) => events.push(event),
        7
      )
      const pty = spawned[0]!
      assert.equal(session.shell, pty.file)
      assert.deepEqual([pty.options.cols, pty.options.rows], [132, 40])
      assert.equal(pty.options.name, 'xterm-256color')
      assert.equal(pty.options.env.TERM, 'xterm-256color')
      assert.equal(pty.options.env.VELAROS_WORKBENCH_TERMINAL, '1')
      assert.equal(pty.options.cwd, projectRoot)

      // 小片段合并成一条事件；到达顺序保持。
      pty.emit('a')
      pty.emit('b')
      pty.emit('c')
      assert.deepEqual(events, [])
      await settle()
      assert.deepEqual(
        events.map((event) => [event.stream, event.chunk]),
        [['stdout', 'abc']]
      )

      terminal.writeTerminalInput({ sessionId: session.sessionId, input: 'ls\r' }, 7)
      terminal.resizeTerminalSession({ sessionId: session.sessionId, cols: 80, rows: 24 }, 7)
      assert.deepEqual(pty.written, ['ls\r'])
      assert.deepEqual(pty.sizes, [[80, 24]])

      // Ctrl+C 是往终端里写 ETX，不是杀进程。
      await terminal.stopTerminalSession({ sessionId: session.sessionId, signal: 'SIGINT' }, 7)
      assert.equal(pty.written.at(-1), String.fromCharCode(3))
      assert.deepEqual(pty.signals, [])

      // 退出：先把攒着的输出送完，再发收口事件。
      pty.emit('bye')
      pty.exit(0)
      await settle()
      assert.equal(events.at(-2)?.chunk, 'bye')
      assert.equal(events.at(-1)?.closed, true)
      assert.match(events.at(-1)?.chunk ?? '', /^\r\n进程已结束（exit=0 signal=-）\r\n$/u)
      assert.throws(
        () => terminal.writeTerminalInput({ sessionId: session.sessionId, input: 'x' }, 7),
        /已结束/u
      )

      // 真的伪终端正常退出时报的信号是 0，不是「被 0 号信号结束」；被信号结束的照实写。
      const exits: WorkbenchTerminalOutputEvent[] = []
      await terminal.startTerminalSession({ projectRoot }, (event) => exits.push(event), 7)
      spawned[1]!.exit(0, 0)
      await terminal.startTerminalSession({ projectRoot }, (event) => exits.push(event), 7)
      spawned[2]!.exit(143, 15)
      const closed = exits.filter((event) => event.closed)
      assert.deepEqual(
        closed.map((event) => [event.chunk.trim(), event.signal]),
        [
          ['进程已结束（exit=0 signal=-）', undefined],
          ['进程已结束（exit=143 signal=15）', '15'],
        ]
      )
    } finally {
      await terminal.closeAllSessions()
      await rm(projectRoot, { recursive: true, force: true })
    }
  })

  void test('runs a one-shot command through the shell, enforces window ownership, and force-kills on stop', async () => {
    const projectRoot = await realpath(await mkdtemp(join(tmpdir(), 'workbench-terminal-run-')))
    const { factory, spawned } = createFakeFactory()
    const helper = new CommandHelper()
    const terminal = new TerminalSessions(new PathResolver(), helper, factory)
    try {
      const run = await terminal.startTerminalSession(
        { projectRoot, initialCommand: 'bun run dev' },
        () => undefined,
        1
      )
      const pty = spawned[0]!
      assert.deepEqual(
        [pty.file, pty.args],
        [helper.getShellSpec('bun run dev').file, helper.getShellSpec('bun run dev').args]
      )

      assert.throws(
        () => terminal.writeTerminalInput({ sessionId: run.sessionId, input: 'q' }, 2),
        /不属于当前项目窗口/u
      )

      await terminal.stopTerminalSession({ sessionId: run.sessionId }, 1)
      assert.deepEqual(pty.signals, ['SIGTERM'])
      await settle(helper.getForceKillDelayMs() + 50)
      assert.deepEqual(pty.signals, ['SIGTERM', 'SIGKILL'])

      pty.exit(143, 15)
      await terminal.closeSessionsForOwner(1)
    } finally {
      await terminal.closeAllSessions()
      await rm(projectRoot, { recursive: true, force: true })
    }
  })

  void test('a run configuration reaches the process with its working directory and variables', async () => {
    const projectRoot = await realpath(await mkdtemp(join(tmpdir(), 'workbench-terminal-env-')))
    await mkdir(join(projectRoot, 'packages', 'api'), { recursive: true })
    const { factory, spawned } = createFakeFactory()
    const terminal = new TerminalSessions(new PathResolver(), new CommandHelper(), factory)
    try {
      const run = await terminal.startTerminalSession(
        {
          projectRoot,
          initialCommand: 'bun run dev',
          cwd: 'packages/api',
          env: { PORT: '4100', TERM: 'dumb', EMPTY: '' },
        },
        () => undefined,
        1
      )
      const pty = spawned[0]!
      assert.equal(run.cwd, join(projectRoot, 'packages', 'api'))
      assert.equal(pty.options.cwd, join(projectRoot, 'packages', 'api'))
      assert.equal(pty.options.env.PORT, '4100')
      assert.equal(pty.options.env.EMPTY, '')
      // 用户明确写的值盖过终端自己设的；没写的照旧。
      assert.equal(pty.options.env.TERM, 'dumb')
      assert.equal(pty.options.name, 'dumb')
      assert.equal(pty.options.env.COLORTERM, 'truecolor')
      // Windows 的 process.env 忽略键名大小写，复制给 PTY 的普通对象保留原始拼写。
      const pathKey = Object.keys(process.env).find((key) =>
        process.platform === 'win32' ? key.toUpperCase() === 'PATH' : key === 'PATH'
      )
      assert.ok(pathKey)
      assert.equal(pty.options.env[pathKey], process.env[pathKey])

      // 不带变量的会话不受前一个会话影响。
      await terminal.startTerminalSession({ projectRoot }, () => undefined, 1)
      assert.equal(spawned[1]!.options.env.PORT, process.env.PORT)
      assert.equal(spawned[1]!.options.env.TERM, 'xterm-256color')

      await assert.rejects(
        terminal.startTerminalSession(
          { projectRoot, cwd: '../outside', env: { A: '1' } },
          () => undefined,
          1
        ),
        /超出工程范围/u
      )
    } finally {
      await terminal.closeAllSessions()
      await rm(projectRoot, { recursive: true, force: true })
    }
  })

  void test('stops the whole process tree and can wait until the process has exited', async () => {
    const projectRoot = await realpath(await mkdtemp(join(tmpdir(), 'workbench-terminal-tree-')))
    const signalled: string[] = []
    const { factory, spawned } = createFakeFactory({
      list: async (rootPid) => [rootPid, 5001, 5002],
      signal: async (pids, signal) => {
        await settle(25)
        signalled.push(`${signal}:${pids.join(',')}`)
      },
    })
    const helper = new CommandHelper()
    const terminal = new TerminalSessions(new PathResolver(), helper, factory)
    try {
      const run = await terminal.startTerminalSession(
        { projectRoot, initialCommand: 'bun run dev' },
        () => undefined,
        1
      )
      const pty = spawned[0]!
      let stopped = false
      const stopping = terminal
        .stopTerminalSession({ sessionId: run.sessionId, waitForExit: true }, 1)
        .then(() => (stopped = true))
      await settle(10)
      assert.deepEqual(pty.signals, [], 'PTY must wait for asynchronous tree termination')
      await settle(30)
      assert.deepEqual(signalled, ['SIGTERM:4242,5001,5002'])
      assert.deepEqual(pty.signals, ['SIGTERM'])
      assert.equal(stopped, false)
      pty.exit(143, 15)
      await stopping
      assert.equal(stopped, true)
      await settle(helper.getForceKillDelayMs() + 50)
      // shell 先退了，树上剩下的进程照样被强杀；伪终端本身不再重复强杀。
      assert.deepEqual(signalled, ['SIGTERM:4242,5001,5002', 'SIGKILL:4242,5001,5002'])
      assert.deepEqual(pty.signals, ['SIGTERM'])
    } finally {
      await terminal.closeAllSessions()
      await rm(projectRoot, { recursive: true, force: true })
    }
  })

  for (const mode of ['stop', 'close', 'snapshot', 'pty'] as const) {
    void test(`terminal ${mode} failures are reported while mandatory cleanup continues`, async () => {
      const projectRoot = await realpath(await mkdtemp(join(tmpdir(), 'terminal-failure-')))
      const failure = new Error('injected termination failure')
      const logs: unknown[][] = []
      const unhandled: unknown[] = []
      const originalError = console.error
      const onUnhandled = (error: unknown): void => {
        unhandled.push(error)
      }
      console.error = (...args: unknown[]) => {
        logs.push(args)
      }
      process.on('unhandledRejection', onUnhandled)
      const { factory, spawned } = createFakeFactory({
        list: async (pid) => {
          if (mode === 'snapshot') throw failure
          return [pid]
        },
        signal: async () => {
          if (mode !== 'snapshot' && mode !== 'pty') throw failure
        },
      })
      const helper = new CommandHelper()
      helper.getForceKillDelayMs = () => 10
      const terminal = new TerminalSessions(new PathResolver(), helper, factory)
      try {
        const run = await terminal.startTerminalSession({ projectRoot }, () => undefined, 1)
        const pty = spawned[0]!
        if (mode === 'pty') {
          pty.kill = (signal) => {
            pty.signals.push(signal!)
            throw failure
          }
        }
        if (mode === 'close') {
          await terminal.startTerminalSession({ projectRoot }, () => undefined, 1)
          await assert.rejects(terminal.closeAllSessions(), AggregateError)
        } else {
          await assert.rejects(
            terminal.stopTerminalSession({ sessionId: run.sessionId }),
            AggregateError
          )
        }
        await settle(60)
        for (const process of spawned) assert.deepEqual(process.signals, ['SIGTERM', 'SIGKILL'])
        assert.deepEqual(unhandled, [])
        assert.ok(
          logs.some(([message]) =>
            String(message).includes(
              mode === 'snapshot'
                ? 'snapshot failed'
                : mode === 'pty'
                  ? 'PTY signal failed'
                  : 'process tree signal failed'
            )
          )
        )
        assert.ok(logs.some(([, detail]) => (detail as { error: unknown }).error === failure))
        if (mode !== 'snapshot')
          assert.ok(logs.some(([, detail]) => (detail as { signal?: string }).signal === 'SIGKILL'))
      } finally {
        for (const pty of spawned) pty.exit(1)
        await terminal.closeAllSessions()
        console.error = originalError
        process.off('unhandledRejection', onUnhandled)
        await rm(projectRoot, { recursive: true, force: true })
      }
    })
  }

  void test('reports the shell current directory only to its owning window', async () => {
    const projectRoot = await realpath(await mkdtemp(join(tmpdir(), 'workbench-terminal-cwd-')))
    const outside = await realpath(await mkdtemp(join(tmpdir(), 'workbench-terminal-outside-')))
    const nested = join(projectRoot, 'packages', '应用')
    await mkdir(nested, { recursive: true })
    let shellCwd: Nullable<string> = nested
    const asked: number[] = []
    const { factory, spawned } = createFakeFactory(undefined, async (pid) => {
      asked.push(pid)
      return shellCwd
    })
    const terminal = new TerminalSessions(new PathResolver(), new CommandHelper(), factory)
    const start = (request: { cwd?: string }, ownerId = 1) =>
      terminal.startTerminalSession({ projectRoot, ...request }, () => undefined, ownerId)
    try {
      const first = await start({})
      assert.equal(first.cwd, projectRoot)
      assert.deepEqual(asked, [])

      assert.equal((await start({ cwd: 'packages' })).cwd, join(projectRoot, 'packages'))
      assert.equal(spawned[1]!.options.cwd, join(projectRoot, 'packages'))
      assert.deepEqual(asked, [])

      // 终端输出里的相对路径按 shell 此刻所在的目录解析：窗口问自己的会话问得到，项目外面的目录也照实给。
      assert.deepEqual(await terminal.readTerminalCwd({ sessionId: first.sessionId }, 1), {
        cwd: nested,
      })
      shellCwd = outside
      assert.deepEqual(await terminal.readTerminalCwd({ sessionId: first.sessionId }, 1), {
        cwd: outside,
      })
      shellCwd = null
      assert.deepEqual(await terminal.readTerminalCwd({ sessionId: first.sessionId }, 1), {
        cwd: null,
      })
      await assert.rejects(
        terminal.readTerminalCwd({ sessionId: first.sessionId }, 2),
        /不属于当前项目窗口/u
      )
      assert.deepEqual(await terminal.readTerminalCwd({ sessionId: 'terminal-missing' }, 1), {
        cwd: null,
      })
    } finally {
      await terminal.closeAllSessions()
      await rm(projectRoot, { recursive: true, force: true })
      await rm(outside, { recursive: true, force: true })
    }
  })

  void test('reads the directory a process is in from the operating system', async () => {
    // lsof 在认不出字符集时把非 ASCII 字节写成 \xNN，反斜杠写成两个。
    assert.equal(
      parseLsofCwd('p4242\nfcwd\nn/tmp/\\xe4\\xb8\\xad\\xe6\\x96\\x87 dir/back\\\\slash^caret\n'),
      '/tmp/中文 dir/back\\slash^caret'
    )
    assert.equal(parseLsofCwd('p4242\nfcwd\nn/Users/me/项目\n'), '/Users/me/项目')
    assert.equal(parseLsofCwd('p4242\n'), null)
    assert.equal(parseLsofCwd(''), null)

    if (process.platform === 'win32') {
      assert.equal(await readWorkbenchProcessCwd(process.pid), null)
      return
    }
    assert.equal(await readWorkbenchProcessCwd(process.pid), await realpath(process.cwd()))
    // 不存在的进程问不到，不报错。
    assert.equal(await readWorkbenchProcessCwd(2 ** 22 + 12_345), null)
  })

  void test('pauses reading when the renderer falls behind and resumes once it catches up', async () => {
    const projectRoot = await realpath(await mkdtemp(join(tmpdir(), 'workbench-terminal-flow-')))
    const { factory, spawned } = createFakeFactory()
    const terminal = new TerminalSessions(new PathResolver(), new CommandHelper(), factory)
    try {
      const session = await terminal.startTerminalSession({ projectRoot }, () => undefined, 3)
      const pty = spawned[0]!
      pty.emit('y\n'.repeat(40_000))
      await settle()
      assert.deepEqual(pty.flow, [])
      pty.emit('y\n'.repeat(40_000))
      await settle()
      assert.deepEqual(pty.flow, ['pause'])

      terminal.acknowledgeTerminalOutput({ sessionId: session.sessionId, chars: 120_000 }, 3)
      assert.deepEqual(pty.flow, ['pause'])
      terminal.acknowledgeTerminalOutput({ sessionId: session.sessionId, chars: 40_000 }, 3)
      assert.deepEqual(pty.flow, ['pause', 'resume'])
      assert.throws(
        () => terminal.acknowledgeTerminalOutput({ sessionId: session.sessionId, chars: 1 }, 4),
        /不属于当前项目窗口/u
      )
    } finally {
      await terminal.closeAllSessions()
      await rm(projectRoot, { recursive: true, force: true })
    }
  })

  void test('finds every descendant of the shell in the process table', () => {
    const table = [
      '  1     0',
      ' 100     1',
      ' 200   100',
      ' 201   100',
      ' 300   200',
      ' 999     1',
      '',
    ].join('\n')
    assert.deepEqual(collectWorkbenchProcessTree(table, 100), [100, 200, 201, 300])
    assert.deepEqual(collectWorkbenchProcessTree(table, 4242), [4242])
  })

  void test('surfaces a missing terminal backend as a platform error instead of crashing', async () => {
    const projectRoot = await realpath(await mkdtemp(join(tmpdir(), 'workbench-terminal-missing-')))
    const { factory } = createFakeFactory()
    factory.spawn = () => {
      throw new Error('no prebuilt binary')
    }
    const terminal = new TerminalSessions(new PathResolver(), new CommandHelper(), factory)
    try {
      await assert.rejects(
        terminal.startTerminalSession({ projectRoot }, () => undefined),
        (error: { code?: string; message: string }) =>
          error.code === 'PLATFORM' && /no prebuilt binary/u.test(error.message)
      )
    } finally {
      await rm(projectRoot, { recursive: true, force: true })
    }
  })

  void test('gives the shell a UTF-8 locale when the launcher had none, and clamps sizes', () => {
    assert.equal(buildTerminalEnvironment({}, 'darwin').LANG, 'en_US.UTF-8')
    assert.equal(buildTerminalEnvironment({ LC_ALL: 'C.UTF-8' }, 'linux').LANG, undefined)
    assert.equal(buildTerminalEnvironment({}, 'win32').LANG, undefined)
    assert.equal(buildTerminalEnvironment({}, 'darwin').COLORTERM, 'truecolor')
    // 运行配置的变量最后盖上去；Windows 上变量名不分大小写，不留下两份。
    assert.equal(
      buildTerminalEnvironment({ LANG: 'C' }, 'darwin', { LANG: 'zh_CN.UTF-8' }).LANG,
      'zh_CN.UTF-8'
    )
    assert.deepEqual(
      Object.entries(
        buildTerminalEnvironment({ Path: 'C:\\old' }, 'win32', { PATH: 'C:\\new' })
      ).filter(([name]) => name.toUpperCase() === 'PATH'),
      [['PATH', 'C:\\new']]
    )
    assert.deepEqual(
      Object.entries(buildTerminalEnvironment({ Path: '/old' }, 'linux', { PATH: '/new' })).filter(
        ([name]) => name.toUpperCase() === 'PATH'
      ),
      [
        ['Path', '/old'],
        ['PATH', '/new'],
      ]
    )
    assert.equal(clampTerminalDimension(Number.NaN, 80, 1000), 80)
    assert.equal(clampTerminalDimension(12.7, 80, 1000), 12)
    assert.equal(clampTerminalDimension(-3, 80, 1000), 1)
  })
})

void describe('terminal output on the renderer side', () => {
  void test('buffers output until the xterm attaches, then replays once and streams live', () => {
    const received: string[] = []
    publishWorkbenchTerminalOutput('s1', 'hel')
    publishWorkbenchTerminalOutput('s1', 'lo')
    assert.equal(readWorkbenchTerminalOutputBacklog('s1'), 5)

    const detach = attachWorkbenchTerminalOutput('s1', (chunk) => received.push(chunk))
    assert.deepEqual(received, ['hello'])
    assert.equal(readWorkbenchTerminalOutputBacklog('s1'), 0)

    publishWorkbenchTerminalOutput('s1', ' world')
    assert.deepEqual(received, ['hello', ' world'])

    detach()
    publishWorkbenchTerminalOutput('s1', '!')
    assert.deepEqual(received, ['hello', ' world'])
    assert.equal(readWorkbenchTerminalOutputBacklog('s1'), 1)

    const discarded: string[] = []
    const stop = onWorkbenchTerminalOutputDiscarded((sessionId) => discarded.push(sessionId))
    discardWorkbenchTerminalOutput('s1')
    assert.deepEqual(discarded, ['s1'])
    assert.equal(readWorkbenchTerminalOutputBacklog('s1'), 0)
    stop()
  })

  void test('acknowledges output after xterm writes it, right away while nothing shows it, in batches', async () => {
    const acknowledged: Array<[string, number]> = []
    setWorkbenchTerminalOutputAcknowledger((sessionId, chars) =>
      acknowledged.push([sessionId, chars])
    )
    try {
      publishWorkbenchTerminalOutput('s3', 'x'.repeat(6_000))
      assert.deepEqual(acknowledged, [['s3', 6_000]])

      const writes: Array<() => void> = []
      attachWorkbenchTerminalOutput('s3', (_chunk, done) => writes.push(done))
      // 回放攒下的输出不再重复确认。
      writes.shift()!()
      publishWorkbenchTerminalOutput('s3', 'y'.repeat(100))
      assert.deepEqual(acknowledged, [['s3', 6_000]])
      writes.shift()!()
      assert.deepEqual(acknowledged, [['s3', 6_000]])
      await new Promise((resolve) => setTimeout(resolve, 40))
      assert.deepEqual(acknowledged, [
        ['s3', 6_000],
        ['s3', 100],
      ])
    } finally {
      discardWorkbenchTerminalOutput('s3')
      setWorkbenchTerminalOutputAcknowledger(null)
    }
  })

  void test('caps the backlog so a chatty process cannot grow memory unbounded', () => {
    const big = 'x'.repeat(300 * 1024)
    publishWorkbenchTerminalOutput('s2', big)
    publishWorkbenchTerminalOutput('s2', big)
    publishWorkbenchTerminalOutput('s2', 'tail')
    assert.ok(readWorkbenchTerminalOutputBacklog('s2') <= 512 * 1024 + 4)
    const received: string[] = []
    attachWorkbenchTerminalOutput('s2', (chunk) => received.push(chunk))
    assert.ok(received[0]?.endsWith('tail'))
    discardWorkbenchTerminalOutput('s2')
  })

  void test('a closed session stops running once, and repeated close events change nothing', () => {
    const session: WorkbenchTerminalSessionView = {
      id: 'run',
      title: 'dev',
      shell: '/bin/zsh',
      cwd: '/p',
      isRunning: true,
      command: 'bun run dev',
    }
    const closed = markWorkbenchTerminalSessionClosed([session], 'run')
    assert.equal(closed[0]?.isRunning, false)
    assert.equal(markWorkbenchTerminalSessionClosed(closed, 'run'), closed)
    const untouched = [session]
    assert.equal(markWorkbenchTerminalSessionClosed(untouched, 'other'), untouched)
  })

  void test('the panels render xterm instead of a line list with a fake prompt', () => {
    const chrome = readSource(
      'src/renderer/src/components/terminal/WorkbenchTerminalToolChrome.tsx'
    )
    assert.match(chrome, /LazyWorkbenchTerminalView/u)
    assert.doesNotMatch(
      chrome,
      /formatWorkbenchTerminalPrompt|terminalPromptInput|onRunTerminalInput/u
    )
    const view = readSource('src/renderer/src/components/terminal/WorkbenchTerminalView.tsx')
    assert.match(view, /new ResizeObserver\(scheduleFit\)/u)
    const instances = readSource(
      'src/renderer/src/components/terminal/workbenchTerminalInstances.ts'
    )
    assert.match(instances, /terminal\.unicode\.activeVersion = '11'/u)
    assert.match(instances, /entry\.handlers\.onData\(data\)/u)
    const builder = readSource('electron-builder.yml')
    assert.match(builder, /asarUnpack:\n {2}- node_modules\/@lydell\/\*\*/u)
    const vite = readSource('electron.vite.config.ts')
    assert.match(vite, /\/\^@lydell\\\/node-pty\/u/u)
  })
})
