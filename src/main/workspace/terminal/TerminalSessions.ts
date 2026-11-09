/**
 * 工作台持久终端会话服务：每个会话一个真正的伪终端（PTY）。
 *
 * shell 坐在 PTY 上，提示符、行编辑、补全、颜色、进度条与交互由 shell 和程序处理；
 * renderer 只负责把字节送进 xterm、把按键送回来。
 *
 * 键控轴：service 单例（Parts 装配），会话按请求 `projectRoot` 解析根、按随机 `sessionId` 登记进程内 Map；
 * `WorkbenchTerminalStartResult.sessionId` 是 PTY 会话 id，是本服务对外的持久句柄。多卡 = 每次运行新开会话，
 * 支持重启 / 终止 / 关闭。
 */
import { stat } from 'node:fs/promises'

import { isEmpty } from '@velaros-ai/velaros/core'
import { AppError } from '@velaros-ai/velaros/core/error'
import { currentPlatform } from '@velaros-ai/velaros/core/platform'
import { type TimerLease, TimerScope } from '@velaros-ai/velaros/core/utils/TimerScope'

import {
  type WorkbenchTerminalAcknowledgeRequest,
  type WorkbenchTerminalCwdRequest,
  type WorkbenchTerminalCwdResult,
  type WorkbenchTerminalInputRequest,
  type WorkbenchTerminalOutputEvent,
  type WorkbenchTerminalResizeRequest,
  type WorkbenchTerminalStartRequest,
  type WorkbenchTerminalStartResult,
  type WorkbenchTerminalStopRequest,
} from '@shared/contracts/workbench'

import { workbenchMainText } from '../../i18n/workbenchMainMessages'
import type { CommandHelper } from '../CommandHelper'
import type { PathResolver } from '../PathResolver'

import { nodePtyFactory, type WorkbenchPtyFactory, type WorkbenchPtyProcess } from './WorkbenchPty'

export const DefaultTerminalColumns = 80
export const DefaultTerminalRows = 24
const MaxTerminalColumns = 1_000
const MaxTerminalRows = 500
/**
 * 输出合并窗口：PTY 一次读出来常常只有几十字节（一个按键的回显、进度条的一格），逐条过 IPC 会把 renderer
 * 淹没在事件里。攒这么久（或攒到这么大）发一次，肉眼看不出延迟。
 */
const OutputFlushDelayMs = 8
const OutputFlushChars = 64 * 1024
/**
 * 流控（与 VS Code 同值）：发出去、renderer 还没确认写进 xterm 的字符超过高水位就暂停读伪终端，程序写满缓冲区后
 * 阻塞；确认回来降到低水位以下再继续。`yes` 这类一秒刷几十 MB 的命令不会再把界面淹死。
 */
const FlowControlHighWatermarkChars = 100_000
const FlowControlLowWatermarkChars = 5_000
/** 等进程退出最多再多等这么久（强杀之后）。 */
const ExitWaitGraceMs = 1_000
const DefaultUtf8Locale = 'en_US.UTF-8'
const TerminalName = 'xterm-256color'
/** Ctrl+C（ETX）：写进伪终端后行规程给前台进程组发 SIGINT。 */
const InterruptCharacter = String.fromCharCode(3)

interface WorkbenchTerminalSession {
  pty: WorkbenchPtyProcess
  onOutput: (event: WorkbenchTerminalOutputEvent) => void
  /** 该会话的输出合并、延迟强杀与兜底收口任务作用域。 */
  timers: TimerScope
  /** 发起该会话的 renderer webContents.id；用于多项目窗口的资源与权限隔离。 */
  ownerId: Nullable<number>
  /** 进程已退出（onExit 已到）；停止流程上的延迟回调据此空操作。 */
  exited: boolean
  pendingOutput: string
  flushLease: Nullable<TimerLease>
  /** 发给 renderer、还没被确认处理完的字符数。 */
  unackedChars: number
  /** 因为 renderer 跟不上，暂停读伪终端了。 */
  paused: boolean
  /** 进程退出时通知等待者（停止时要等它真的退出）。 */
  exitWaiters: Set<() => void>
}

