import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'

import type { InteractionAnswer } from '@velaros-ai/ui/conversation/contracts'
import { AppError } from '@velaros-ai/velaros/core/error'

import type {
  WorkbenchAgentEngineId,
  WorkbenchAgentEngineStatus,
  WorkbenchConversationCancelResult,
  WorkbenchConversationSendRequest,
} from '../../shared/workbenchConversation'
import type {
  WorkbenchConversationRef,
  WorkbenchConversationSink,
} from '../conversation/WorkbenchConversationRuntime'
import { workbenchMainText } from '../i18n/workbenchMainMessages'
import type { WorkbenchAgentProjectActivityPort } from '../workspace/git/WorkbenchChatRunAttribution'

import { EngineRunSurface } from './WorkbenchEngineRunSurface'
import type { WorkbenchEngineSessionStore } from './WorkbenchEngineSessionStore'
import type { WorkbenchAgentEngine } from './WorkbenchEngineTypes'

/** 引擎在本机的情况缓存这么久：装好、登录之后不用重启 Workbench 就能用上。 */
const StatusCacheMs = 60_000

interface EngineActiveRun {
  readonly controller: AbortController
  readonly surface: EngineRunSurface
  completed: Promise<void>
}

export interface WorkbenchEngineConversationRuntimeOptions {
  engines: readonly WorkbenchAgentEngine[]
  sessions: WorkbenchEngineSessionStore
  /** 这一轮 Agent 改项目的时间窗报到哪里（「本轮改动」的归属账本）。 */
  activity?(ref: WorkbenchConversationRef): WorkbenchAgentProjectActivityPort
  /** 引擎改完的文件（相对项目根）：告诉语言服务，不等文件监听。 */
  projectFilesEdited?(ref: WorkbenchConversationRef, paths: readonly string[]): void
}

/**
 * 交给外部引擎（Claude Code、Codex）的会话：一轮一次引擎运行，展示经 {@link EngineRunSurface} 变成与 Platform
 * 运行同一套通知与状态。引擎自己持有上下文，这里只记下 Workbench 会话对应的引擎会话，下一轮接着它。
 */
export class WorkbenchEngineConversationRuntime {
  private readonly engines: ReadonlyMap<WorkbenchAgentEngineId, WorkbenchAgentEngine>
  private readonly active = new Map<string, EngineActiveRun>()
  private readonly statuses = new Map<
    WorkbenchAgentEngineId,
    { at: number; status: Promise<WorkbenchAgentEngineStatus> }
  >()
  private closing?: Promise<void>

  public constructor(private readonly options: WorkbenchEngineConversationRuntimeOptions) {
    this.engines = new Map(options.engines.map((engine) => [engine.id, engine]))
  }

  /** 这个会话有一轮引擎运行正在跑。 */
  public has(ref: WorkbenchConversationRef): boolean {
    return this.active.has(runKey(ref))
  }

  public submit(
    sink: WorkbenchConversationSink,
    request: WorkbenchConversationSendRequest
  ): { accepted: Promise<void>; completed: Promise<void> } {
    const selection = request.engine
    const engine = selection && this.engines.get(selection.id)
    if (!selection || !engine)
      throw new AppError('VALIDATION', workbenchMainText('engines.unknownEngine'))
    const key = runKey(request)
    if (this.closing) throw new AppError('VALIDATION', workbenchMainText('conversation.closing'))
    if (this.active.has(key))
      throw new AppError('VALIDATION', workbenchMainText('engines.conversationBusy'))
    const ref: WorkbenchConversationRef = {
      projectRoot: request.projectRoot,
      sessionId: request.sessionId,
    }
    let accept!: () => void
    let reject!: (error: unknown) => void
    const accepted = new Promise<void>((yes, no) => {
      accept = yes
      reject = no
    })
    const controller = new AbortController()
    const run: EngineActiveRun = {
      controller,
      surface: new EngineRunSurface({
        sink,
        runId: `engine-${randomUUID()}`,
        activity: this.options.activity?.(ref),
        filesEdited: (paths) => this.options.projectFilesEdited?.(ref, paths),
      }),
      completed: Promise.resolve(),
    }
    this.active.set(key, run)
    run.completed = this.consume(engine, sink, request, ref, run, accept)
      .catch((error: unknown) => {
        reject(error)
        throw error
      })
      .finally(() => {
        if (this.active.get(key) === run) this.active.delete(key)
      })
    // 同时观察两张回执，避免 IPC 还在等 accepted 时 completed 的拒绝没人接。
    void Promise.allSettled([accepted, run.completed])
    return { accepted, completed: run.completed }
  }

