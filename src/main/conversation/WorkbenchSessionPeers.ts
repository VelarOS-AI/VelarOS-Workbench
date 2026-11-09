import { randomUUID } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import { resolve } from 'node:path'

import type { SessionsSpacePort } from '@velaros-ai/capabilities/sessions'
import type {
  SessionAnswer,
  SessionAskInput,
  SessionPeer,
  SessionTellInput,
  SessionTold,
} from '@velaros-ai/capabilities/sessions/contracts'
import { Log } from '@velaros-ai/velaros/core'
import { AppError, createAbortError } from '@velaros-ai/velaros/core/error'

import type { WorkbenchConversationSendRequest } from '../../shared/workbenchConversation'
import type { WorkbenchPeerMember, WorkbenchPeerTask } from '../../shared/workbenchSessionPeers'

import type {
  WorkbenchConversationDispatcherApi,
  WorkbenchPreparedConversation,
} from './WorkbenchConversationDispatcher'
import type { WorkbenchConversationRef } from './WorkbenchConversationRuntime'

interface WorkbenchSessionPeersOptions {
  runtime: Pick<
    WorkbenchConversationDispatcherApi,
    'isRunning' | 'subscribeRunSettled' | 'subscribeRunOutcome' | 'submit' | 'guidance'
  >
  catalog(ref: WorkbenchConversationRef): readonly WorkbenchPeerMember[]
  /** 界面先建消息与运行卡，再由运行时发送；受理回执前不向调用方声称已送达。 */
  prepare(task: WorkbenchPeerTask, signal: AbortSignal): Promise<WorkbenchPreparedConversation>
  /** 只准备目标活动运行里的可见引导，不创建运行或检查点。 */
  prepareGuidance(task: WorkbenchPeerTask, signal: AbortSignal): Promise<void>
  /** 运行时已接纳引导；通知失败不能撤销该次投递。 */
  acceptGuidance(task: WorkbenchPeerTask): void
  cancelPreparation(task: WorkbenchPeerTask, message: string): void
}

const log = Log.tag('WorkbenchSessionPeers')

/** 当前项目内的会话协作：串行投递、按输入身份收结果，等待依赖成环时拒绝。 */
export class WorkbenchSessionPeers {
  private readonly requests = new Map<string, WorkbenchConversationSendRequest>()
  private readonly scopes = new Map<string, AbortController>()
  private readonly deliveries = new Map<string, Promise<void>>()
  private readonly waiting = new Map<string, Map<string, number>>()

  public constructor(private readonly options: WorkbenchSessionPeersOptions) {}

  public forSession(request: WorkbenchConversationSendRequest): SessionsSpacePort {
    this.requests.set(key(request), { ...request })
    return {
      list: async () =>
        this.members(request).map((member): SessionPeer => ({
          id: member.sessionId,
          title: member.title,
          workspace: 'project',
          root: request.projectRoot,
          site: null,
          running: this.options.runtime.isRunning({ ...request, sessionId: member.sessionId }),
          self: member.sessionId === request.sessionId,
        })),
      ask: (input, signal) => this.ask(request, input, signal),
      tell: (input, signal) => this.tell(request, input, signal),
    }
  }

  public releaseProject(projectRoot: string): void {
    const root = resolve(projectRoot)
    this.scopes.get(root)?.abort(createAbortError('项目已关闭。'))
    this.scopes.delete(root)
    for (const [id, request] of this.requests)
      if (resolve(request.projectRoot) === root) this.requests.delete(id)
  }

  public close(): void {
    for (const root of this.scopes.keys()) this.releaseProject(root)
  }

