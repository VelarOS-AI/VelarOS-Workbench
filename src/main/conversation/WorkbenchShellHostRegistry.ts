import { Log } from '@velaros-ai/velaros/core'
import { AppError } from '@velaros-ai/velaros/core/error'
import { type TimerLease, TimerScope } from '@velaros-ai/velaros/core/utils/TimerScope'
import type {
  LocalShellHostApi,
  LocalShellHostOptions,
  ShellEnvironmentApi,
  ShellHostPort,
  ShellTerminalFactory,
} from '@velaros-ai/velaros/execution'
import type {
  ShellBackgroundTaskQueryOptions,
  ShellBackgroundTaskRecord,
  ShellConsoleControlResult,
  ShellConsoleInputRequest,
  ShellConsoleInterruptRequest,
  ShellConsoleOutputRequest,
  ShellProcessConfinementMode,
  ShellTaskTerminateReport,
  ShellTaskTerminateRequest,
} from '@velaros-ai/velaros/execution/contracts'
import { createLocalShellHost } from '@velaros-ai/velaros/execution/local'

const log = Log.tag('WorkbenchShellHostRegistry')

/** 借出去的宿主：命令在它自己上面跑，后台任务的查与停走整张表；借用方不释放它。 */
type SharedShellHost = Required<ShellHostPort> & Pick<LocalShellHostApi, 'inspectEnvironment'>

/** 交互式命令用的终端：第一次建宿主时才问，没有就用管道。 */
type ShellTerminalLoader = () => Nullable<ShellTerminalFactory>

/**
 * 应用共用的本机 shell 宿主（Desktop 同名登记表的精简版）：每个项目根、每种进程约束各一个，活到应用退出。
 *
 * 后台任务登记在启动它的宿主上，宿主释放时一并停掉，所以宿主不能跟着一轮运行开关：Agent 起的开发服务器
 * 这一轮结束后要接着跑。模型与界面都按项目根查询、控制任务；全局查询供资源回收使用。
 */
export interface WorkbenchShellHostRegistryApi {
  startConsoleCommand(request: {
    sessionId: string
    cwd: string
    command: string
    sandbox: boolean
  }): Promise<{ task: ShellBackgroundTaskRecord }>
  readConsoleOutput(
    request: ShellConsoleOutputRequest,
    projectRoot: string
  ): ReturnType<LocalShellHostApi['readConsoleOutput']>
  /** 取这个根、这种约束下的宿主，没有就建一个。 */
  host(root: string, mode: ShellProcessConfinementMode): SharedShellHost
  listBackgroundTasks(
    query?: ShellBackgroundTaskQueryOptions,
    projectRoot?: string
  ): Promise<ShellBackgroundTaskRecord[]>
  terminateBackgroundTask(
    request: ShellTaskTerminateRequest,
    projectRoot?: string
  ): Promise<ShellTaskTerminateReport>
  writeConsoleInput(
    request: ShellConsoleInputRequest,
    projectRoot: string
  ): Promise<ShellConsoleControlResult>
  interruptConsole(
    request: ShellConsoleInterruptRequest,
    projectRoot: string
  ): Promise<ShellConsoleControlResult>
  addBackgroundTasksListener(listener: (event: WorkbenchBackgroundTasksChanged) => void): () => void
  /** 停掉一个会话里还在跑的全部后台任务；返回没停下的个数。 */
  terminateSessionBackgroundTasks(sessionId: string, projectRoot?: string): Promise<number>
  /** 应用退出：停掉全部后台任务，之后不再借出宿主。 */
  dispose(): Promise<void>
}

export interface WorkbenchBackgroundTasksChanged {
  sessionId: Nullable<string>
  projectRoot: Nullable<string>
}