  public async cancel(ref: WorkbenchConversationRef): Promise<WorkbenchConversationCancelResult> {
    const run = this.active.get(runKey(ref))
    if (!run) return { aborted: false }
    run.controller.abort(new AppError('CANCELLED', workbenchMainText('conversation.runStopped')))
    await Promise.allSettled([run.completed])
    return { aborted: true }
  }

  public async input(ref: WorkbenchConversationRef, answer: string): Promise<void> {
    this.require(ref).surface.answerInput(answer)
  }

  public async answer(
    ref: WorkbenchConversationRef,
    requestId: string,
    answer: InteractionAnswer
  ): Promise<void> {
    this.require(ref).surface.answer(requestId, answer)
  }

  /** 会话删了：停下它的运行，忘掉它在各引擎里的会话身份（引擎自己的会话记录留在引擎那边）。 */
  public async deleteSession(ref: WorkbenchConversationRef): Promise<void> {
    await this.cancel(ref)
    await this.options.sessions.delete(ref)
  }

  public async cancelProject(projectRoot: string): Promise<void> {
    const prefix = `${resolve(projectRoot)}\0`
    const runs = [...this.active.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .map(([, run]) => run)
    for (const run of runs)
      run.controller.abort(new AppError('CANCELLED', workbenchMainText('conversation.runStopped')))
    await Promise.allSettled(runs.map((run) => run.completed))
  }

  /** 各引擎在本机的情况；探一次要起一回命令行，结果缓存一分钟，refresh 时重探。 */
  public async status(refresh = false): Promise<WorkbenchAgentEngineStatus[]> {
    const now = Date.now()
    return Promise.all(
      [...this.engines.values()].map((engine) => {
        const cached = this.statuses.get(engine.id)
        if (cached && !refresh && now - cached.at < StatusCacheMs) return cached.status
        const status = engine.status()
        this.statuses.set(engine.id, { at: now, status })
        return status
      })
    )
  }

  public close(): Promise<void> {
    this.closing ??= (async () => {
      const runs = [...this.active.values()]
      for (const run of runs)
        run.controller.abort(
          new AppError('CANCELLED', workbenchMainText('conversation.runStopped'))
        )
      await Promise.allSettled(runs.map((run) => run.completed))
      await Promise.allSettled([...this.engines.values()].map((engine) => engine.close()))
    })()
    return this.closing
  }

  private require(ref: WorkbenchConversationRef): EngineActiveRun {
    const run = this.active.get(runKey(ref))
    if (!run) throw new AppError('VALIDATION', workbenchMainText('conversation.noActiveRun'))
    return run
  }

  private async consume(
    engine: WorkbenchAgentEngine,
    sink: WorkbenchConversationSink,
    request: WorkbenchConversationSendRequest,
    ref: WorkbenchConversationRef,
    run: EngineActiveRun,
    accept: () => void
  ): Promise<void> {
    const { signal } = run.controller
    let admitted = false
    let failure: unknown
    let status: 'completed' | 'aborted' = 'completed'
    try {
      sink.state({ kind: 'phase', teamPhase: 'researching' })
      const resume = await this.options.sessions.get(engine.id, ref)
      signal.throwIfAborted()
      status = (
        await engine.run({
          ref,
          text: request.text,
          images: request.images ?? [],
          model: request.engine?.model,
          reasoningLevel: request.reasoningLevel,
          executionModes: request.executionModes,
          permissionMode: request.permissionMode,
          locale: request.locale,
          resume,
          surface: run.surface,
          sessionStarted: (nativeId) => this.options.sessions.set(engine.id, ref, nativeId),
          sessionLost: () => this.options.sessions.delete(ref, engine.id),
          accepted: () => {
            if (admitted) return
            admitted = true
            accept()
          },
          signal,
        })
      ).status
      if (status === 'completed' && !admitted)
        throw new AppError('PROTOCOL', workbenchMainText('engines.inputNotAccepted'))
    } catch (error) {
      failure = error
    } finally {
      run.surface.settle({ aborted: signal.aborted || status === 'aborted' })
    }
    if (signal.aborted || (!failure && status === 'aborted')) {
      sink.state({ kind: 'aborted', message: workbenchMainText('conversation.runStopped') })
      if (!admitted) throw new AppError('CANCELLED', workbenchMainText('conversation.runStopped'))
      return
    }
    if (failure) {
      const message = AppError.getMessage(failure)
      sink.state({ kind: 'error', message })
      if (!admitted) throw AppError.from(failure)
      return
    }
    sink.state({ kind: 'done' })
  }
}

function runKey(ref: WorkbenchConversationRef): string {
  return `${resolve(ref.projectRoot)}\0${ref.sessionId}`
}
