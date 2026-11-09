/**
 * 界面这一侧的调试会话：起调试、收主进程推来的状态（连上了、停下了、继续了、结束了、断点对没对上）、把界面的
 * 动作（继续、单步、结束、选一帧、读变量、求值）转过去，并把断点的增删同步给正在跑的程序。
 *
 * 一个窗口一次只调试一个程序：新的一次开始之前先结束上一次。状态是模块里的一份快照，调试面板和编辑器
 * （停在哪一行、断点对没对上、悬停看值）都订阅它。这个模块按需加载——第一次起调试、或者编辑器挂上时才来。
 */
import { Log } from '@velaros-ai/velaros/core'
import { AppError, type ErrorCode } from '@velaros-ai/velaros/core/error'

import type {
  WorkbenchDebuggerBreakpoint,
  WorkbenchDebuggerBreakpointStatus,
  WorkbenchDebuggerBridge,
  WorkbenchDebuggerEndReason,
  WorkbenchDebuggerEvaluateResult,
  WorkbenchDebuggerEvent,
  WorkbenchDebuggerFrame,
  WorkbenchDebuggerPauseReason,
  WorkbenchDebuggerStartResult,
  WorkbenchDebuggerValue,
  WorkbenchDebuggerVariablesResult,
} from '@shared/workbenchDebugger'

import {
  readWorkbenchBreakpoints,
  readWorkbenchExceptionPause,
  subscribeWorkbenchBreakpoints,
} from './workbenchBreakpoints'
import {
  installWorkbenchDebugActionRunner,
  openWorkbenchDebugPanel,
  publishWorkbenchDebugStatus,
  revealWorkbenchDebugLocation,
  type WorkbenchDebugAction,
  type WorkbenchDebugStartOptions,
  type WorkbenchDebugStatus,
} from './workbenchDebugBridge'

export interface WorkbenchDebugActiveSession {
  sessionId: string
  /** 承载程序的终端会话（那张运行卡）。 */
  terminalSessionId: string
  projectRoot: string
}

export interface WorkbenchDebugPause {
  /** 每停一次加一：上一次停下时拿到的对象（变量、求值结果的 objectId）到这时已经作废。 */
  sequence: number
  reason: WorkbenchDebuggerPauseReason
  /** 调用栈，最里层在前。 */
  frames: WorkbenchDebuggerFrame[]
  /** 停在异常上时：抛出来的值。 */
  exception: Nullable<WorkbenchDebuggerValue>
  /** 面板里选中的那一帧：变量、求值、编辑器里高亮的行都按它来。 */
  selectedFrameIndex: number
}

export interface WorkbenchDebugEnd {
  reason: WorkbenchDebuggerEndReason
  exitCode: Nullable<number>
  message: Nullable<string>
}

export interface WorkbenchDebugSnapshot {
  /** 正在调试的那一次；没有在调试为 null。 */
  session: Nullable<WorkbenchDebugActiveSession>
  /** 此刻停着时的现场；程序在跑为 null。 */
  pause: Nullable<WorkbenchDebugPause>
  /** 各断点在正在跑的程序里对没对上代码：`断点键` → 状态。没在调试是空表。 */
  breakpointStatuses: ReadonlyMap<string, WorkbenchDebuggerBreakpointStatus>
  /** 上一次调试是怎么结束的；还没调试过、或者新的一次已经开始，为 null。 */
  lastEnd: Nullable<WorkbenchDebugEnd>
}

/** 会话依赖的外部东西：生产里是主进程的桥、断点存储、外壳的桥；测试里换成假的。 */
export interface WorkbenchDebugSessionDependencies {
  /** 主进程的调试器桥；用到的时候才取（建会话对象本身不碰它）。 */
  debuggerBridge: () => WorkbenchDebuggerBridge
  readBreakpoints: (projectRoot: string) => readonly WorkbenchDebuggerBreakpoint[]
  readExceptionPause: (projectRoot: string) => boolean
  subscribeBreakpoints: (listener: () => void) => () => void
  publishStatus: (status: WorkbenchDebugStatus) => void
  revealLocation: (location: { path: string; line: number; column: number }) => void
  openPanel: () => void
}

