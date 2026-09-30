import { isNonBlankString, isPlainObject, isString } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'
import type { InteractionAnswer } from '@velaros-ai/ui/conversation/contracts'

import {
  ConversationInteractionLimits,
  ConversationInteractionNotice,
  type ConversationInteractionProjection,
  ConversationProjectActivityNotice,
  ConversationTextNotice,
  ConversationThinkingNotice,
  ConversationToolCallLimits,
  ConversationToolCallNotice,
  type ConversationToolCallProjection,
} from '../../shared/workbenchConversation'
import { ConversationTextBoard } from '../conversation/ConversationText'
import { ConversationThinkingBoard } from '../conversation/ConversationThinking'
import type { WorkbenchConversationSink } from '../conversation/WorkbenchConversationRuntime'
import { workbenchMainText } from '../i18n/workbenchMainMessages'
import type { WorkbenchAgentProjectActivityPort } from '../workspace/git/WorkbenchChatRunAttribution'

/** 同一次运行里一张工具卡两次进度之间至少隔多久，毫秒；与正文、思考同一个节奏。 */
const ToolProgressIntervalMs = 150

/** 要用户点头的一件事。 */
export interface EngineConfirmation {
  /** 卡上第一行：等回答时卡片只显示这一行，要一眼看得懂要做什么。 */
  title: string
  /** 其余说明（理由、完整路径），回答后点开回看。 */
  detail?: string
  /** 危险命令：卡片画成危险确认，带上命令与工作目录。 */
  danger?: { command: string; cwd?: string }
}

/** 要用户回答的一道题；带选项的是选择题，不带的是一句话的提问。 */
export interface EngineQuestion {
  /** 题目；标题一行写不下的其余部分照样显示在题目下面。 */
  question: string
  options?: ReadonlyArray<{ label: string; description?: string }>
  multiple?: boolean
  /** 选项之外还能自己写。 */
  allowText?: boolean
}

/** 一道题的回答：选中的选项文字（按选项顺序）与自己写的话；跳过时两样都空。 */
export interface EngineQuestionAnswer {
  declined: boolean
  choices: string[]
  text?: string
}

interface PendingInteraction {
  readonly card: ConversationInteractionProjection
  readonly resolve: (answer: InteractionAnswer) => void
  readonly reject: (error: unknown) => void
}

export interface EngineRunSurfaceOptions {
  sink: WorkbenchConversationSink
  runId: string
  /** 这一轮 Agent 改项目的时间窗报到这里（「本轮改动」的归属账本）。 */
  activity?: WorkbenchAgentProjectActivityPort
  /** 引擎改完了这些文件（相对项目根）：告诉语言服务，不等文件监听。 */
  filesEdited?(paths: readonly string[]): void
}

/**
 * 一轮外部引擎运行的展示面：引擎的正文、思考、工具调用、确认与提问经这里变成与 Platform 运行同一套通知，
 * 界面不用分辨是谁在跑。正文与思考沿用节流的两块账；工具卡、交互卡发出前先把欠着的正文发掉，顺序与引擎
 * 吐出来的一致。收尾时没接纳的正文按接纳收、没跑完的工具卡按停止收、没答的卡按失效收。
 */
export class EngineRunSurface {
  public readonly runId: string
  private readonly sink: WorkbenchConversationSink
  private readonly text: ConversationTextBoard
  private readonly thinking: ConversationThinkingBoard
  /** 还没接纳的正文段 → 到目前为止的全文。 */
  private readonly segments = new Map<string, string>()
  private readonly tools = new Map<string, ConversationToolCallProjection>()
  private readonly owedProgress = new Set<string>()
  private progressTimer?: ReturnType<typeof setTimeout>
  private progressPublishedAt = 0
  private readonly pending = new Map<string, PendingInteraction>()
  private readonly windows = new Map<string, () => void>()
  private interactionSequence = 0
  private currentPhase?: 'researching' | 'executing'
  private retries = 0

  public constructor(private readonly options: EngineRunSurfaceOptions) {
    this.runId = options.runId
    this.sink = options.sink
    this.text = new ConversationTextBoard((payload) =>
      this.sink.notice(ConversationTextNotice, payload)
    )
    this.thinking = new ConversationThinkingBoard((payload) =>
      this.sink.notice(ConversationThinkingNotice, payload)
    )
  }

  /** 状态行：模型在想还是工具在跑。有卡在等回答时不动它（等待状态跟着卡走）。 */
  public phase(teamPhase: 'researching' | 'executing'): void {
    if (this.pending.size > 0 || this.currentPhase === teamPhase) return
    this.currentPhase = teamPhase
    this.sink.state({ kind: 'phase', teamPhase })
  }

