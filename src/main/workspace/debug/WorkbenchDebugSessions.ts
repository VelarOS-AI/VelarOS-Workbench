/**
 * Node.js 调试会话服务：起带检查器的程序、连上去、把界面的命令转给它。
 *
 * 键控轴与终端会话一样：service 单例（Parts 装配），会话按随机 `sessionId` 登记在进程内；每个会话记着发起它的
 * 窗口（`ownerId`），别的窗口动不了它。窗口关闭、切走项目时该窗口的会话一起结束，应用退出时全部结束。
 */
import { stat } from 'node:fs/promises'

import { AppError } from '@velaros-ai/velaros/core/error'

import { type WorkbenchTerminalOutputEvent } from '@shared/contracts/workbench'

import type {
  WorkbenchDebuggerControlRequest,
  WorkbenchDebuggerEvaluateRequest,
  WorkbenchDebuggerEvaluateResult,
  WorkbenchDebuggerEvent,
  WorkbenchDebuggerExceptionPauseRequest,
  WorkbenchDebuggerSessionRequest,
  WorkbenchDebuggerSetBreakpointsRequest,
  WorkbenchDebuggerSetBreakpointsResult,
  WorkbenchDebuggerStartRequest,
  WorkbenchDebuggerStartResult,
  WorkbenchDebuggerVariablesRequest,
  WorkbenchDebuggerVariablesResult,
} from '../../../shared/workbenchDebugger'
import { workbenchMainText } from '../../i18n/workbenchMainMessages'
import type { PathResolver } from '../PathResolver'

import {
  buildWorkbenchDebugCommand,
  findFreeLoopbackPort,
  type WorkbenchDebugLauncher,
} from './WorkbenchDebugLaunch'
import { WorkbenchDebugSession } from './WorkbenchDebugSession'

/** 等检查器就绪最多这么久：测试运行器要先起自己、再起跑测试的那个进程，比直接跑脚本慢。 */
const DefaultAttachTimeoutMs = 30_000

export interface WorkbenchDebugSessionHandlers {
  /** 会话的状态变化：发给发起调试的窗口。 */
  emit: (event: WorkbenchDebuggerEvent) => void
  /** 被调试程序的输出：同一个窗口的终端输出通道（界面把它画在运行卡里）。 */
  terminalOutput: (event: WorkbenchTerminalOutputEvent) => void
}

interface OwnedDebugSession {
  session: WorkbenchDebugSession
  ownerId: Nullable<number>
}

interface PendingDebugStart {
  ownerId: Nullable<number>
  completed: Promise<WorkbenchDebuggerStartResult>
  cleanup?: Promise<void>
}

class WorkbenchDebugSessions {
  private readonly sessions = new Map<string, OwnedDebugSession>()
  private readonly pendingStarts = new Map<AbortController, PendingDebugStart>()
  private readonly closingOwners = new Map<number, Promise<void>>()
  private closing?: Promise<void>

  public constructor(
    private readonly pathResolver: PathResolver,
    private readonly launcher: WorkbenchDebugLauncher,
    private readonly attachTimeoutMs: number = DefaultAttachTimeoutMs
  ) {}

  public startDebugSession(
    request: WorkbenchDebuggerStartRequest,
    handlers: WorkbenchDebugSessionHandlers,
    ownerId: Nullable<number> = null
  ): Promise<WorkbenchDebuggerStartResult> {
    if (this.closing || (ownerId !== null && this.closingOwners.has(ownerId)))
      return Promise.reject(new AppError('CLOSED', workbenchMainText('debug.sessionEnded')))
    const controller = new AbortController()
    const start: PendingDebugStart = {
      ownerId,
      completed: Promise.resolve().then(() =>
        this.createDebugSession(request, handlers, ownerId, controller.signal, start)
      ),
    }
    this.pendingStarts.set(controller, start)
    void start.completed
      .finally(() => this.pendingStarts.delete(controller))
      .catch(() => undefined)
    return start.completed
  }