const EmptySnapshot: WorkbenchDebugSnapshot = {
  session: null,
  pause: null,
  breakpointStatuses: new Map(),
  lastEnd: null,
}

const log = Log.tag('WorkbenchDebugSession')

export function workbenchBreakpointKey(path: string, line: number): string {
  return `${path.replace(/\\/gu, '/')}\0${line}`
}

function toStatusMap(
  statuses: readonly WorkbenchDebuggerBreakpointStatus[]
): Map<string, WorkbenchDebuggerBreakpointStatus> {
  return new Map(
    statuses.map((status) => [workbenchBreakpointKey(status.path, status.line), status])
  )
}

export class WorkbenchDebugSessionController {
  private snapshot: WorkbenchDebugSnapshot = EmptySnapshot
  private readonly listeners = new Set<() => void>()
  private subscribed = false
  /** 起调试是一个接一个做的：连点两下不会起出两个没人管的程序。 */
  private startQueue: Promise<unknown> = Promise.resolve()
  /** 正在等主进程回「起好了」：这期间到的事件先攒着，知道会话 id 之后再处理。 */
  private starting = false
  private pendingEvents: WorkbenchDebuggerEvent[] = []
  private pauseSequence = 0
  /** 已经交给正在跑的程序的那份断点与异常开关：变了才再发。 */
  private sentBreakpoints: Nullable<readonly WorkbenchDebuggerBreakpoint[]> = null
  private sentExceptionPause: Nullable<boolean> = null
  /** 同一程序的配置有序确认；旧回执不能越过后一次变更。 */
  private breakpointSync: Promise<void> = Promise.resolve()

  public constructor(private readonly dependencies: WorkbenchDebugSessionDependencies) {}

  public readonly getSnapshot = (): WorkbenchDebugSnapshot => this.snapshot

  public readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** 起一次调试。起不来时抛出带着原因的错误，状态回到没有在调试。 */
  public start(options: WorkbenchDebugStartOptions): Promise<WorkbenchDebuggerStartResult> {
    const started = this.startQueue.then(() => this.startNow(options))
    this.startQueue = started.catch(() => undefined)
    return started
  }

  public async stop(): Promise<void> {
    const session = this.snapshot.session
    if (session) await this.dependencies.debuggerBridge().stop({ sessionId: session.sessionId })
  }

  /** 界面上的一个动作（快捷键、面板按钮、命令面板）。此刻做不了的由主进程那边忽略。 */
  public runAction(action: WorkbenchDebugAction): void {
    const session = this.snapshot.session
    if (!session) return

    if (action === 'stop') void this.stop()
    else void this.dependencies.debuggerBridge().control({ sessionId: session.sessionId, action })
  }

  /** 选调用栈里的一帧：变量、求值、编辑器里高亮的行跟着换，文件在项目里的带到眼前。 */
  public selectFrame(index: number): void {
    const pause = this.snapshot.pause
    const frame = pause?.frames[index]
    if (!pause || !frame) return

    if (pause.selectedFrameIndex !== index)
      this.update({ pause: { ...pause, selectedFrameIndex: index } })
    this.revealFrame(frame)
  }

  /** 展开一个对象或作用域；会话已经不在、对象已经作废时为 null。 */
  public async getVariables(objectId: string): Promise<Nullable<WorkbenchDebuggerVariablesResult>> {
    const session = this.snapshot.session
    if (!session) return null

    const result = await this.dependencies.debuggerBridge().getVariables({
      sessionId: session.sessionId,
      objectId,
    })
    return result.ok ? result.value : null
  }

  /**
   * 求一个表达式：停着时在选中的那一帧里求，程序在跑时在全局求。`sideEffectFree` 让有副作用的表达式直接失败
   * （悬停看值用）。
   */
  public async evaluate(
    expression: string,
    options: { sideEffectFree?: boolean } = {}
  ): Promise<WorkbenchDebuggerEvaluateResult> {
    const { session, pause } = this.snapshot
    if (!session) return { value: null, error: '' }

    const result = await this.dependencies.debuggerBridge().evaluate({
      sessionId: session.sessionId,
      expression,
      frameId: pause?.frames[pause.selectedFrameIndex]?.id,
      sideEffectFree: options.sideEffectFree === true,
    })
    return result.ok ? result.value : { value: null, error: result.message }
  }