  /** 引擎在重试（接口限流、连接断了）：状态行显示它的说明，下一个进展到来时自然清掉。 */
  public reconnecting(message: string): void {
    this.retries += 1
    this.currentPhase = undefined
    this.sink.state({ kind: 'reconnecting', attempt: this.retries, message })
  }

  // -------------------------------------------------------------------------------------------
  // 正文与思考
  // -------------------------------------------------------------------------------------------

  /** 这一段正文又到了一些字。段身份由引擎给（一条回复里的一个内容块）。 */
  public appendText(segment: string, delta: string): void {
    if (!delta) return
    this.thinking.flush()
    const text = (this.segments.get(segment) ?? '') + delta
    this.segments.set(segment, text)
    this.text.preview(this.textProjection(segment, 'preview', text))
  }

  /** 这一段正文写完了：按接纳发出；给了全文就以全文为准（没有逐字到过的段也走这里）。 */
  public finishText(segment: string, fullText?: string): void {
    const text = fullText ?? this.segments.get(segment)
    this.segments.delete(segment)
    if (text === undefined) return
    this.thinking.flush()
    this.text.settle(this.textProjection(segment, text.trim() ? 'accepted' : 'rejected', text))
  }

  public appendThinking(segment: string, delta: string): void {
    if (delta) this.thinking.append(segment, this.runId, delta)
  }

  /** 把欠着的思考与正文预览发掉：别的卡片发出前调用，保持先后。 */
  private flushStream(): void {
    this.thinking.flush()
    this.text.flush()
  }

  private textProjection(
    segment: string,
    phase: 'preview' | 'accepted' | 'rejected',
    text: string
  ): Parameters<ConversationTextBoard['settle']>[0] {
    return {
      id: `conversation:${this.runId}:${segment}`,
      runId: this.runId,
      turnId: segment,
      phase,
      text,
    }
  }

  // -------------------------------------------------------------------------------------------
  // 工具卡
  // -------------------------------------------------------------------------------------------

  /** 引擎开始一次工具调用（参数可能还没写完，写完后用 updateTool 补上）。 */
  public startTool(call: {
    id: string
    toolName: string
    title: string
    args?: Record<string, unknown>
  }): void {
    if (this.tools.has(call.id)) {
      this.updateTool(call.id, call)
      return
    }
    this.flushStream()
    this.publishTool(call.id, {
      id: `conversation:tool:${this.runId}:${call.id}`,
      runId: this.runId,
      toolName: call.toolName,
      title: clipText(call.title, ConversationToolCallLimits.titleChars),
      args: boundArgs(call.args ?? {}),
      isRunning: true,
      startedAt: Date.now(),
    })
  }

  /** 补上或改写一次调用的工具名、标题与参数（参数写完了、换成了更好认的说法）。 */
  public updateTool(
    id: string,
    patch: { toolName?: string; title?: string; args?: Record<string, unknown>; result?: unknown }
  ): void {
    const current = this.tools.get(id)
    if (!current) return
    const next: ConversationToolCallProjection = { ...current }
    if (patch.toolName) next.toolName = patch.toolName
    if (patch.title) next.title = clipText(patch.title, ConversationToolCallLimits.titleChars)
    if (patch.args) next.args = boundArgs(patch.args)
    const result = boundPayload(patch.result)
    if (result !== undefined) next.result = result
    this.publishTool(id, next)
  }

  /** 工具跑着时的输出：只留末尾一段，节流后发出。 */
  public toolProgress(id: string, chunk: string): void {
    const current = this.tools.get(id)
    if (!current?.isRunning || !chunk) return
    const progress = `${current.progress ?? ''}${chunk}`.slice(
      -ConversationToolCallLimits.progressChars
    )
    this.tools.set(id, { ...current, progress })
    this.owedProgress.add(id)
    this.progressTimer ??= setTimeout(
      () => this.flushProgress(),
      Math.max(0, this.progressPublishedAt + ToolProgressIntervalMs - Date.now())
    )
  }

  /** 这次调用结束了：带上结果或错误。 */
  public finishTool(id: string, outcome: { result?: unknown; error?: string }): void {
    const current = this.tools.get(id)
    if (!current?.isRunning) return
    this.owedProgress.delete(id)
    this.flushStream()
    const next: ConversationToolCallProjection = {
      ...current,
      isRunning: false,
      finishedAt: Date.now(),
    }
    const result = boundPayload(outcome.result)
    if (result !== undefined) next.result = result
    if (outcome.error) next.error = clipText(outcome.error, ConversationToolCallLimits.payloadChars)
    this.publishTool(id, next)
  }

  /** 这次调用还在跑。 */
  public isToolRunning(id: string): boolean {
    return !!this.tools.get(id)?.isRunning
  }