export class WorkbenchShellHostRegistry implements WorkbenchShellHostRegistryApi {
  private readonly hosts = new Map<string, { root: string; host: LocalShellHostApi }>()
  private closing?: Promise<void>
  private readonly listeners = new Set<(event: WorkbenchBackgroundTasksChanged) => void>()
  private readonly running = new Map<string, WorkbenchBackgroundTasksChanged>()
  private readonly timers = new TimerScope({ name: 'WorkbenchShellHostRegistry' })
  private exitCheck?: TimerLease

  public constructor(
    private readonly environment?: ShellEnvironmentApi,
    private readonly terminal?: ShellTerminalLoader
  ) {}

  public host(projectRoot: string, mode: ShellProcessConfinementMode): SharedShellHost {
    this.assertOpen()
    const root = resolve(projectRoot)
    const host = this.hosts.get(`${mode}:${root}`)?.host ?? this.createHost(root, mode)
    return {
      runCommand: async (command, options, allowDangerous, signal) => {
        this.assertOpen()
        const result = await host.runCommand(command, options, allowDangerous, signal)
        const started = result.backgroundProcess
        if (started?.taskId) {
          const ref = { sessionId: started.sessionId, projectRoot: root }
          this.running.set(started.taskId, ref)
          this.notify(ref)
          this.exitCheck ??= this.timers.every(
            1_000,
            () =>
              void this.checkExits().catch((error: unknown) =>
                log.warn('检查后台任务退出失败', { error })
              ),
            { unref: true }
          )
        }
        return result
      },
      runObservationCommand: (command, options, signal) =>
        host.runObservationCommand!(command, options, signal),
      listBackgroundTasks: (query) => this.listBackgroundTasks(query, root),
      terminateBackgroundTask: (request) => this.terminateBackgroundTask(request, root),
      inspectEnvironment: (commands) => host.inspectEnvironment(commands),
      refreshShellEnvironment: () => host.refreshShellEnvironment(),
    }
  }

  /** 与 Desktop 同一命令台协议；进程归属应用，会话结束不释放。 */
  public async startConsoleCommand(request: {
    sessionId: string
    cwd: string
    command: string
    sandbox: boolean
  }): Promise<{ task: ShellBackgroundTaskRecord }> {
    const result = await this.host(
      request.cwd,
      request.sandbox ? 'workspace-write' : 'danger-full-access'
    ).runCommand(request.command, {
      cwd: request.cwd,
      sessionId: request.sessionId,
      background: true,
      interactive: true,
    })
    const taskId = result.backgroundProcess?.taskId
    const [task] = taskId
      ? await this.listBackgroundTasks({ taskId, sessionId: request.sessionId }, request.cwd)
      : []
    if (!task?.console) throw new AppError('UNAVAILABLE', '命令未能在控制台启动')
    return { task }
  }

  public async readConsoleOutput(
    request: ShellConsoleOutputRequest,
    projectRoot: string
  ): ReturnType<LocalShellHostApi['readConsoleOutput']> {
    return (await this.taskHost(request, projectRoot)).host.readConsoleOutput(request)
  }

  public async terminateSessionBackgroundTasks(
    sessionId: string,
    projectRoot?: string
  ): Promise<number> {
    const tasks = await this.listBackgroundTasks({ sessionId, onlyRunning: true }, projectRoot)
    const outcomes = await Promise.allSettled(
      tasks.map((task) =>
        this.terminateBackgroundTask({ taskId: task.id, sessionId, force: true }, projectRoot)
      )
    )
    const failures = outcomes.filter((outcome) => outcome.status === 'rejected')
    if (failures.length)
      log.warn('会话的后台任务没能全部停下', {
        sessionId,
        failed: failures.length,
        errors: failures.map((failure) => AppError.getMessage(failure.reason)),
      })
    return failures.length
  }

  public dispose(): Promise<void> {
    // 宿主的释放就是强杀它起过的全部后台进程并清空任务表。
    this.closing ??= Promise.allSettled(
      [...this.hosts.values()].map(({ host }) => host.dispose())
    ).then((outcomes) => {
      this.timers.dispose()
      this.running.clear()
      this.notify({ sessionId: null, projectRoot: null })
      this.listeners.clear()
      const failed = outcomes.filter((outcome) => outcome.status === 'rejected')
      if (failed.length) throw new AppError('UNAVAILABLE', 'Agent 后台进程未全部释放')
    })
    return this.closing
  }