  private update(patch: Partial<WorkbenchDebugSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch }
    for (const listener of [...this.listeners]) listener()
  }

  private ensureSubscribed(): void {
    if (this.subscribed) return
    this.subscribed = true
    this.dependencies.debuggerBridge().onEvent((event) => this.receive(event))
    this.dependencies.subscribeBreakpoints(() => void this.syncBreakpoints())
  }

  private async startNow(
    options: WorkbenchDebugStartOptions
  ): Promise<WorkbenchDebuggerStartResult> {
    // 一次只调试一个：先结束上一个（它的运行卡留着，标成已结束）。
    await this.stop()
    this.ensureSubscribed()

    const breakpoints = this.dependencies.readBreakpoints(options.projectRoot)
    const pauseOnUncaughtExceptions = this.dependencies.readExceptionPause(options.projectRoot)
    this.starting = true
    this.pendingEvents = []
    try {
      const result = await this.dependencies.debuggerBridge().start({
        projectRoot: options.projectRoot,
        target: options.target,
        cwd: options.cwd,
        env: options.env,
        breakpoints: [...breakpoints],
        pauseOnUncaughtExceptions,
      })
      if (!result.ok) throw new AppError((result.code ?? 'UNKNOWN') as ErrorCode, result.message)

      this.sentBreakpoints = breakpoints
      this.sentExceptionPause = pauseOnUncaughtExceptions
      this.update({
        session: {
          sessionId: result.value.sessionId,
          terminalSessionId: result.value.terminalSessionId,
          projectRoot: options.projectRoot,
        },
        pause: null,
        breakpointStatuses: new Map(),
        lastEnd: null,
      })
      this.dependencies.publishStatus('running')
      this.starting = false
      for (const event of this.pendingEvents.splice(0)) this.receive(event)
      await this.syncBreakpoints()
      return result.value
    } finally {
      this.starting = false
      this.pendingEvents = []
    }
  }

  private receive(event: WorkbenchDebuggerEvent): void {
    const session = this.snapshot.session
    if (event.sessionId !== session?.sessionId) {
      // 「起好了」的回复还没到，它的事件先到了：攒着。别的会话（上一次的尾巴）的事件不要。
      if (this.starting) this.pendingEvents.push(event)
      return
    }

    switch (event.type) {
      case 'attached':
        return
      case 'paused': {
        this.pauseSequence += 1
        // 最里层可能是 Node 内部的代码（异常是在那里抛的）：选中最靠里的、项目里有文件的那一帧。
        const selectedFrameIndex = Math.max(
          0,
          event.frames.findIndex((frame) => frame.location.path !== null)
        )
        this.update({
          pause: {
            sequence: this.pauseSequence,
            reason: event.reason,
            frames: event.frames,
            exception: event.exception,
            selectedFrameIndex,
          },
        })
        this.dependencies.publishStatus('paused')
        // 单步走出来的停顿不去动底部的面板：用户可能正开着运行卡看输出，一步一步走的时候不把它换走。
        if (event.reason !== 'step') this.dependencies.openPanel()
        this.revealFrame(event.frames[selectedFrameIndex])
        return
      }
      case 'resumed':
        this.update({ pause: null })
        this.dependencies.publishStatus('running')
        return
      case 'breakpoints':
        this.update({ breakpointStatuses: toStatusMap(event.breakpoints) })
        return
      case 'ended':
        this.sentBreakpoints = null
        this.sentExceptionPause = null
        this.update({
          session: null,
          pause: null,
          breakpointStatuses: new Map(),
          lastEnd: { reason: event.reason, exitCode: event.exitCode, message: event.message },
        })
        this.dependencies.publishStatus('idle')
        // 没连上检查器：程序也许照常跑着，但断点一个都不会停。把面板带出来，上面写着原因。
        if (event.reason === 'failed') this.dependencies.openPanel()
    }
  }

  private revealFrame(frame: LooseOptional<WorkbenchDebuggerFrame>): void {
    const location = frame?.location
    if (location?.path)
      this.dependencies.revealLocation({
        path: location.path,
        line: location.line,
        column: location.column,
      })
  }

  /** 断点或异常开关变了：正在调试这个项目的话，把新的一份交给正在跑的程序。 */
  private syncBreakpoints(): Promise<void> {
    const sessionId = this.snapshot.session?.sessionId
    if (!sessionId || this.starting) return Promise.resolve()

    const pending = this.breakpointSync.then(() => this.syncCurrentBreakpoints(sessionId))
    this.breakpointSync = pending.catch((error: unknown) => {
      if (this.snapshot.session?.sessionId === sessionId)
        log.warn('同步调试断点或异常暂停设置失败', { sessionId, error: AppError.getMessage(error) })
    })
    return this.breakpointSync
  }

  private async syncCurrentBreakpoints(sessionId: string): Promise<void> {
    const session = this.snapshot.session
    if (!session || session.sessionId !== sessionId) return

    const pauseOnUncaughtExceptions = this.dependencies.readExceptionPause(session.projectRoot)
    if (pauseOnUncaughtExceptions !== this.sentExceptionPause) {
      try {
        const result = await this.dependencies.debuggerBridge().setExceptionPause({
          sessionId,
          uncaught: pauseOnUncaughtExceptions,
        })
        if (!result.ok) throw new AppError(result.code ?? 'UNKNOWN', result.message)
        if (this.snapshot.session?.sessionId !== sessionId) return
        this.sentExceptionPause = pauseOnUncaughtExceptions
      } catch (error) {
        if (this.snapshot.session?.sessionId === sessionId) this.sentExceptionPause = null
        throw error
      }
    }

    const breakpoints = this.dependencies.readBreakpoints(session.projectRoot)
    if (breakpoints === this.sentBreakpoints) return
    try {
      const result = await this.dependencies.debuggerBridge().setBreakpoints({
        sessionId,
        breakpoints: [...breakpoints],
      })
      if (!result.ok) throw new AppError(result.code ?? 'UNKNOWN', result.message)
      if (this.snapshot.session?.sessionId !== sessionId) return
      this.sentBreakpoints = breakpoints
      this.update({ breakpointStatuses: toStatusMap(result.value.breakpoints) })
    } catch (error) {
      if (this.snapshot.session?.sessionId === sessionId) this.sentBreakpoints = null
      throw error
    }
  }
}

