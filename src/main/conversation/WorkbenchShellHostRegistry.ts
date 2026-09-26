import { Log } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'
import type {
  LocalShellHostApi,
  LocalShellHostOptions,
  ShellEnvironmentApi,
  ShellHostPort,
  ShellTerminalFactory,
} from '@velaros-ai/velaros/shell'
import type {
  ShellBackgroundTaskQueryOptions,
  ShellBackgroundTaskRecord,
  ShellProcessConfinementMode,
  ShellTaskTerminateReport,
  ShellTaskTerminateRequest,
} from '@velaros-ai/velaros/shell/contracts'
import { createLocalShellHost } from '@velaros-ai/velaros/shell/local'

const log = Log.tag('WorkbenchShellHostRegistry')

/** 借出去的宿主：命令在它自己上面跑，后台任务的查与停走整张表；借用方不释放它。 */
type SharedShellHost = Required<ShellHostPort>

/** 交互式命令用的终端：第一次建宿主时才问，没有就用管道。 */
type ShellTerminalLoader = () => Nullable<ShellTerminalFactory>

/**
 * 应用共用的本机 shell 宿主（Desktop 同名登记表的精简版）：每个项目根、每种进程约束各一个，活到应用退出。
 *
 * 后台任务登记在启动它的宿主上，宿主释放时一并停掉，所以宿主不能跟着一轮运行开关：Agent 起的开发服务器
 * 这一轮结束后要接着跑。Workbench 没有 Desktop 的命令台与后台任务页（IDE 有自己的终端），这里只留借用、
 * 按会话停与退出时收口。
 */
export interface WorkbenchShellHostRegistryApi {
  /** 取这个根、这种约束下的宿主，没有就建一个。 */
  host(root: string, mode: ShellProcessConfinementMode): SharedShellHost
  /** 停掉一个会话里还在跑的全部后台任务；返回没停下的个数。 */
  terminateSessionBackgroundTasks(sessionId: string): Promise<number>
  /** 应用退出：停掉全部后台任务，之后不再借出宿主。 */
  dispose(): Promise<void>
}

export class WorkbenchShellHostRegistry implements WorkbenchShellHostRegistryApi {
  private readonly hosts = new Map<string, LocalShellHostApi>()
  private closing?: Promise<void>

  public constructor(
    private readonly environment?: ShellEnvironmentApi,
    private readonly terminal?: ShellTerminalLoader
  ) {}

  public host(root: string, mode: ShellProcessConfinementMode): SharedShellHost {
    this.assertOpen()
    const host = this.hosts.get(`${mode}:${root}`) ?? this.createHost(root, mode)
    return {
      runCommand: (command, options, allowDangerous, signal) => {
        this.assertOpen()
        return host.runCommand(command, options, allowDangerous, signal)
      },
      runObservationCommand: (command, options, signal) =>
        host.runObservationCommand!(command, options, signal),
      listBackgroundTasks: (query) => this.listBackgroundTasks(query),
      terminateBackgroundTask: (request) => this.terminateBackgroundTask(request),
      refreshShellEnvironment: () => host.refreshShellEnvironment(),
    }
  }

  public async terminateSessionBackgroundTasks(sessionId: string): Promise<number> {
    const tasks = await this.listBackgroundTasks({ sessionId, onlyRunning: true })
    const outcomes = await Promise.allSettled(
      tasks.map((task) =>
        this.terminateBackgroundTask({ taskId: task.id, sessionId, force: true })
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
      [...this.hosts.values()].map((host) => host.dispose())
    ).then(() => undefined)
    return this.closing
  }

  private async listBackgroundTasks({
    limit,
    ...filters
  }: ShellBackgroundTaskQueryOptions = {}): Promise<ShellBackgroundTaskRecord[]> {
    const lists = await Promise.all(
      [...this.hosts.values()].map((host) => host.listBackgroundTasks(filters))
    )
    return lists
      .flat()
      .sort((a, b) => b.startedAt - a.startedAt)
      .slice(0, limit ?? Number.POSITIVE_INFINITY)
  }

  private async terminateBackgroundTask(
    request: ShellTaskTerminateRequest
  ): Promise<ShellTaskTerminateReport> {
    for (const host of this.hosts.values()) {
      const [task] = await host.listBackgroundTasks({ taskId: request.taskId })
      if (!task) continue
      if (request.sessionId && task.sessionId !== request.sessionId)
        throw new AppError('PERMISSION', `后台任务 ${request.taskId} 不属于这个会话。`)
      return host.terminateBackgroundTask(request)
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
    this.hosts.set(`${mode}:${root}`, host)
    return host
  }
}
