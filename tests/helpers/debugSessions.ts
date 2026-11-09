import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'

import { currentPlatform } from '@velaros-ai/velaros/core/platform'

import { resolveWorkbenchNodeExecutable } from '../../src/main/conversation/WorkbenchNodeRuntime'
import {
  buildWorkbenchDebugLaunchPlan,
  type WorkbenchDebugLauncher,
  type WorkbenchDebugProcessExit,
} from '../../src/main/workspace/debug/WorkbenchDebugLaunch'
import { WorkbenchDebugSessions } from '../../src/main/workspace/debug/WorkbenchDebugSessions'
import { PathResolver } from '../../src/main/workspace/PathResolver'
import {
  listWorkbenchProcessTree,
  signalWorkbenchProcesses,
} from '../../src/main/workspace/terminal/WorkbenchProcessTree'
import type { WorkbenchCliQuery } from '../../src/main/workspace/WorkbenchProcessLaunch'
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

/** 查询请求结束后仍保留资源，直到真实 closed；未关闭的查询让夹具清理明确失败。 */
export function createDebugCliQueryOwner(): {
  registerCliQuery(query: WorkbenchCliQuery): void
  closeQueries(): Promise<void>
} {
  const queries = new Set<WorkbenchCliQuery>()
  const registerCliQuery = (query: WorkbenchCliQuery): void => {
    queries.add(query)
    void query.closed.then(() => queries.delete(query))
  }
  const closeQueries = async (): Promise<void> => {
    const errors: unknown[] = []
    await Promise.all([...queries].map(async (query) => {
      try {
        query.stop()
      } catch (error) {
        errors.push(error)
      }
      await query.settled
      if (queries.has(query)) {
        errors.push(new Error(`Debug test CLI query remains open: ${JSON.stringify(query.diagnostics())}`))
      }
    }))
    if (errors.length > 0) throw new AggregateError(errors, 'Failed to close debug test CLI queries')
  }
  return { registerCliQuery, closeQueries }
}

/**
 * 测试里按真实调试启动计划起子进程，输出攒在内存里；生成参数不经 shell 重建。
 * 应用里它跑在伪终端上；node-pty 在 bun 下收不到数据，那条路由探针在 Electron 运行时里验。
 */
export function createProcessDebugLauncher(): {
  launcher: WorkbenchDebugLauncher
  closeQueries(): Promise<void>
  /** 每个起过的进程：命令行、输出、进程号。 */
  launched: Array<{
    command: string
    file: string
    argv: string[]
    cwd: string
    env: NodeJS.ProcessEnv
    pid: number
    output: () => string
    isRunning: () => boolean
    disposePipes: () => void
  }>
} {
  const launched: ReturnType<typeof createProcessDebugLauncher>['launched'] = []
  const { registerCliQuery, closeQueries } = createDebugCliQueryOwner()
  let nextId = 1

  const launcher: WorkbenchDebugLauncher = async (options) => {
    // 被调试夹具不继承测试宿主的 --import/--require/检查器参数：它们会改变
    // --inspect-brk 的停顿位置与异常传播。场景明确指定的 NODE_OPTIONS 仍保留。
    // 夹具显式用 PATH 选择测试用 Node；生产解析器仍按实际上下文解析，不固定产品 Node。
    const env = {
      ...process.env,
      PATH: `${dirname(resolveWorkbenchNodeExecutable())}${delimiter}${process.env.PATH ?? ''}`,
      NODE_OPTIONS: '',
      ...options.env,
    }
    const plan = await buildWorkbenchDebugLaunchPlan(options.target, {
      projectRoot: options.projectRoot,
      cwd: options.cwd,
      env,
      signal: options.signal,
      pathResolver: new PathResolver(),
      registerCliQuery,
    }, options.port)
    const spec = plan.process
    const child = spawn(spec.file, spec.argv, {
      cwd: options.cwd,
      env: spec.env ?? env,
      // 独立的进程组：停止时连它派生的进程一起结束。
      detached: currentPlatform.shouldUseDetachedProcessGroup(),
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
      command: plan.command,
      file: spec.file,
      argv: [...spec.argv],
      cwd: options.cwd,
      env: spec.env ?? env,
      pid: child.pid!,
      output: () => output,
      isRunning: () => exit === null,
      disposePipes: () => {
        child.stdout.destroy()
        child.stderr.destroy()
      },
    })

    const signalGroup = async (signal: NodeJS.Signals, pids: readonly number[]): Promise<void> => {
      if (process.platform === 'win32') {
        await signalWorkbenchProcesses(pids, signal)
        return
      }
      try {
        process.kill(-child.pid!, signal)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
      }
    }
    return {
      terminalSessionId: `terminal-test-${nextId++}`,
      projectRoot: options.projectRoot,
      shell: spec.file,
      cwd: options.cwd,
      command: plan.command,
      skipInitialPause: plan.skipInitialPause,
      onExit: (listener) => {
        if (exit) listener(exit)
        else exitListeners.push(listener)
      },
      stop: async () => {
        const pids = await listWorkbenchProcessTree(child.pid!)
        if (exit) return
        const errors: unknown[] = []
        let forceKill: Promise<void> | undefined
        let finish!: () => void
        const exited = new Promise<void>((resolve) => {
          finish = resolve
        })
        exitListeners.push(finish)
        forceKillTimer = setTimeout(() => {
          forceKill = signalGroup('SIGKILL', pids).catch((error: unknown) => {
            errors.push(error)
            finish()
          })
        }, 1_000)
        try {
          await signalGroup('SIGTERM', pids)
        } catch (error) {
          errors.push(error)
        }
        await exited
        await forceKill
        clearTimeout(forceKillTimer)
        if (errors.length > 0) throw new AggregateError(errors, 'Failed to stop debug test process')
      },
    }
  }

  return { launcher, launched, closeQueries }
}