let controller: Nullable<WorkbenchDebugSessionController> = null

/** 这个窗口的调试会话（第一次用到时建好，并接上外壳的桥）。 */
export function getWorkbenchDebugSession(): WorkbenchDebugSessionController {
  if (!controller) {
    const created = new WorkbenchDebugSessionController({
      debuggerBridge: () => window.velarosWorkbenchDebugger,
      readBreakpoints: readWorkbenchBreakpoints,
      readExceptionPause: readWorkbenchExceptionPause,
      subscribeBreakpoints: subscribeWorkbenchBreakpoints,
      publishStatus: publishWorkbenchDebugStatus,
      revealLocation: revealWorkbenchDebugLocation,
      openPanel: openWorkbenchDebugPanel,
    })
    installWorkbenchDebugActionRunner((action) => created.runAction(action))
    controller = created
  }
  return controller
}

export function startWorkbenchDebugSession(
  options: WorkbenchDebugStartOptions
): Promise<WorkbenchDebuggerStartResult> {
  return getWorkbenchDebugSession().start(options)
}

/** 编辑器里这个文件此刻该高亮哪一行：停着、选中的那一帧就在这个文件里才有。 */
export function readWorkbenchDebugPausedLine(
  snapshot: WorkbenchDebugSnapshot,
  projectRoot: string,
  path: string
): Nullable<{ line: number; topFrame: boolean }> {
  const { session, pause } = snapshot
  if (!session || !pause || session.projectRoot !== projectRoot) return null

  const location = pause.frames[pause.selectedFrameIndex]?.location
  if (!location || location.path !== path.replace(/\\/gu, '/')) return null
  return { line: location.line, topFrame: pause.selectedFrameIndex === 0 }
}