  public async listBackgroundTasks(
    { limit, ...filters }: ShellBackgroundTaskQueryOptions = {},
    projectRoot?: string
  ): Promise<ShellBackgroundTaskRecord[]> {
    const lists = await Promise.all(
      this.scopedHosts(projectRoot).map(({ host }) => host.listBackgroundTasks(filters))
    )
    return lists
      .flat()
      .sort((a, b) => b.startedAt - a.startedAt)
      .slice(0, limit ?? Number.POSITIVE_INFINITY)
  }

  public async terminateBackgroundTask(
    request: ShellTaskTerminateRequest,
    projectRoot?: string
  ): Promise<ShellTaskTerminateReport> {
    const { host, root } = await this.taskHost(request, projectRoot)
    const result = await host.terminateBackgroundTask(request)
    if (result.statusAfter === 'exited') this.running.delete(result.taskId)
    this.notify({ sessionId: result.sessionId, projectRoot: root })
    return result
  }

  public async writeConsoleInput(
    request: ShellConsoleInputRequest,
    projectRoot: string
  ): Promise<ShellConsoleControlResult> {
    return (await this.taskHost(request, projectRoot)).host.writeConsoleInput(request)
  }

  public async interruptConsole(
    request: ShellConsoleInterruptRequest,
    projectRoot: string
  ): Promise<ShellConsoleControlResult> {
    return (await this.taskHost(request, projectRoot)).host.interruptConsole(request)
  }

  public addBackgroundTasksListener(
    listener: (event: WorkbenchBackgroundTasksChanged) => void
  ): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private notify(event: WorkbenchBackgroundTasksChanged): void {
    for (const listener of this.listeners) {
      try {
        listener(event)
      } catch (error) {
        log.warn('后台任务变更通知失败', { error })
      }
    }
  }

  private async checkExits(): Promise<void> {
    const alive = new Set(
      (await this.listBackgroundTasks({ onlyRunning: true })).map((task) => task.id)
    )
    for (const [id, ref] of this.running) {
      if (alive.has(id)) continue
      this.running.delete(id)
      this.notify(ref)
    }
    if (!this.running.size) {
      this.exitCheck?.cancel()
      this.exitCheck = undefined
    }
  }

  private scopedHosts(projectRoot?: string): Array<{ root: string; host: LocalShellHostApi }> {
    const root = projectRoot ? resolve(projectRoot) : undefined
    return [...this.hosts.values()].filter((entry) => !root || entry.root === root)
  }

  private async taskHost(request: { taskId: string; sessionId?: string }, projectRoot?: string) {
    this.assertOpen()
    for (const entry of this.scopedHosts(projectRoot)) {
      const [task] = await entry.host.listBackgroundTasks({ taskId: request.taskId })
      if (!task) continue
      if (request.sessionId && task.sessionId !== request.sessionId)
        throw new AppError('PERMISSION', `后台任务 ${request.taskId} 不属于这个会话。`)
      return entry
    }
    throw new AppError('NOT_FOUND', `未找到后台任务：${request.taskId}`)
  }

  private assertOpen(): void {
    if (this.closing) throw new AppError('UNAVAILABLE', '应用正在退出，不再执行命令。')
  }

  private createHost(root: string, mode: ShellProcessConfinementMode): LocalShellHostApi {
    const options: LocalShellHostOptions = {
      cwd: root,
      environment: this.environment,
      processConfinement: { mode, workspaceRoot: root },
    }
    // 有终端后端时交互式命令跑在真终端里，没有就用管道。
    const terminal = this.terminal?.()
    if (terminal) options.terminal = terminal
    const host = createLocalShellHost(options)
    this.hosts.set(`${mode}:${root}`, { root, host })
    return host
  }
}
import { resolve } from 'node:path'