  private async ask(
    from: WorkbenchConversationRef,
    input: SessionAskInput,
    signal: AbortSignal
  ): Promise<SessionAnswer> {
    const scoped = this.signal(from, signal)
    scoped.throwIfAborted()
    const task = await this.task(from, input.to, input.task, input)
    scoped.throwIfAborted()
    const fromKey = key(from)
    const toKey = key(task)
    const waiting = this.waiting.get(fromKey) ?? new Map<string, number>()
    this.waiting.set(fromKey, waiting)
    waiting.set(toKey, (waiting.get(toKey) ?? 0) + 1)
    const outcome = this.outcome(task, scoped)
    try {
      this.assertNoDeadlock(fromKey, toKey)
      await this.deliver(from, task, scoped)
      return await outcome.result
    } finally {
      outcome.cancel()
      const count = (waiting.get(toKey) ?? 1) - 1
      if (count) waiting.set(toKey, count)
      else waiting.delete(toKey)
      if (!waiting.size) this.waiting.delete(fromKey)
    }
  }

  private async tell(
    from: WorkbenchConversationRef,
    input: SessionTellInput,
    signal: AbortSignal
  ): Promise<SessionTold> {
    const scoped = this.signal(from, signal)
    scoped.throwIfAborted()
    const task = await this.task(from, input.to, input.message)
    scoped.throwIfAborted()
    if (!this.options.runtime.isRunning(task))
      throw new AppError('UNAVAILABLE', '目标会话当前没有活动运行，不能追加引导。')
    let settled = false
    const stopWatching = this.options.runtime.subscribeRunSettled((ref) => {
      if (key(ref) === key(task)) settled = true
    })
    try {
      await this.options.prepareGuidance(task, scoped)
      scoped.throwIfAborted()
      if (!this.members(from).some((member) => member.sessionId === task.sessionId))
        throw new AppError('NOT_FOUND', '目标会话已关闭。')
      if (settled || !this.options.runtime.isRunning(task))
        throw new AppError('UNAVAILABLE', '目标会话当前没有活动运行，不能追加引导。')
      await this.options.runtime.guidance(task, { inputId: task.inputId, text: task.text })
    } catch (error) {
      this.options.cancelPreparation(task, AppError.getMessage(error))
      throw error
    } finally {
      stopWatching()
    }
    try {
      this.options.acceptGuidance(task)
    } catch (error) {
      log.warn('引导已接纳，目标窗口未收到接纳通知', { inputId: task.inputId, error })
    }
    return { session: task.sessionId, status: 'queued' }
  }

  private members(ref: WorkbenchConversationRef): readonly WorkbenchPeerMember[] {
    const members = this.options.catalog(ref)
    if (!members.some((member) => member.sessionId === ref.sessionId))
      throw new AppError('NOT_FOUND', '当前会话已不在项目会话列表中。')
    return members
  }

  private async task(
    from: WorkbenchConversationRef,
    to: string | undefined,
    body: string,
    input?: SessionAskInput
  ): Promise<WorkbenchPeerTask> {
    const members = this.members(from)
    if (to === from.sessionId) throw new AppError('CONFLICT', '请选择当前项目中的另一个会话。')
    if (to && !members.some((member) => member.sessionId === to))
      throw new AppError('NOT_FOUND', '目标会话必须在当前项目的会话列表中。')
    if (
      !to &&
      (input?.workspace !== 'project' ||
        !input.root ||
        (await realpath(input.root)) !== (await realpath(from.projectRoot)))
    )
      throw new AppError(
        'PERMISSION',
        'Workbench 的新会话使用当前项目，请将 workspace 设为 project，并将 root 设为当前项目目录。'
      )
    const request =
      this.requests.get(key({ ...from, sessionId: to ?? from.sessionId })) ??
      this.requests.get(key(from))
    if (!request) throw new AppError('UNAVAILABLE', '会话执行配置暂不可用。')
    const title = members.find((member) => member.sessionId === from.sessionId)?.title
    return {
      projectRoot: from.projectRoot,
      sourceSessionId: from.sessionId,
      sessionId: to ?? `workbench-peer-${randomUUID()}`,
      inputId: `peer-${randomUUID()}`,
      newSession: !to,
      text: `[来自会话 ${title ? `${title} · ` : ''}${from.sessionId} 的${input ? '任务' : '消息'}]\n\n${body}`,
    }
  }