export interface DebugTestProject {
  root: string
  sessions: WorkbenchDebugSessions
  launched: ReturnType<typeof createProcessDebugLauncher>['launched']
  events: WorkbenchDebuggerEvent[]
  start: (
    request: Omit<
      WorkbenchDebuggerStartRequest,
      'projectRoot' | 'breakpoints' | 'pauseOnUncaughtExceptions'
    > &
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

  const { launcher, launched, closeQueries } = createProcessDebugLauncher()
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
        DebuggerEventOf<'paused'> | DebuggerEventOf<'ended'>,
    dispose: async () => {
      const errors: unknown[] = []
      try {
        await sessions.closeAllSessions()
      } catch (error) {
        errors.push(error)
      }
      try {
        await closeQueries()
      } catch (error) {
        errors.push(error)
      }
      for (const item of launched) {
        // 退出事件已确认的子进程不再按旧进程组号发送信号，避免 macOS 对已回收组返回 EPERM。
        if (!item.isRunning()) continue
        try {
          if (process.platform === 'win32')
            await signalWorkbenchProcesses(await listWorkbenchProcessTree(item.pid), 'SIGKILL')
          else process.kill(-item.pid, 'SIGKILL')
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') errors.push(error)
        }
      }
      // Bun 在 Windows 上结束 shell 后可能不发管道 close；进程树已停止，显式释放读取端。
      for (const item of launched) item.disposePipes()
      if (errors.length > 0)
        throw new AggregateError(errors, 'Failed to clean up debug test processes')
      // Windows 释放工作目录句柄会晚于进程退出；Bun 的 rm 不保证执行 maxRetries。
      for (let attempt = 0; ; attempt += 1) {
        try {
          await rm(root, { recursive: true, force: true })
          break
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code
          if (
            process.platform !== 'win32' ||
            attempt >= 20 ||
            !['EBUSY', 'ENOTEMPTY', 'EPERM', 'EACCES'].includes(code ?? '')
          )
            throw error
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
  const { variables } = await project.sessions.getVariables(
    { sessionId, objectId: scope.objectId },
    1
  )
  return Object.fromEntries(variables.map((variable) => [variable.name, variable.value]))
}

/** `函数名@项目里的文件:行`，匿名函数写 `(anonymous)`。 */
export function frameSummary(frame: LooseOptional<WorkbenchDebuggerFrame>): string {
  return `${frame?.functionName || '(anonymous)'}@${frame?.location.path}:${frame?.location.line}`
}