  private flushProgress(): void {
    clearTimeout(this.progressTimer)
    this.progressTimer = undefined
    if (this.owedProgress.size === 0) return
    this.flushStream()
    for (const id of this.owedProgress) {
      const current = this.tools.get(id)
      if (current) this.sink.notice(ConversationToolCallNotice, current)
    }
    this.owedProgress.clear()
    this.progressPublishedAt = Date.now()
  }

  private publishTool(id: string, projection: ConversationToolCallProjection): void {
    this.tools.set(id, projection)
    this.sink.notice(ConversationToolCallNotice, projection)
  }

  // -------------------------------------------------------------------------------------------
  // 改项目的时间窗
  // -------------------------------------------------------------------------------------------

  /** 引擎开始改项目（写文件、跑命令）：从现在到 endProjectActivity 之间的改动算 Agent 的。 */
  public beginProjectActivity(key: string): void {
    if (!this.options.activity || this.windows.has(key)) return
    this.windows.set(key, this.options.activity.beginCommand())
  }

  /** 这段改项目结束：带上写到的文件（相对项目根），界面据此刷新「本轮改动」与 Git 状态。 */
  public endProjectActivity(key: string, editedPaths: readonly string[] = []): void {
    const finish = this.windows.get(key)
    if (!finish) return
    this.windows.delete(key)
    if (editedPaths.length > 0) this.options.filesEdited?.(editedPaths)
    finish()
    this.sink.notice(ConversationProjectActivityNotice, { runId: this.runId })
  }

  // -------------------------------------------------------------------------------------------
  // 确认与提问
  // -------------------------------------------------------------------------------------------

  /** 请用户点头；运行停下时抛出取消。 */
  public async confirm(
    request: EngineConfirmation,
    signal: AbortSignal
  ): Promise<{ approved: boolean; reason?: string }> {
    const card: Omit<ConversationInteractionProjection, 'id' | 'runId' | 'status'> = {
      kind: request.danger ? 'danger' : 'confirm',
      message: [request.title, request.detail].filter(isNonBlankString).join('\n'),
    }
    if (request.danger)
      card.operation = request.danger.cwd
        ? { label: request.danger.command, target: request.danger.cwd }
        : { label: request.danger.command }
    const answer = await this.open(card, signal)
    const approved = answer.approved === true && !answer.declined
    return isNonBlankString(answer.reason) ? { approved, reason: answer.reason } : { approved }
  }

  /** 问用户一道题；运行停下时抛出取消。 */
  public async ask(question: EngineQuestion, signal: AbortSignal): Promise<EngineQuestionAnswer> {
    const options = (question.options ?? []).map((option, index) => ({
      id: `o${index}`,
      label: option.label,
      description: option.description,
    }))
    const card: Omit<ConversationInteractionProjection, 'id' | 'runId' | 'status'> = {
      kind: options.length > 0 ? 'choice' : 'input',
      message: question.question,
    }
    if (options.length > 0) {
      card.options = options
      if (question.multiple) card.multiple = true
      if (question.allowText) card.allowText = true
    }
    const answer = await this.open(card, signal)
    if (answer.declined) return { declined: true, choices: [] }
    const picked = new Set(isStringArray(answer.choices) ? answer.choices : [])
    const text = isNonBlankString(answer.text) ? answer.text.trim() : undefined
    return {
      declined: false,
      choices: options.filter((option) => picked.has(option.id)).map((option) => option.label),
      text,
    }
  }

  /** 卡片上的回答。 */
  public answer(requestId: string, answer: InteractionAnswer): void {
    const pending = this.pending.get(requestId)
    if (!pending) throw new AppError('VALIDATION', workbenchMainText('conversation.requestExpired'))
    this.settleInteraction(requestId, answer)
    pending.resolve(answer)
  }

  /** 输入框里回答一句话的提问：给最近一张还在等的一句话提问卡。 */
  public answerInput(text: string): void {
    const pending = [...this.pending.values()].reverse().find((item) => item.card.kind === 'input')
    if (!pending) throw new AppError('VALIDATION', workbenchMainText('conversation.noPendingQuestion'))
    this.answer(pending.card.id, { text })
  }

