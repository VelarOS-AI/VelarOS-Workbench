import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
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
import type {
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
} from '../src/renderer/src/models/commands/workbenchTerminalOutputBus'
import type { WorkbenchTerminalOutputEvent } from '../src/shared/contracts'

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

  public emit(data: string): void {
    for (const listener of this.dataListeners) listener(data)
  }

  public exit(exitCode: number, signal?: number): void {
    for (const listener of this.exitListeners) listener({ exitCode, signal })
  }
}

function createFakeFactory(): { factory: WorkbenchPtyFactory; spawned: FakePty[] } {
  const spawned: FakePty[] = []
  return {
    spawned,
    factory: {
      spawn: (file, args, options) => {
        const pty = new FakePty(file, args, options)
        spawned.push(pty)
        return pty
      },
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
      assert.deepEqual(events.map((event) => [event.stream, event.chunk]), [['stdout', 'abc']])

      terminal.writeTerminalInput({ sessionId: session.sessionId, input: 'ls\r' }, 7)
      terminal.resizeTerminalSession({ sessionId: session.sessionId, cols: 80, rows: 24 }, 7)
      assert.deepEqual(pty.written, ['ls\r'])
      assert.deepEqual(pty.sizes, [[80, 24]])

      // Ctrl+C 是往终端里写 ETX，不是杀进程。
      terminal.stopTerminalSession({ sessionId: session.sessionId, signal: 'SIGINT' }, 7)
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
      assert.deepEqual([pty.file, pty.args], [helper.getShellSpec('bun run dev').file, helper.getShellSpec('bun run dev').args])

      assert.throws(
        () => terminal.writeTerminalInput({ sessionId: run.sessionId, input: 'q' }, 2),
        /不属于当前项目窗口/u
      )

      terminal.stopTerminalSession({ sessionId: run.sessionId }, 1)
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

  void test('surfaces a missing terminal backend as a platform error instead of crashing', async () => {
    const projectRoot = await realpath(await mkdtemp(join(tmpdir(), 'workbench-terminal-missing-')))
    const terminal = new TerminalSessions(new PathResolver(), new CommandHelper(), {
      spawn: () => {
        throw new Error('no prebuilt binary')
      },
    })
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
    const chrome = readSource('src/renderer/src/components/terminal/WorkbenchTerminalToolChrome.tsx')
    assert.match(chrome, /LazyWorkbenchTerminalView/u)
    assert.doesNotMatch(chrome, /formatWorkbenchTerminalPrompt|terminalPromptInput|onRunTerminalInput/u)
    const view = readSource('src/renderer/src/components/terminal/WorkbenchTerminalView.tsx')
    assert.match(view, /new ResizeObserver\(scheduleFit\)/u)
    const instances = readSource('src/renderer/src/components/terminal/workbenchTerminalInstances.ts')
    assert.match(instances, /terminal\.unicode\.activeVersion = '11'/u)
    assert.match(instances, /terminal\.onData\(\(data\) => entry\.handlers\.onData\(data\)\)/u)
    const builder = readSource('electron-builder.yml')
    assert.match(builder, /asarUnpack:\n {2}- node_modules\/@lydell\/\*\*/u)
    const vite = readSource('electron.vite.config.ts')
    assert.match(vite, /\/\^@lydell\\\/node-pty\/u/u)
  })
})