/**
 * 交给 shell 的环境：告诉它这是个真终端，并保证有 UTF-8 locale。`overrides` 是运行配置里写的变量，最后盖上去——
 * 用户明确写的值优先，`TERM`、`LANG` 这些也不例外。
 */
export function buildTerminalEnvironment(
  base: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
  overrides: Readonly<Record<string, string>> = {}
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...base,
    TERM: TerminalName,
    COLORTERM: 'truecolor',
    TERM_PROGRAM: 'VelarOS-Workbench',
    VELAROS_WORKBENCH_TERMINAL: '1',
  }
  // 从 Finder / Dock 启动的 Electron 没有 LANG：zsh 会按 C locale 处理输入，中文成了乱码或问号。
  if (platform !== 'win32' && !env.LANG && !env.LC_ALL && !env.LC_CTYPE)
    env.LANG = DefaultUtf8Locale

  for (const [name, value] of Object.entries(overrides)) {
    // Windows 的变量名不分大小写：`Path` 和 `PATH` 是同一个，留着两份进程拿到哪个说不准。
    if (platform === 'win32') {
      const upperName = name.toUpperCase()
      for (const existing of Object.keys(env)) {
        if (existing !== name && existing.toUpperCase() === upperName) delete env[existing]
      }
    }
    env[name] = value
  }
  return env
}

export function clampTerminalDimension(
  value: LooseOptional<number>,
  fallback: number,
  max: number
): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(1, Math.floor(value)))
}

export class TerminalSessions {
  /** sessionId -> 会话实体；存活的伪终端都在这里登记。 */
  private readonly terminalSessions = new Map<string, WorkbenchTerminalSession>()
  private readonly pendingStarts = new Map<
    AbortController,
    { ownerId: Nullable<number>; completed: Promise<WorkbenchTerminalStartResult> }
  >()
  private readonly closingOwners = new Map<number, Promise<void>>()
  private closing?: Promise<void>

  constructor(
    private readonly pathResolver: PathResolver,
    private readonly commandHelper: CommandHelper,
    private readonly ptyFactory: WorkbenchPtyFactory = nodePtyFactory
  ) {}

  public startTerminalSession(
    request: WorkbenchTerminalStartRequest,
    onOutput: (event: WorkbenchTerminalOutputEvent) => void,
    ownerId: Nullable<number> = null
  ): Promise<WorkbenchTerminalStartResult> {
    if (this.closing || (ownerId !== null && this.closingOwners.has(ownerId)))
      return Promise.reject(new AppError('CLOSED', workbenchMainText('terminal.sessionEnded')))
    const controller = new AbortController()
    const completed = Promise.resolve().then(() =>
      this.createTerminalSession(request, onOutput, ownerId, controller.signal)
    )
    this.pendingStarts.set(controller, { ownerId, completed })
    void completed
      .finally(() => this.pendingStarts.delete(controller))
      .catch(() => undefined)
    return completed
  }

