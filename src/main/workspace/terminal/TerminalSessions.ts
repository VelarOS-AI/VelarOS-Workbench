/**
 * 工作台持久终端会话服务：每个会话一个真正的伪终端（PTY）。
 *
 * 以前子进程用 pipe stdio：shell 不是交互态，没有提示符、没有 tab 补全、没有颜色，Ctrl+C 要靠给进程组发信号，
 * 目录跟随要靠往 stdin 里塞探针命令。现在 shell 坐在 PTY 上，提示符、行编辑、补全、颜色、进度条、交互式程序
 * 都是 shell 和程序自己的事；renderer 只负责把字节送进 xterm、把按键送回来。
 *
 * 键控轴：service 单例（Parts 装配），会话按请求 `projectRoot` 解析根、按随机 `sessionId` 登记进程内 Map；
 * `WorkbenchTerminalStartResult.sessionId` 是 PTY 会话 id，是本服务对外的持久句柄。多卡 = 每次运行新开会话，
 * 支持重启 / 终止 / 关闭。
 */
import { stat } from 'node:fs/promises'

import { isEmpty } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'
import { type TimerLease, TimerScope } from '@velaros-ai/core/utils/TimerScope'
import { currentSystemPlatform as systemPlatformCompatibility } from '@velaros-ai/system/platform-compatibility'

import type {
  WorkbenchTerminalInputRequest,
  WorkbenchTerminalOutputEvent,
  WorkbenchTerminalResizeRequest,
  WorkbenchTerminalStartRequest,
  WorkbenchTerminalStartResult,
  WorkbenchTerminalStopRequest,
} from '@shared/contracts'

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
}

/** 交给 shell 的环境：告诉它这是个真终端，并保证有 UTF-8 locale。 */
export function buildTerminalEnvironment(
  base: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...base,
    TERM: TerminalName,
    COLORTERM: 'truecolor',
    TERM_PROGRAM: 'VelarOS-Workbench',
    VELAROS_WORKBENCH_TERMINAL: '1',
  }
  // 从 Finder / Dock 启动的 Electron 没有 LANG：zsh 会按 C locale 处理输入，中文成了乱码或问号。
  if (platform !== 'win32' && !env.LANG && !env.LC_ALL && !env.LC_CTYPE) env.LANG = DefaultUtf8Locale
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

class TerminalSessions {
  /** sessionId -> 会话实体；存活的伪终端都在这里登记。 */
  private readonly terminalSessions = new Map<string, WorkbenchTerminalSession>()

  constructor(
    private readonly pathResolver: PathResolver,
    private readonly commandHelper: CommandHelper,
    private readonly ptyFactory: WorkbenchPtyFactory = nodePtyFactory
  ) {}

