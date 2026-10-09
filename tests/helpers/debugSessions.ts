import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { CommandHelper } from '../../src/main/workspace/CommandHelper'
import type {
  WorkbenchDebugLauncher,
  WorkbenchDebugProcessExit,
} from '../../src/main/workspace/debug/WorkbenchDebugLaunch'
import { WorkbenchDebugSessions } from '../../src/main/workspace/debug/WorkbenchDebugSessions'
import { PathResolver } from '../../src/main/workspace/PathResolver'
import { signalWorkbenchProcesses } from '../../src/main/workspace/terminal/WorkbenchProcessTree'
import type {
  WorkbenchDebuggerEvent,
  WorkbenchDebuggerFrame,
  WorkbenchDebuggerStartRequest,
  WorkbenchDebuggerStartResult,
  WorkbenchDebuggerVariable,
} from '../../src/shared/workbenchDebugger'

type DebuggerEventOf<TType extends WorkbenchDebuggerEvent['type']> = Extract<
  WorkbenchDebuggerEvent,
  { type: TType }
>

/**
 * 测试里起被调试程序的办法：直接起一个真的子进程（经 shell，与运行卡一样是一条命令行），输出攒在内存里。
 * 应用里它跑在伪终端上；node-pty 在 bun 下收不到数据，那条路由探针在 Electron 运行时里验。
 */
export function createProcessDebugLauncher(): {
  launcher: WorkbenchDebugLauncher
  /** 每个起过的进程：命令行、输出、进程号。 */
  launched: Array<{ command: string; cwd: string; env: NodeJS.ProcessEnv; pid: number; output: () => string; disposePipes: () => void }>
} {
  const launched: ReturnType<typeof createProcessDebugLauncher>['launched'] = []
  let nextId = 1

  const launcher: WorkbenchDebugLauncher = async (options) => {
    const env = { ...process.env, ...options.env }
    const helper = new CommandHelper()
    const spec = helper.getShellSpec(options.command)
    const child = spawn(spec.file, spec.args, {
      cwd: options.cwd,
      env,
      // 独立的进程组：停止时连它派生的进程一起结束。
      detached: helper.shouldDetachForegroundProcess(),
      windowsVerbatimArguments: spec.windowsVerbatimArguments,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    let exit: Nullable<WorkbenchDebugProcessExit> = null
    let forceKillTimer: ReturnType<typeof setTimeout> | undefined
    const exitListeners: Array<(exit: WorkbenchDebugProcessExit) => void> = []
    child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString('utf8')))
    child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString('utf8')))
    child.once('exit', (exitCode) => {
      clearTimeout(forceKillTimer)
      exit = { exitCode }
      for (const listener of exitListeners.splice(0)) listener(exit)
    })
    launched.push({
      command: options.command, cwd: options.cwd, env, pid: child.pid!, output: () => output,
      disposePipes: () => { child.stdout.destroy(); child.stderr.destroy() },
    })

    const signalGroup = (signal: NodeJS.Signals): void => {
      try {
        if (process.platform === 'win32') signalWorkbenchProcesses([child.pid!], signal)
        else process.kill(-child.pid!, signal)
      } catch {
        // arch-guard:silent-catch-ok 进程组已经不在了（ESRCH）。
      }
    }
    return {
      terminalSessionId: `terminal-test-${nextId++}`,
      shell: spec.file,
      cwd: options.cwd,
      onExit: (listener) => {
        if (exit) listener(exit)
        else exitListeners.push(listener)
      },
      stop: () =>
        new Promise<void>((resolve) => {
          if (exit) {
            resolve()
            return
          }
          exitListeners.push(() => resolve())
          // 等待结束的承诺必须维持事件循环；Windows 管道的 close 可能晚于进程退出。
          forceKillTimer = setTimeout(() => signalGroup('SIGKILL'), 1_000)
          signalGroup('SIGTERM')
        }),
    }
  }

  return { launcher, launched }
}

export interface DebugTestProject {
  root: string
  sessions: WorkbenchDebugSessions
  launched: ReturnType<typeof createProcessDebugLauncher>['launched']
  events: WorkbenchDebuggerEvent[]
  start: (
    request: Omit<WorkbenchDebuggerStartRequest, 'projectRoot' | 'breakpoints' | 'pauseOnUncaughtExceptions'> &
      Partial<Pick<WorkbenchDebuggerStartRequest, 'breakpoints' | 'pauseOnUncaughtExceptions'>>,
    ownerId?: Nullable<number>
  ) => Promise<WorkbenchDebuggerStartResult>
  /** 等下一个这种事件（从上次等到的位置往后找）；等不到就带着已经收到的事件报错。 */
  next: <TType extends WorkbenchDebuggerEvent['type']>(
    type: TType,
    timeoutMs?: number
  ) => Promise<DebuggerEventOf<TType>>
  /** 等程序下一次停下或者结束，哪个先来算哪个。 */
  nextStop: (timeoutMs?: number) => Promise<DebuggerEventOf<'paused'> | DebuggerEventOf<'ended'>>
  dispose: () => Promise<void>
}

