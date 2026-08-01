/**
 * 工作台持久终端会话服务（照搬 desktop `workspace/workbench/TerminalSessions.ts`，语义保形；
 * 依赖从 desktop 的 storage/commands Helpers 改为本目录裁剪版 CommandHelper + PathResolver，
 * 契约类型走 `@shared/contracts` 单源）。
 *
 * 键控轴对齐独立应用惯例：service 单例（Parts 装配），会话按请求 `projectRoot` 解析根、按自增
 * 随机 `sessionId` 登记进程内 Map——不引入 desktop 时代的 chat-session 轴（desktop 曾按 chat
 * 会话实例化整个 workbench 服务，独立应用只有 projectRoot）。`WorkbenchTerminalStartResult.sessionId`
 * 是 PTY 会话 id（非 chat sessionId），是本服务对外的持久句柄，保留。
 *
 * 踩坑要点（沿用 desktop 实现）：子进程用 pipe stdio（非 PTY），Ctrl+C 语义走 stop 的 SIGINT
 * 信号（signal/skipForceKill）而非写 \x03；运行卡 initialCommand/raw 输入跳过 cwd 探针（探针会被
 * 前台进程误读）；多卡 = 每次运行新开会话，支持重启/终止/清空。
 */
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { spawn } from 'node:child_process'
import { stat } from 'node:fs/promises'

import { isEmpty, isNotNull, isNull } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'
import { type TimerLease, TimerScope } from '@velaros-ai/core/utils/TimerScope'
import { systemPlatformCompatibility } from '@velaros-ai/system-tools/platform-compatibility'

import type {
  WorkbenchTerminalInputRequest,
  WorkbenchTerminalOutputEvent,
  WorkbenchTerminalStartRequest,
  WorkbenchTerminalStartResult,
  WorkbenchTerminalStopRequest,
} from '@shared/contracts'

import type { CommandHelper } from '../CommandHelper'
import type { PathResolver } from '../PathResolver'

import { buildTerminalCwdProbeCommand, scanTerminalCwdMarkers } from './terminalCwdMarker'

interface WorkbenchTerminalSession {
  /** spawn 出的真实 shell 子进程，stdio 全 pipe，便于把输出送回 renderer。 */
  child: ChildProcessWithoutNullStreams
  /** renderer 端回调，按 sessionId 把 stdout/stderr/system 事件转发回去。 */
  onOutput: (event: WorkbenchTerminalOutputEvent) => void
  /** 该终端会话的延迟强杀和兜底收口任务作用域。 */
  timers: TimerScope
  /**
   * 标记该会话是否已经走过停止/关闭流程；用于防止延迟强杀回调
   * 在 PID 复用场景下误伤新进程。一旦子进程关闭事件触发，整个会话从映射删除，
   * disposed=true 让停止流程上的延迟回调直接空操作。
   */
  disposed: boolean
}

/**
 * 工作台终端服务。
 *
 * 为工作台界面提供持久化终端会话：渲染进程通过进程通信启动一个终端
 * 子进程，写入键入内容并订阅标准输出和标准错误。所有会话都保存在进程内映射中，
 * 进程退出/出错时自动清理。
 */
class TerminalSessions {
  /** sessionId -> 会话实体；存活的子进程都在这里登记。 */
  private readonly terminalSessions = new Map<string, WorkbenchTerminalSession>()

  constructor(
    private readonly pathResolver: PathResolver,
    private readonly commandHelper: CommandHelper
  ) {}