  private async createTerminalSession(
    request: WorkbenchTerminalStartRequest,
    onOutput: (event: WorkbenchTerminalOutputEvent) => void,
    ownerId: Nullable<number>,
    signal: AbortSignal
  ): Promise<WorkbenchTerminalStartResult> {
    signal.throwIfAborted()
    const projectRoot = await this.pathResolver.resolveProjectRoot(request.projectRoot)
    signal.throwIfAborted()
    const cwdPath = await this.pathResolver.resolveInsideProject(projectRoot, request.cwd ?? '.')
    const cwdStats = await stat(cwdPath.realPath)
    signal.throwIfAborted()
    if (!cwdStats.isDirectory()) {
      throw new AppError('VALIDATION', workbenchMainText('terminal.cwdNotFolder'))
    }

    const initialCommand = request.initialCommand?.trim()
    const shellSpec = initialCommand
      ? this.commandHelper.getShellSpec(initialCommand)
      : {
          file: currentPlatform.getPreferredShellPath(process.env),
          args: currentPlatform.getInteractiveShellArgs(),
          windowsVerbatimArguments: false,
        }
    const cols = clampTerminalDimension(request.cols, DefaultTerminalColumns, MaxTerminalColumns)
    const rows = clampTerminalDimension(request.rows, DefaultTerminalRows, MaxTerminalRows)
    const sessionId = `terminal-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

    const env = buildTerminalEnvironment(process.env, process.platform, request.env)
    let pty: WorkbenchPtyProcess
    try {
      pty = this.ptyFactory.spawn(shellSpec.file, shellSpec.args, {
        cwd: cwdPath.realPath,
        windowsVerbatimArguments: shellSpec.windowsVerbatimArguments,
        env,
        cols,
        rows,
        // node-pty 拿这个名字去设进程的 TERM：运行配置里写了 TERM 的照它来，否则写了也到不了进程手里。
        name: env.TERM || TerminalName,
      })
    } catch (error) {
      throw AppError.from(error, 'PLATFORM')
    }

    const session: WorkbenchTerminalSession = {
      pty,
      onOutput,
      timers: new TimerScope({ name: 'WorkbenchTerminalSession' }),
      ownerId,
      exited: false,
      pendingOutput: '',
      flushLease: null,
      unackedChars: 0,
      paused: false,
      exitWaiters: new Set(),
    }
    this.terminalSessions.set(sessionId, session)

    pty.onData((data) => this.queueOutput(sessionId, session, data))
    pty.onExit(({ exitCode, signal }) => {
      session.exited = true
      this.flushOutput(sessionId, session)
      // 正常退出时 node-pty 给的信号是 0：不是被信号结束的，按没有信号算。
      const endedBySignal = signal ? signal : undefined
      // 终端里换行要 CR LF：xterm 不会替 LF 补回车。
      onOutput({
        sessionId,
        stream: 'system',
        chunk: `\r\n${workbenchMainText('terminal.processExited', {
          code: exitCode,
          signal: endedBySignal ?? '-',
        })}\r\n`,
        closed: true,
        exitCode,
        signal: endedBySignal === undefined ? undefined : String(endedBySignal),
      })
      this.dropSession(sessionId, session)
      for (const waiter of session.exitWaiters) waiter()
    })

    return {
      sessionId,
      projectRoot,
      cwd: cwdPath.realPath,
      shell: shellSpec.file,
      startedAt: Date.now(),
    }
  }

  public writeTerminalInput(
    request: WorkbenchTerminalInputRequest,
    ownerId: Nullable<number> = null
  ): void {
    const session = this.liveSession(request.sessionId)
    assertSessionOwner(session, ownerId)
    session.pty.write(request.input)
  }

  /** xterm 量出的格子数变了：伪终端跟着改，前台程序会收到 SIGWINCH 重排版。 */
  public resizeTerminalSession(
    request: WorkbenchTerminalResizeRequest,
    ownerId: Nullable<number> = null
  ): void {
    const session = this.liveSession(request.sessionId)
    assertSessionOwner(session, ownerId)
    session.pty.resize(
      clampTerminalDimension(request.cols, DefaultTerminalColumns, MaxTerminalColumns),
      clampTerminalDimension(request.rows, DefaultTerminalRows, MaxTerminalRows)
    )
  }

  /**
   * 会话的 shell 此刻所在的目录（问操作系统）：终端输出里的相对路径按它解析，`cd` 之后也对得上。
   * 会话已经结束、平台问不到时是 null。
   */
  public async readTerminalCwd(
    request: WorkbenchTerminalCwdRequest,
    ownerId: Nullable<number> = null
  ): Promise<WorkbenchTerminalCwdResult> {
    const session = this.terminalSessions.get(request.sessionId)
    if (!session || session.exited) return { cwd: null }
    assertSessionOwner(session, ownerId)
    return { cwd: await this.ptyFactory.readCwd(session.pty.pid) }
  }

  /** renderer 确认把一段输出写进了 xterm：降到低水位以下就接着读伪终端。 */
  public acknowledgeTerminalOutput(
    request: WorkbenchTerminalAcknowledgeRequest,
    ownerId: Nullable<number> = null
  ): void {
    const session = this.terminalSessions.get(request.sessionId)
    if (!session || session.exited) return
    assertSessionOwner(session, ownerId)

    session.unackedChars = Math.max(0, session.unackedChars - request.chars)
    if (session.paused && session.unackedChars < FlowControlLowWatermarkChars) {
      session.paused = false
      session.pty.resume()
    }
  }

  /**
   * 停止终端会话。
   *
   * `SIGINT` 是「打断」：往伪终端里写 Ctrl+C，行规程把 SIGINT 送给前台进程组，与在真终端里按 Ctrl+C 完全
   * 一样，shell 本身活着。默认硬停给整棵进程树发 SIGTERM——shell 起的前台任务、放到后台的任务都在里面，
   * 不只是 shell；延迟后仍没退出的再 SIGKILL。`waitForExit` 时等到进程真的退出（或强杀后再等一会儿）才返回：
   * 重新运行要等旧进程让出端口。
   */
  public async stopTerminalSession(
    request: WorkbenchTerminalStopRequest,
    ownerId: Nullable<number> = null
  ): Promise<void> {
    const session = this.terminalSessions.get(request.sessionId)
    if (!session) return
    assertSessionOwner(session, ownerId)

    if (request.signal === 'SIGINT') {
      session.pty.write(InterruptCharacter)
      return
    }

    const errors: unknown[] = []
    let tree = [session.pty.pid]
    try {
      // 趁 shell 仍在时快照进程树；失败仍须清理 PTY，且不能向调用者报成功。
      tree = await this.ptyFactory.processTree.list(session.pty.pid)
    } catch (error) {
      console.error('[WorkbenchTerminal] process tree snapshot failed', {
        sessionId: request.sessionId,
        pid: session.pty.pid,
        error,
      })
      errors.push(error)
    }
    const exited = request.waitForExit ? this.waitForExit(session) : null
    errors.push(...(await this.signalSessionProcesses(request.sessionId, session, tree, 'SIGTERM')))
    // 独立于会话计时器，shell 先退出也继续清理子孙；方法内部接住并记录所有错误。
    const forceKill = setTimeout(() => {
      void this.signalSessionProcesses(request.sessionId, session, tree, 'SIGKILL')
    }, this.commandHelper.getForceKillDelayMs())
    forceKill.unref()
    if (exited) await exited
    if (errors.length > 0)
      throw new AggregateError(errors, `Failed to stop terminal ${request.sessionId}`)
  }

  /** 树终止失败不能跳过 PTY；后台调用也必须有诊断而不是未处理拒绝。 */
  private async signalSessionProcesses(
    sessionId: string,
    session: WorkbenchTerminalSession,
    tree: readonly number[],
    signal: NodeJS.Signals
  ): Promise<unknown[]> {
    const errors: unknown[] = []
    try {
      await this.ptyFactory.processTree.signal(tree, signal)
    } catch (error) {
      console.error('[WorkbenchTerminal] process tree signal failed', {
        sessionId,
        pids: tree,
        signal,
        error,
      })
      errors.push(error)
    }
    try {
      if (!session.exited) session.pty.kill(signal)
    } catch (error) {
      console.error('[WorkbenchTerminal] PTY signal failed', {
        sessionId,
        pid: session.pty.pid,
        signal,
        error,
      })
      errors.push(error)
    }
    return errors
  }

  /** 关闭所有持久终端会话；进程退出前调用。 */
  public closeAllSessions(): Promise<void> {
    if (this.closing) return this.closing
    const completion = Promise.withResolvers<void>()
    this.closing = completion.promise
    void this.closeOwnedSessions().then(completion.resolve, completion.reject)
    return completion.promise
  }

  /** 关闭一个项目窗口拥有的全部终端 / 运行卡，其他项目窗口不受影响。 */
  public closeSessionsForOwner(ownerId: number): Promise<void> {
    if (this.closing) return this.closing
    const current = this.closingOwners.get(ownerId)
    if (current) return current
    const completion = Promise.withResolvers<void>()
    this.closingOwners.set(ownerId, completion.promise)
    void this.closeOwnedSessions(ownerId)
      .then(completion.resolve, completion.reject)
      .finally(() => this.closingOwners.delete(ownerId))
    return completion.promise
  }

  private async closeOwnedSessions(ownerId?: number): Promise<void> {
    const pending = [...this.pendingStarts].filter(
      ([, start]) => ownerId === undefined || start.ownerId === ownerId
    )
    for (const [controller] of pending)
      controller.abort(new AppError('CANCELLED', workbenchMainText('terminal.sessionEnded')))
    // 被撤销的准备只能在 spawn 前失败；已有进程同时收束，请求错误仍由启动调用者接收。
    const closed = this.closeSessions(
      [...this.terminalSessions.entries()].filter(
        ([, session]) => ownerId === undefined || session.ownerId === ownerId
      )
    )
    await Promise.allSettled([closed, ...pending.map(([, start]) => start.completed)])
    await closed
  }

  /** 等会话的进程退出；强杀的延迟过后再多等一会儿，还没退也返回。 */
  private waitForExit(session: WorkbenchTerminalSession): Promise<void> {
    if (session.exited) return Promise.resolve()
    return new Promise((resolve) => {
      const finish = (): void => {
        clearTimeout(timeout)
        session.exitWaiters.delete(finish)
        resolve()
      }
      const timeout = setTimeout(finish, this.commandHelper.getForceKillDelayMs() + ExitWaitGraceMs)
      timeout.unref()
      session.exitWaiters.add(finish)
    })
  }

  private liveSession(sessionId: string): WorkbenchTerminalSession {
    const session = this.terminalSessions.get(sessionId)
    if (!session || session.exited)
      throw new AppError('VALIDATION', workbenchMainText('terminal.sessionEnded'))
    return session
  }

  private queueOutput(sessionId: string, session: WorkbenchTerminalSession, data: string): void {
    session.pendingOutput += data
    if (session.pendingOutput.length >= OutputFlushChars) {
      this.flushOutput(sessionId, session)
      return
    }
    if (session.flushLease) return
    session.flushLease = session.timers.after(OutputFlushDelayMs, () => {
      session.flushLease = null
      this.flushOutput(sessionId, session)
    })
  }

  private flushOutput(sessionId: string, session: WorkbenchTerminalSession): void {
    session.flushLease?.cancel()
    session.flushLease = null
    if (!session.pendingOutput) return
    const chunk = session.pendingOutput
    session.pendingOutput = ''
    session.onOutput({ sessionId, stream: 'stdout', chunk })
    session.unackedChars += chunk.length
    if (
      !session.paused &&
      !session.exited &&
      session.unackedChars > FlowControlHighWatermarkChars
    ) {
      session.paused = true
      session.pty.pause()
    }
  }

  private dropSession(sessionId: string, session: WorkbenchTerminalSession): void {
    if (this.terminalSessions.get(sessionId) === session) this.terminalSessions.delete(sessionId)
    session.timers.dispose()
  }

  /**
   * 先 SIGTERM 让 shell 自行收尾，等待短超时后若还没退出再 SIGKILL，再兜底一秒后强制结算——
   * 给 shell 留下处理 trap 的窗口，也不让退出流程被一个僵掉的进程卡住。
   */
  private async closeSessions(sessions: Array<[string, WorkbenchTerminalSession]>): Promise<void> {
    if (isEmpty(sessions)) return
    // 每个会话都完成必要清理后再汇总失败，不能因某棵树失败跳过其他会话。
    const results = await Promise.allSettled(
      sessions.map(async ([sessionId, session]) => {
        try {
          if (!session.exited) await this.stopTerminalSession({ sessionId, waitForExit: true })
        } finally {
          this.dropSession(sessionId, session)
        }
      })
    )
    const errors = results.flatMap((result) =>
      result.status === 'rejected' ? [result.reason] : []
    )
    if (errors.length > 0) throw new AggregateError(errors, 'Failed to close terminal sessions')
  }
}

function assertSessionOwner(session: WorkbenchTerminalSession, ownerId: Nullable<number>): void {
  if (ownerId === null || session.ownerId === null || ownerId === session.ownerId) return

  throw new AppError('PERMISSION', workbenchMainText('terminal.sessionNotInWindow'))
}
