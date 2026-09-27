import { isArray, isNonBlankString, isPlainObject, isString } from '@velaros-ai/core'
import type {
  InteractionAnswer,
  InteractionField as InteractionFieldView,
  InteractionKind,
  InteractionOption as InteractionOptionView,
} from '@velaros-ai/ui/conversation/contracts'
import {
  type InteractionField,
  type InteractionOption,
  interactionQuestions,
} from '@velaros-ai/velaros/act/agents'

import {
  ConversationInteractionLimits,
  type ConversationInteractionProjection,
  type WorkbenchConversationState,
} from '../../shared/workbenchConversation'

import type { ConversationSessionEvent } from './WorkbenchConversationTypes'

type Interaction = Extract<ConversationSessionEvent, { type: 'interaction' }>['request']

/** 登录墙确认的补充（与 Desktop 相同）：界面据此画成登录卡，用户在页面里登录好了点「继续」。 */
export const LoginConfirmation = Object.freeze({ purpose: 'login' as const })

/**
 * 卡的种类（与 Desktop 相同）：能力申请（只剩旧记录里还没答的）、提问（按有没有选项或表单分三种）、确认。
 * 确认里带操作身份的是危险命令，带 {@link LoginConfirmation} 的是登录墙，其余是普通确认（模型的 confirm、
 * 每次都问的写入）。
 */
export function interactionKind(request: Interaction): InteractionKind {
  if (request.kind === 'capability') return 'capability'
  if (request.kind === 'input') {
    const question = interactionQuestions.read(request)
    return question?.options ? 'choice' : question?.fields ? 'form' : 'input'
  }
  const detail = request.detail
  if (isPlainObject(detail) && detail.purpose === LoginConfirmation.purpose) return 'login'
  if (isPlainObject(detail) && isPlainObject(detail.operation)) {
    if (isNonBlankString(detail.operation.label)) return 'danger'
  }
  return 'confirm'
}

/** 请求投影成交互卡；说明保留原文与换行，选项、表单与危险命令的操作原样带上。 */
export function interactionView(
  runId: string,
  request: Interaction
): ConversationInteractionProjection {
  const kind = interactionKind(request)
  const view: ConversationInteractionProjection = {
    id: request.id,
    runId,
    kind,
    message: request.message.slice(0, ConversationInteractionLimits.messageChars),
    status: 'pending',
  }
  const question = interactionQuestions.read(request)
  if (question?.options) {
    view.options = question.options.map(toOption)
    if (question.multiple) view.multiple = true
    if (question.allowText) view.allowText = true
  }
  if (question?.fields) view.fields = question.fields.map(toField)
  const detail = request.detail
  if (kind === 'danger' && isPlainObject(detail) && isPlainObject(detail.operation)) {
    const { label, target } = detail.operation
    view.operation = isNonBlankString(target)
      ? { label: String(label), target }
      : { label: String(label) }
  }
  return view
}

/**
 * 卡片的回答转成 Platform 这个请求认的值：确认给 `{ approved, reason }`（宿主自己的确认也按这个读）；
 * 能力申请给一段话；提问给 `{ text, choices, values }` 或跳过的 `{ declined, reason }`，类型与范围由
 * Platform 按原问题再核一遍。
 */
export function platformAnswer(request: Interaction, answer: InteractionAnswer): unknown {
  const reason = clipText(answer.reason)
  if (request.kind === 'confirmation') {
    const value: Record<string, unknown> = {
      approved: answer.approved === true && !answer.declined,
    }
    if (reason) value.reason = reason
    return value
  }
  if (answer.declined) {
    const value: Record<string, unknown> = { declined: true }
    if (reason) value.reason = reason
    return value
  }
  if (request.kind === 'capability') return clipText(answer.text) ?? ''
  const value: Record<string, unknown> = {}
  const text = clipText(answer.text)
  if (text) value.text = text
  if (isArray(answer.choices)) value.choices = answer.choices.filter(isString)
  if (isPlainObject(answer.values)) value.values = answer.values
  return value
}

/** 回答算已回答还是跳过、拒绝：确认看批准与否，提问看是不是跳过。 */
function answeredStatus(answer: InteractionAnswer): 'answered' | 'declined' {
  return answer.declined || answer.approved === false ? 'declined' : 'answered'
}

/**
 * 界面的等待状态：一句话的提问让输入框直接回答；其余请求等卡片上的回答。卡片本身由交互卡通知画，
 * 这里只给状态与身份。
 */
export function awaitingState(runId: string, request: Interaction): WorkbenchConversationState {
  if (interactionKind(request) === 'input')
    return { kind: 'awaiting-input', executionId: runId, question: request.message }
  return {
    kind: 'awaiting-confirmation',
    executionId: runId,
    confirmationId: request.id,
    confirmationMessage: request.message,
  }
}

/**
 * 一次运行里交互卡的账。请求到达建卡（等回答）；回答交给 Platform 成功后原位写上回答；运行收尾时还没答的
 * 卡不会再被回答，按失效收掉。每张卡的每次变化都发出去，渲染层原位替换并落盘。
 */
export class ConversationInteractionBoard {
  private readonly cards = new Map<string, ConversationInteractionProjection>()

  public constructor(
    private readonly emit: (projection: ConversationInteractionProjection) => void
  ) {}

  public open(runId: string, request: Interaction): void {
    const view = interactionView(runId, request)
    this.cards.set(view.id, view)
    this.emit(view)
  }

  public answer(id: string, answer: InteractionAnswer): void {
    const card = this.cards.get(id)
    if (card?.status !== 'pending') return
    this.publish({ ...card, status: answeredStatus(answer), answer })
  }

  /** 运行结束：还在等的卡不会再有回答。 */
  public settle(): void {
    for (const card of this.cards.values())
      if (card.status === 'pending') this.publish({ ...card, status: 'expired' })
  }

  private publish(card: ConversationInteractionProjection): void {
    this.cards.set(card.id, card)
    this.emit(card)
  }
}

function toOption(option: InteractionOption): InteractionOptionView {
  const view: InteractionOptionView = { id: option.id, label: option.label }
  if (option.description) view.description = option.description
  if (option.recommended) view.recommended = true
  return view
}

function toField(field: InteractionField): InteractionFieldView {
  const view: InteractionFieldView = { id: field.id, label: field.label, kind: field.kind }
  if (field.options) view.options = field.options.map(toOption)
  if (field.multiple) view.multiple = true
  if (field.required) view.required = true
  if (field.placeholder) view.placeholder = field.placeholder
  return view
}

function clipText(value: unknown): string | undefined {
  return isNonBlankString(value)
    ? value.slice(0, ConversationInteractionLimits.answerChars)
    : undefined
}