  private open(
    card: Omit<ConversationInteractionProjection, 'id' | 'runId' | 'status'>,
    signal: AbortSignal
  ): Promise<InteractionAnswer> {
    signal.throwIfAborted()
    this.flushStream()
    this.interactionSequence += 1
    const projection: ConversationInteractionProjection = {
      ...card,
      message: card.message.slice(0, ConversationInteractionLimits.messageChars),
      id: `conversation:engine-interaction:${this.runId}:${this.interactionSequence}`,
      runId: this.runId,
      status: 'pending',
    }
    return new Promise<InteractionAnswer>((resolve, reject) => {
      const abort = (): void => {
        if (!this.pending.has(projection.id)) return
        this.expireInteraction(projection.id)
        reject(signal.reason ?? new AppError('CANCELLED', workbenchMainText('conversation.runStopped')))
      }
      this.pending.set(projection.id, {
        card: projection,
        resolve: (answer) => {
          signal.removeEventListener('abort', abort)
          resolve(answer)
        },
        reject: (error) => {
          signal.removeEventListener('abort', abort)
          reject(error)
        },
      })
      signal.addEventListener('abort', abort, { once: true })
      this.sink.notice(ConversationInteractionNotice, projection)
      this.publishAwaiting()
    })
  }

  /** 引擎自己撤回了请求（它那边取消了），或运行停下：卡按失效收掉。 */
  public cancelInteractions(reason: unknown = new AppError('CANCELLED', workbenchMainText('engines.requestWithdrawn'))): void {
    for (const [id, pending] of [...this.pending]) {
      this.expireInteraction(id)
      pending.reject(reason)
    }
  }

  private expireInteraction(id: string): void {
    const pending = this.pending.get(id)
    if (!pending) return
    this.pending.delete(id)
    this.sink.notice(ConversationInteractionNotice, { ...pending.card, status: 'expired' })
    this.publishAwaiting()
  }

  private settleInteraction(id: string, answer: InteractionAnswer): void {
    const pending = this.pending.get(id)
    if (!pending) return
    this.pending.delete(id)
    const declined = answer.declined === true || answer.approved === false
    this.sink.notice(ConversationInteractionNotice, {
      ...pending.card,
      status: declined ? 'declined' : 'answered',
      answer: boundAnswer(answer),
    })
    this.publishAwaiting()
  }

  /** 界面的等待状态跟着还在等的卡走：还有卡在等就指向最近的那张，都答完了回到执行中。 */
  private publishAwaiting(): void {
    const latest = [...this.pending.values()].at(-1)?.card
    if (!latest) {
      this.currentPhase = 'executing'
      this.sink.state({ kind: 'phase', teamPhase: 'executing' })
      return
    }
    this.currentPhase = undefined
    this.sink.state(
      latest.kind === 'input'
        ? { kind: 'awaiting-input', executionId: this.runId, question: latest.message }
        : {
            kind: 'awaiting-confirmation',
            executionId: this.runId,
            confirmationId: latest.id,
            confirmationMessage: latest.message,
          }
    )
  }

  // -------------------------------------------------------------------------------------------
  // 收尾
  // -------------------------------------------------------------------------------------------

  /**
   * 这一轮结束：没写完的正文按接纳收下（引擎的正文不会被撤回），没跑完的工具卡按停止收，还在等的卡按失效收，
   * 开着的改项目时间窗全部关掉。
   */
  public settle(options: { aborted: boolean }): void {
    this.cancelInteractions(new AppError('CANCELLED', workbenchMainText('engines.runEnded')))
    for (const segment of [...this.segments.keys()]) this.finishText(segment)
    clearTimeout(this.progressTimer)
    this.progressTimer = undefined
    this.owedProgress.clear()
    for (const [id, tool] of this.tools)
      if (tool.isRunning)
        this.finishTool(id, {
          error: options.aborted
            ? workbenchMainText('conversation.runStopped')
            : workbenchMainText('engines.toolResultMissing'),
        })
    for (const key of [...this.windows.keys()]) this.endProjectActivity(key)
    this.flushStream()
  }
}

/** 参数原样保留，序列化后超长的换成截断的文本。 */
function boundArgs(args: Record<string, unknown>): Record<string, unknown> {
  const text = safeJson(args)
  if (text.length <= ConversationToolCallLimits.payloadChars) return args
  return { input: clipText(text, ConversationToolCallLimits.payloadChars) }
}

function boundPayload(value: unknown): unknown {
  if (value === undefined || value === null) return undefined
  const text = isString(value) ? value : safeJson(value)
  if (text.length <= ConversationToolCallLimits.payloadChars) return value
  return clipText(text, ConversationToolCallLimits.payloadChars)
}

function boundAnswer(answer: InteractionAnswer): InteractionAnswer {
  const bounded: InteractionAnswer = { ...answer }
  if (isString(answer.text))
    bounded.text = answer.text.slice(0, ConversationInteractionLimits.answerChars)
  if (isString(answer.reason))
    bounded.reason = answer.reason.slice(0, ConversationInteractionLimits.answerChars)
  if (!isPlainObject(answer.values)) delete bounded.values
  return bounded
}

function clipText(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : `${text.slice(0, maxChars - 1)}…`
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? ''
  } catch {
    return String(value)
  }
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isString)
}