/** 一个临时项目（写好给定的文件）加上一套调试会话服务。 */
export async function createDebugTestProject(
  files: Readonly<Record<string, string>>,
  options: { attachTimeoutMs?: number } = {}
): Promise<DebugTestProject> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'workbench-debugger-')))
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true })
    await writeFile(join(root, path), content)
  }

  const { launcher, launched } = createProcessDebugLauncher()
  const sessions = new WorkbenchDebugSessions(new PathResolver(), launcher, options.attachTimeoutMs)
  const events: WorkbenchDebuggerEvent[] = []
  let cursor = 0
  const waitForEvent = async (
    types: ReadonlyArray<WorkbenchDebuggerEvent['type']>,
    timeoutMs: number
  ): Promise<WorkbenchDebuggerEvent> => {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const index = events.findIndex(
        (event, position) => position >= cursor && types.includes(event.type)
      )
      if (index !== -1) {
        cursor = index + 1
        return events[index]!
      }
      if (Date.now() > deadline)
        throw new Error(
          `no "${types.join('" / "')}" event within ${timeoutMs} ms; got ${JSON.stringify(events.slice(cursor))}\n` +
            `output: ${launched.map((item) => item.output()).join('\n---\n')}`
        )
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
  }

  return {
    root,
    sessions,
    launched,
    events,
    start: (request, ownerId = 1) =>
      sessions.startDebugSession(
        { projectRoot: root, breakpoints: [], pauseOnUncaughtExceptions: false, ...request },
        { emit: (event) => events.push(event), terminalOutput: () => undefined },
        ownerId
      ),
    next: async (type, timeoutMs = 15_000) =>
      (await waitForEvent([type], timeoutMs)) as DebuggerEventOf<typeof type>,
    nextStop: async (timeoutMs = 15_000) =>
      (await waitForEvent(['paused', 'ended'], timeoutMs)) as
        | DebuggerEventOf<'paused'>
        | DebuggerEventOf<'ended'>,
    dispose: async () => {
      sessions.closeAllSessions()
      for (const item of launched) {
        try {
          if (process.platform === 'win32') signalWorkbenchProcesses([item.pid], 'SIGKILL')
          else process.kill(-item.pid, 'SIGKILL')
        } catch {
          // arch-guard:silent-catch-ok 进程组已经退出。
        }
      }
      // Bun 在 Windows 上结束 shell 后可能不发管道 close；进程树已停止，显式释放读取端。
      for (const item of launched) item.disposePipes()
      // Windows 释放工作目录句柄会晚于进程退出；Bun 的 rm 不保证执行 maxRetries。
      for (let attempt = 0; ; attempt += 1) {
        try {
          await rm(root, { recursive: true, force: true })
          break
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code
          if (
            process.platform !== 'win32' || attempt >= 20 ||
            !['EBUSY', 'ENOTEMPTY', 'EPERM', 'EACCES'].includes(code ?? '')
          ) throw error
          await new Promise((resolve) => setTimeout(resolve, 100))
        }
      }
    },
  }
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    // arch-guard:silent-catch-ok ESRCH：进程已经不在了。
    return false
  }
}

/** 一帧里某个作用域的变量：名字 → 值。 */
export async function variablesOf(
  project: DebugTestProject,
  sessionId: string,
  frame: WorkbenchDebuggerFrame,
  scopeType: string
): Promise<Record<string, WorkbenchDebuggerVariable['value']>> {
  const scope = frame.scopes.find((candidate) => candidate.type === scopeType)
  if (!scope) throw new Error(`frame should have a ${scopeType} scope`)
  const { variables } = await project.sessions.getVariables({ sessionId, objectId: scope.objectId }, 1)
  return Object.fromEntries(variables.map((variable) => [variable.name, variable.value]))
}

/** `函数名@项目里的文件:行`，匿名函数写 `(anonymous)`。 */
export function frameSummary(frame: LooseOptional<WorkbenchDebuggerFrame>): string {
  return `${frame?.functionName || '(anonymous)'}@${frame?.location.path}:${frame?.location.line}`
}