  public async startTerminalSession(
    request: WorkbenchTerminalStartRequest,
    onOutput: (event: WorkbenchTerminalOutputEvent) => void,
    ownerId: Nullable<number> = null
  ): Promise<WorkbenchTerminalStartResult> {
    const projectRoot = await this.pathResolver.resolveProjectRoot(request.projectRoot)
    const cwdPath = await this.pathResolver.resolveInsideProject(projectRoot, request.cwd ?? '.')
    const cwdStats = await stat(cwdPath.realPath)
    if (!cwdStats.isDirectory()) {
      throw new AppError('VALIDATION', '工作台终端启动目录必须是目录。')
    }

    const initialCommand = request.initialCommand?.trim()
    const shellSpec = initialCommand
      ? this.commandHelper.getShellSpec(initialCommand)
      : {
          file: systemPlatformCompatibility.getPreferredShellPath(process.env),
          args: systemPlatformCompatibility.getInteractiveShellArgs(),
        }
    const cols = clampTerminalDimension(request.cols, DefaultTerminalColumns, MaxTerminalColumns)
    const rows = clampTerminalDimension(request.rows, DefaultTerminalRows, MaxTerminalRows)
    const sessionId = `terminal-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

    let pty: WorkbenchPtyProcess
    try {
      pty = this.ptyFactory.spawn(shellSpec.file, shellSpec.args, {
        cwd: cwdPath.realPath,
        env: buildTerminalEnvironment(process.env),
        cols,
        rows,
        name: TerminalName,
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
    }
    this.terminalSessions.set(sessionId, session)

    pty.onData((data) => this.queueOutput(sessionId, session, data))
    pty.onExit(({ exitCode, signal }) => {
      session.exited = true
      this.flushOutput(sessionId, session)
      // 终端里换行要 CR LF：xterm 不会替 LF 补回车。
      onOutput({
        sessionId,
        stream: 'system',
        chunk: `\r\n进程已结束（exit=${exitCode} signal=${signal ?? '-'}）\r\n`,
        closed: true,
        exitCode,
        signal: signal === undefined ? undefined : String(signal),
      })
      this.dropSession(sessionId, session)
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
   * 停止终端会话。
   *
   * `SIGINT` 是「打断」：往伪终端里写 Ctrl+C，行规程把 SIGINT 送给前台进程组，与在真终端里按 Ctrl+C 完全
   * 一样，shell 本身活着。默认硬停走 SIGTERM，延迟后仍未退出再 SIGKILL；伪终端关闭时，它上面的进程组会收到
   * SIGHUP，shell 起的子进程不会成为孤儿。
   */
  public stopTerminalSession(
    request: WorkbenchTerminalStopRequest,
    ownerId: Nullable<number> = null
  ): void {
    const session = this.terminalSessions.get(request.sessionId)
    if (!session) return
    assertSessionOwner(session, ownerId)

    if (request.signal === 'SIGINT') {
      session.pty.write(InterruptCharacter)
      return
    }

    session.pty.kill('SIGTERM')
    if (request.skipForceKill) return

    session.timers.after(this.commandHelper.getForceKillDelayMs(), () => {
      // sessionId 不会复用：仍在表里且还没退出，才是同一个进程。
      if (this.terminalSessions.get(request.sessionId) === session && !session.exited) {
        session.pty.kill('SIGKILL')
      }
    })
  }

  /** 关闭所有持久终端会话；进程退出前调用。 */
  public async closeAllSessions(): Promise<void> {
    await this.closeSessions([...this.terminalSessions.entries()])
  }

  /** 关闭一个项目窗口拥有的全部终端 / 运行卡，其他项目窗口不受影响。 */
  public async closeSessionsForOwner(ownerId: number): Promise<void> {
    await this.closeSessions(
      [...this.terminalSessions.entries()].filter(([, session]) => session.ownerId === ownerId)
    )
  }

  private liveSession(sessionId: string): WorkbenchTerminalSession {
    const session = this.terminalSessions.get(sessionId)
    if (!session || session.exited) throw new AppError('VALIDATION', '终端会话已结束。')
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
  }

  private dropSession(sessionId: string, session: WorkbenchTerminalSession): void {
    if (this.terminalSessions.get(sessionId) === session) this.terminalSessions.delete(sessionId)
    session.timers.dispose()
  }

  /**
   * 先 SIGTERM 让 shell 自行收尾，等待短超时后若还没退出再 SIGKILL，再兜底一秒后强制结算——
   * 给 shell 留下处理 trap 的窗口，也不让退出流程被一个僵掉的进程卡住。
   */
  private async closeSessions(
    sessions: Array<[string, WorkbenchTerminalSession]>
  ): Promise<void> {
    if (isEmpty(sessions)) return

    const forceKillDelayMs = this.commandHelper.getForceKillDelayMs()
    await Promise.all(
      sessions.map(
        ([sessionId, session]) =>
          new Promise<void>((resolve) => {
            if (session.exited) {
              this.dropSession(sessionId, session)
              resolve()
              return
            }

            let settled = false
            const finish = (): void => {
              if (settled) return
              settled = true
              this.dropSession(sessionId, session)
              resolve()
            }

            session.pty.onExit(finish)
            session.pty.kill('SIGTERM')
            session.timers.after(
              forceKillDelayMs,
              () => {
                if (!settled && !session.exited) session.pty.kill('SIGKILL')
                // 即便 SIGKILL，仍等 onExit 触发 finish；再兜底一秒强制结算。
                session.timers.after(1_000, finish, { unref: true })
              },
              { unref: true }
            )
          })
      )
    )
  }
}

function assertSessionOwner(session: WorkbenchTerminalSession, ownerId: Nullable<number>): void {
  if (ownerId === null || session.ownerId === null || ownerId === session.ownerId) return

  throw new AppError('PERMISSION', '终端会话不属于当前项目窗口。')
}

export { TerminalSessions, TerminalSessions as WorkbenchTerminalService }