  public async startTerminalSession(
    request: WorkbenchTerminalStartRequest,
    onOutput: (event: WorkbenchTerminalOutputEvent) => void
  ): Promise<WorkbenchTerminalStartResult> {
    const projectRoot = await this.pathResolver.resolveProjectRoot(request.projectRoot)
    const cwdPath = await this.pathResolver.resolveInsideProject(projectRoot, request.cwd ?? '.')
    const cwdStats = await stat(cwdPath.realPath)
    if (!cwdStats.isDirectory()) {
      throw new AppError('VALIDATION', '工作台终端启动目录必须是目录。')
    }

    const shell = systemPlatformCompatibility.getPreferredShellPath(process.env)
    const shellArgs = systemPlatformCompatibility.getInteractiveShellArgs()
    const sessionId = `terminal-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const timers = new TimerScope({ name: 'WorkbenchTerminalSession' })
    const child = spawn(shell, shellArgs, {
      cwd: cwdPath.realPath,
      detached: this.commandHelper.shouldDetachForegroundProcess(),
      env: {
        ...process.env,
        TERM: process.env.TERM || 'xterm-256color',
        VELAROS_WORKBENCH_TERMINAL: '1',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    const emit = (event: Omit<WorkbenchTerminalOutputEvent, 'sessionId'>): void => {
      onOutput({
        sessionId,
        ...event,
      })
    }

    // 跟随真实目录：扫描 stdout 里的 cwd 探针标记，剥掉后附在事件上回传给渲染层，
    // stdoutCarry 暂存跨 chunk 被切开的半截标记。
    let stdoutCarry = ''
    child.stdout.on('data', (chunk: Buffer | string) => {
      const scan = scanTerminalCwdMarkers(stdoutCarry + chunk.toString())
      stdoutCarry = scan.carry
      if (scan.text || isNotNull(scan.cwd)) {
        emit({ stream: 'stdout', chunk: scan.text, cwd: scan.cwd ?? undefined })
      }
    })
    child.stderr.on('data', (chunk: Buffer | string) => {
      emit({ stream: 'stderr', chunk: chunk.toString() })
    })
    child.on('error', (error) => {
      emit({
        stream: 'system',
        chunk: `终端启动失败：${error.message}\n`,
        closed: true,
      })
      const session = this.terminalSessions.get(sessionId)
      if (session) {
        session.disposed = true
        session.timers.dispose()
      }
      this.terminalSessions.delete(sessionId)
    })
    child.on('close', (exitCode, signal) => {
      emit({
        stream: 'system',
        chunk: `\n进程已结束（exit=${exitCode ?? '-'} signal=${signal ?? '-'}）\n`,
        closed: true,
        exitCode,
        signal,
      })
      const session = this.terminalSessions.get(sessionId)
      if (session) {
        session.disposed = true
        session.timers.dispose()
      }
      this.terminalSessions.delete(sessionId)
    })

    this.terminalSessions.set(sessionId, {
      child,
      onOutput,
      timers,
      disposed: false,
    })

    // 运行卡：起会话后立即执行配置命令。命令作为前台进程运行，其 stdin 直连该子进程，
    // 因此不追加 cwd 探针（探针会被前台进程误读）。
    const initialCommand = request.initialCommand?.trim()
    if (initialCommand && child.stdin.writable) {
      child.stdin.write(`${initialCommand}\n`)
    }

    return {
      sessionId,
      projectRoot,
      cwd: cwdPath.realPath,
      shell,
      startedAt: Date.now(),
    }
  }

  public writeTerminalInput(request: WorkbenchTerminalInputRequest): void {
    const session = this.terminalSessions.get(request.sessionId)
    if (!session || session.child.killed || !session.child.stdin.writable) {
      throw new AppError('VALIDATION', '终端会话已结束。')
    }

    session.child.stdin.write(request.input)

    // 一条完整命令（以换行提交）之后追加一次 cwd 探针，让提示符跟随用户的 cd。
    // 仅在提交（末尾换行）时追加，避免把探针拼进未完成的输入。
    // raw 输入（运行卡把内容直送前台进程 stdin）不追加探针，否则会被前台进程误读。
    if (!request.raw && request.input.endsWith('\n')) {
      session.child.stdin.write(buildTerminalCwdProbeCommand())
    }
  }

  /**
   * 停止终端会话。
   *
   * 先 SIGTERM 让 shell 自行收尾，延迟后若仍未退出再 SIGKILL。判断使用
   * sessionId 是否仍存在 map 中——child.on('close') 会负责 map.delete。
   *
   * sessionId 单调随机生成不会复用，因此不存在 PID 复用误杀新会话的风险；
   * disposed + exitCode + killed 三重判断保护延迟强杀不误伤已退出进程。
   */
  public stopTerminalSession(request: WorkbenchTerminalStopRequest): void {
    const session = this.terminalSessions.get(request.sessionId)
    if (!session) return

    // Ctrl+C 走 SIGINT（作用于前台进程组，等价终端中断），默认硬停走 SIGTERM。
    const signal = request.signal ?? 'SIGTERM'
    this.commandHelper.terminateForegroundProcess(session.child.pid, signal)

    // SIGINT 只是「打断」：不做 SIGKILL 兜底强杀，进程可能只是回到提示符继续存活。
    if (request.skipForceKill) return

    session.timers.after(this.commandHelper.getForceKillDelayMs(), () => {
      // 双重保护：1) sessionId 已被新会话替换或自然结束时不再 kill；
      // 2) session.disposed 为 true（child close 已触发）说明进程已退出，
      //    避免 PID 复用导致误杀新进程；3) child.exitCode === null 表明进程仍存活。
      const current = this.terminalSessions.get(request.sessionId)
      if (
        current === session &&
        !session.disposed &&
        isNull(session.child.exitCode) &&
        !session.child.killed
      ) {
        this.commandHelper.terminateForegroundProcess(session.child.pid, 'SIGKILL')
      }
    })
  }

  /**
   * 关闭所有持久终端会话；进程退出前调用。
   *
   * 流程：先对每个会话发 SIGTERM，等待短超时后若 'close' 未触发，统一 SIGKILL。
   * 用 SIGTERM → SIGKILL 二步策略给 shell 留下处理 trap 的窗口。
   */
  public async closeAllSessions(): Promise<void> {
    const sessions = [...this.terminalSessions.entries()]
    if (isEmpty(sessions)) return

    const forceKillDelayMs = this.commandHelper.getForceKillDelayMs()
    await Promise.all(
      sessions.map(
        ([sessionId, session]) =>
          new Promise<void>((resolve) => {
            if (session.disposed || isNotNull(session.child.exitCode)) {
              session.disposed = true
              this.terminalSessions.delete(sessionId)
              session.timers.dispose()
              resolve()
              return
            }

            let settled = false
            let killTimer: LooseOptional<TimerLease> = null
            const finish = (): void => {
              if (settled) return
              settled = true
              session.disposed = true
              killTimer?.cancel()
              this.terminalSessions.delete(sessionId)
              session.timers.dispose()
              resolve()
            }

            session.child.once('close', finish)
            session.child.once('exit', finish)

            this.commandHelper.terminateForegroundProcess(session.child.pid, 'SIGTERM')
            killTimer = session.timers.after(
              forceKillDelayMs,
              () => {
                if (!settled && isNull(session.child.exitCode) && !session.child.killed) {
                  this.commandHelper.terminateForegroundProcess(session.child.pid, 'SIGKILL')
                }
                // 即便 SIGKILL，仍等待 'close' 触发 finish；下方兜底超时强制结算。
                session.timers.after(1_000, finish, { unref: true })
              },
              { unref: true }
            )
          })
      )
    )
  }
}

export { TerminalSessions, TerminalSessions as WorkbenchTerminalService }