  private async createDebugSession(
    request: WorkbenchDebuggerStartRequest,
    handlers: WorkbenchDebugSessionHandlers,
    ownerId: Nullable<number>,
    signal: AbortSignal,
    start: PendingDebugStart
  ): Promise<WorkbenchDebuggerStartResult> {
    signal.throwIfAborted()
    const projectRoot = await this.pathResolver.resolveProjectRoot(request.projectRoot)
    signal.throwIfAborted()
    const cwd = await this.pathResolver.resolveInsideProject(projectRoot, request.cwd ?? '.')
    if (!(await stat(cwd.realPath)).isDirectory())
      throw new AppError('VALIDATION', workbenchMainText('terminal.cwdNotFolder'))

    signal.throwIfAborted()
    const port = await findFreeLoopbackPort()
    const command = await buildWorkbenchDebugCommand(request.target, {
      projectRoot,
      cwd: cwd.realPath,
      port,
      pathResolver: this.pathResolver,
    })
    signal.throwIfAborted()
    const process = await this.launcher({
      projectRoot,
      cwd: cwd.realPath,
      command,
      env: request.env,
      cols: request.cols,
      rows: request.rows,
      ownerId,
      onOutput: handlers.terminalOutput,
    })

    try {
      signal.throwIfAborted()
      const sessionId = `debug-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      const session = new WorkbenchDebugSession({
        sessionId,
        projectRoot,
        process,
        port,
        pathResolver: this.pathResolver,
        breakpoints: request.breakpoints,
        pauseOnUncaughtExceptions: request.pauseOnUncaughtExceptions,
        skipInitialPause: request.target.kind === 'inspect-command',
        attachTimeoutMs: this.attachTimeoutMs,
        emit: handlers.emit,
        onEnded: () => {
          if (this.sessions.get(sessionId)?.session.process === process)
            this.sessions.delete(sessionId)
        },
      })
      signal.throwIfAborted()
      // 程序一起来就退了（命令不存在）：会话在构造时已经收口，不再登记。
      if (!session.hasEnded) this.sessions.set(sessionId, { session, ownerId })

      return {
        sessionId,
        terminalSessionId: process.terminalSessionId,
        command,
        cwd: process.cwd,
        shell: process.shell,
      }
    } catch (error) {
      // launcher 已交回资源但窗口不再接纳：启动与关闭双方都等待真实停止结果。
      start.cleanup = Promise.resolve().then(() => process.stop())
      try {
        await start.cleanup
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], 'Failed to release unaccepted debug process')
      }
      throw error
    }
  }

  /** 结束一个会话（整棵进程树）；已经结束的不算错。 */
  public async stopDebugSession(
    request: WorkbenchDebuggerSessionRequest,
    ownerId: Nullable<number> = null
  ): Promise<void> {
    const owned = this.sessions.get(request.sessionId)
    if (!owned) return
    assertSessionOwner(owned, ownerId)
    await owned.session.stop()
  }

  public async controlDebugSession(
    request: WorkbenchDebuggerControlRequest,
    ownerId: Nullable<number> = null
  ): Promise<void> {
    await this.liveSession(request.sessionId, ownerId).control(request.action)
  }

  public async setBreakpoints(
    request: WorkbenchDebuggerSetBreakpointsRequest,
    ownerId: Nullable<number> = null
  ): Promise<WorkbenchDebuggerSetBreakpointsResult> {
    return {
      breakpoints: await this.liveSession(request.sessionId, ownerId).setBreakpoints(
        request.breakpoints
      ),
    }
  }

  public async setExceptionPause(
    request: WorkbenchDebuggerExceptionPauseRequest,
    ownerId: Nullable<number> = null
  ): Promise<void> {
    await this.liveSession(request.sessionId, ownerId).setExceptionPause(request.uncaught)
  }

  public async getVariables(
    request: WorkbenchDebuggerVariablesRequest,
    ownerId: Nullable<number> = null
  ): Promise<WorkbenchDebuggerVariablesResult> {
    return this.liveSession(request.sessionId, ownerId).getVariables(request.objectId)
  }

  public async evaluate(
    request: WorkbenchDebuggerEvaluateRequest,
    ownerId: Nullable<number> = null
  ): Promise<WorkbenchDebuggerEvaluateResult> {
    return this.liveSession(request.sessionId, ownerId).evaluate(
      request.expression,
      request.frameId ?? null,
      request.sideEffectFree === true
    )
  }

  /**
   * 一个项目窗口关掉或切走项目：断开它名下的调试会话。被调试的进程跑在这个窗口的终端会话里，由终端那边
   * 一起结束。
   */
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

  /** 应用退出前：断开全部调试会话（进程随终端会话结束）。 */
  public closeAllSessions(): Promise<void> {
    if (this.closing) return this.closing
    const completion = Promise.withResolvers<void>()
    this.closing = completion.promise
    void this.closeOwnedSessions().then(completion.resolve, completion.reject)
    return completion.promise
  }

  private async closeOwnedSessions(ownerId?: number): Promise<void> {
    const pending = [...this.pendingStarts].filter(
      ([, start]) => ownerId === undefined || start.ownerId === ownerId
    )
    for (const [controller] of pending)
      controller.abort(new AppError('CANCELLED', workbenchMainText('debug.sessionEnded')))
    const errors: unknown[] = []
    for (const owned of [...this.sessions.values()]) {
      if (ownerId !== undefined && owned.ownerId !== ownerId) continue
      try {
        owned.session.dispose()
      } catch (error) {
        errors.push(error)
      }
    }
    await Promise.allSettled(pending.map(([, start]) => start.completed))
    const cleanup = await Promise.allSettled(
      pending.flatMap(([, start]) => (start.cleanup ? [start.cleanup] : []))
    )
    for (const outcome of cleanup) if (outcome.status === 'rejected') errors.push(outcome.reason)
    if (errors.length > 0) throw new AggregateError(errors, 'Failed to close debug sessions')
  }

  private liveSession(sessionId: string, ownerId: Nullable<number>): WorkbenchDebugSession {
    const owned = this.sessions.get(sessionId)
    if (!owned) throw new AppError('CLOSED', workbenchMainText('debug.sessionEnded'))
    assertSessionOwner(owned, ownerId)
    return owned.session
  }
}

function assertSessionOwner(owned: OwnedDebugSession, ownerId: Nullable<number>): void {
  if (ownerId === null || owned.ownerId === null || ownerId === owned.ownerId) return

  throw new AppError('PERMISSION', workbenchMainText('debug.sessionNotInWindow'))
}

export { WorkbenchDebugSessions }