  private async deliver(
    from: WorkbenchConversationRef,
    task: WorkbenchPeerTask,
    signal: AbortSignal
  ): Promise<void> {
    const id = key(task)
    const previous = this.deliveries.get(id)
    const next = (async () => {
      if (previous)
        await abortable(
          previous.catch(() => undefined),
          signal
        )
      signal.throwIfAborted()
      this.assertNoDeadlock(key(from), id)
      await this.untilIdle(task, signal)
      this.members(from)
      if (
        !task.newSession &&
        !this.members(from).some((member) => member.sessionId === task.sessionId)
      )
        throw new AppError('NOT_FOUND', '目标会话已关闭。')
      const configuration = this.requests.get(id) ?? this.requests.get(key(from))
      if (!configuration) throw new AppError('UNAVAILABLE', '会话执行配置暂不可用。')
      try {
        const submission = this.options.runtime.submit(
          (preparationSignal) => this.options.prepare(task, preparationSignal),
          {
            ...configuration,
            ...task,
            text: task.text,
            engine: undefined,
            images: undefined,
            executionModes: [],
          },
          signal
        )
        await submission.accepted
      } catch (error) {
        this.options.cancelPreparation(task, AppError.getMessage(error))
        throw error
      }
    })()
    this.deliveries.set(id, next)
    try {
      await next
    } finally {
      if (this.deliveries.get(id) === next) this.deliveries.delete(id)
    }
  }

  private async untilIdle(ref: WorkbenchConversationRef, signal: AbortSignal): Promise<void> {
    while (this.options.runtime.isRunning(ref)) {
      signal.throwIfAborted()
      let off = (): void => undefined
      const idle = new Promise<void>((done) => {
        off = this.options.runtime.subscribeRunSettled((settled) => {
          if (key(settled) === key(ref)) done()
        })
        if (!this.options.runtime.isRunning(ref)) done()
      })
      try {
        await abortable(idle, signal)
      } finally {
        off()
      }
    }
    signal.throwIfAborted()
  }

  private outcome(
    task: WorkbenchPeerTask,
    signal: AbortSignal
  ): { result: Promise<SessionAnswer>; cancel(): void } {
    let off = (): void => undefined
    const outcome = new Promise<SessionAnswer>((done) => {
      off = this.options.runtime.subscribeRunOutcome((event) => {
        if (key(event) === key(task) && event.inputId === task.inputId) done(event.result)
      })
    })
    const controller = new AbortController()
    const result = abortable(outcome, AbortSignal.any([signal, controller.signal])).finally(() =>
      off()
    )
    void result.catch(() => undefined)
    return { result, cancel: () => controller.abort(createAbortError('会话结果读取结束。')) }
  }

  private signal(ref: WorkbenchConversationRef, signal?: AbortSignal): AbortSignal {
    const root = resolve(ref.projectRoot)
    let scope = this.scopes.get(root)
    if (!scope) {
      scope = new AbortController()
      this.scopes.set(root, scope)
    }
    return signal ? AbortSignal.any([signal, scope.signal]) : scope.signal
  }

  private assertNoDeadlock(from: string, target: string): void {
    const seen = new Set<string>()
    const pending = [target]
    while (pending.length) {
      const current = pending.pop()!
      if (current === from)
        throw new AppError('CONFLICT', '会话正在互相等待回答，请先完成当前任务。')
      if (seen.has(current)) continue
      seen.add(current)
      pending.push(...(this.waiting.get(current)?.keys() ?? []))
    }
  }
}

function key(ref: WorkbenchConversationRef): string {
  return `${resolve(ref.projectRoot)}\0${ref.sessionId}`
}

/** 等待宿主回执时也响应取消，结束后及时撤销监听。 */
function abortable<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted()
  return new Promise<T>((yes, no) => {
    const abort = (): void => no(AppError.from(signal.reason))
    signal.addEventListener('abort', abort, { once: true })
    void pending.then(yes, no).finally(() => signal.removeEventListener('abort', abort))
  })
}
