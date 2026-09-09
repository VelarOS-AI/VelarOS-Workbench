import type { ConversationView } from '@velaros-ai/ui/conversation'

import type { ChatMessage } from '@shared/contracts'

type StandaloneConversationRuntime = Pick<
  ConversationView['runtime'],
  | 'status'
  | 'teamPhase'
  | 'activeTurn'
  | 'completedTurns'
  | 'lastError'
  | 'connectionRetryAttempt'
  | 'connectionRetryMaxAttempts'
  | 'awaitingInputQuestion'
  | 'awaitingConfirmationMessage'
  | 'awaitingConfirmationDetail'
  | 'lastRunFinishedAt'
>

const LegacyNoTextResponse = 'Run completed without a text response.'
const StandaloneAgentRuntimeKinds = new Set([
  'phase',
  'turn-start',
  'turn-end',
  'reconnecting',
  'retrying-turn',
  'awaiting-input',
  'awaiting-confirmation',
  'done',
  'aborted',
  'error',
])
const TeamExecutionPhases = new Set<NonNullable<StandaloneConversationRuntime['teamPhase']>>([
  'creating-task',
  'collecting-context',
  'preparing-tools',
  'building-prompt',
  'requesting-model',
  'preparing',
  'understanding',
  'planning',
  'researching',
  'executing',
  'executing-tool',
  'waiting-user-browser',
  'capturing-browser-screenshot',
  'verifying',
  'synthesizing',
  'waiting-confirmation',
  'completed',
])

type StandaloneAgentTerminalKind = 'done' | 'aborted' | 'error'

function applyStandaloneAgentRuntimeEvent<TState extends StandaloneConversationRuntime>(
  state: TState,
  value: unknown,
  now = Date.now()
): TState {
  const runtime = asRecord(value)
  const kind = readStandaloneAgentRuntimeKind(runtime)
  if (!kind) return state

  if (kind === 'phase') {
    const teamPhase = readTeamExecutionPhase(runtime.teamPhase)
    if (!teamPhase) return state
    return patchRuntime(state, {
      status: 'running',
      teamPhase,
      connectionRetryAttempt: null,
      connectionRetryMaxAttempts: null,
    })
  }
  if (kind === 'turn-start') return patchRuntime(state, {
    status: 'running',
    teamPhase: 'executing',
    activeTurn: readPositiveInteger(runtime.turn) ?? state.activeTurn,
    connectionRetryAttempt: null,
    connectionRetryMaxAttempts: null,
  })
  if (kind === 'turn-end') return patchRuntime(state, {
    teamPhase: state.teamPhase === 'executing' ? 'researching' : state.teamPhase,
    activeTurn: null,
    completedTurns: readPositiveInteger(runtime.turn) ?? state.completedTurns,
    connectionRetryAttempt: null,
    connectionRetryMaxAttempts: null,
  })
  if (kind === 'reconnecting' || kind === 'retrying-turn') return patchRuntime(state, {
    status: 'running',
    connectionRetryAttempt: readPositiveInteger(runtime.attempt) ?? 1,
    connectionRetryMaxAttempts: readPositiveInteger(runtime.maxAttempts),
  })
  if (kind === 'awaiting-input') {
    const question = readNonBlankString(runtime.question)
    if (!question) return state
    return patchRuntime(state, {
      ...clearPendingRuntime(),
      status: 'awaiting-input',
      teamPhase: 'waiting-confirmation',
      activeTurn: null,
      lastError: null,
      awaitingInputQuestion: question,
    })
  }
  if (kind === 'awaiting-confirmation') {
    const message = readNonBlankString(runtime.confirmationMessage)
    if (!message) return state
    return patchRuntime(state, {
      ...clearPendingRuntime(),
      status: 'awaiting-confirmation',
      teamPhase: 'waiting-confirmation',
      activeTurn: null,
      lastError: null,
      awaitingConfirmationMessage: message,
      awaitingConfirmationDetail: readStandaloneConfirmationDetail(runtime.confirmationDetail),
    })
  }
  if (kind === 'done') return patchRuntime(state, {
    ...clearPendingRuntime(),
    status: 'completed',
    teamPhase: 'completed',
    activeTurn: null,
    lastError: null,
    lastRunFinishedAt: state.lastRunFinishedAt ?? now,
  })
  if (kind === 'aborted') return patchRuntime(state, {
    ...clearPendingRuntime(),
    status: 'aborted',
    teamPhase: null,
    activeTurn: null,
    lastError: readNonBlankString(runtime.message) ?? state.lastError,
    lastRunFinishedAt: now,
  })
  return patchRuntime(state, {
    ...clearPendingRuntime(),
    status: 'failed',
    teamPhase: null,
    activeTurn: null,
    lastError: readNonBlankString(runtime.message) ?? state.lastError,
    lastRunFinishedAt: now,
  })
}

function clearPendingRuntime(): Pick<
  StandaloneConversationRuntime,
  | 'connectionRetryAttempt'
  | 'connectionRetryMaxAttempts'
  | 'awaitingInputQuestion'
  | 'awaitingConfirmationMessage'
  | 'awaitingConfirmationDetail'
> {
  return {
    connectionRetryAttempt: null,
    connectionRetryMaxAttempts: null,
    awaitingInputQuestion: null,
    awaitingConfirmationMessage: null,
    awaitingConfirmationDetail: null,
  }
}

function beginStandaloneAgentStop<TState extends StandaloneConversationRuntime>(
  state: TState
): TState {
  if (
    state.status !== 'running'
    && state.status !== 'awaiting-input'
    && state.status !== 'awaiting-confirmation'
  ) return state

  return patchRuntime(state, {
    ...clearPendingRuntime(),
    status: 'stopping',
    teamPhase: null,
    activeTurn: null,
    lastError: null,
  })
}

function patchRuntime<TState extends StandaloneConversationRuntime>(
  state: TState,
  patch: Partial<StandaloneConversationRuntime>
): TState {
  const next = { ...state, ...patch }
  const nextStatus = patch.status
  // Abort 已受理后仍可能收到排队中的 phase/turn/等待交互事件；这些进度事件不能把 UI
  // 从 stopping 拉回 running。只有明确终态才允许结束 stopping。
  if (
    state.status === 'stopping'
    && nextStatus !== 'completed'
    && nextStatus !== 'aborted'
    && nextStatus !== 'failed'
  ) return { ...next, status: 'stopping', teamPhase: null } as TState

  return next
}

function readStandaloneAgentRuntimeKind(value: unknown): string | null {
  const runtime = asRecord(value)
  const kind = runtime.kind ?? runtime.type
  return typeof kind === 'string' ? kind : null
}

function isStandaloneAgentRuntimeEvent(value: unknown): boolean {
  const kind = readStandaloneAgentRuntimeKind(value)
  return !!kind && StandaloneAgentRuntimeKinds.has(kind)
}

function readStandaloneAgentTerminalKind(value: unknown): StandaloneAgentTerminalKind | null {
  const kind = readStandaloneAgentRuntimeKind(value)
  return kind === 'done' || kind === 'aborted' || kind === 'error' ? kind : null
}

function readStandaloneFinalAgentStatus(
  output: unknown
): 'completed' | 'aborted' | 'error' | null {
  const status = asRecord(output).status
  return status === 'completed' || status === 'aborted' || status === 'error'
    ? status
    : null
}

function readStandaloneFinalAgentText(output: unknown): string | null {
  if (typeof output === 'string') return readVisibleFinalText(output)
  const record = asRecord(output)
  for (const key of ['text', 'outputText', 'response']) {
    const text = readVisibleFinalText(record[key])
    if (text) return text
  }
  return null
}

function readVisibleFinalText(value: unknown): string | null {
  const text = readNonBlankString(value)
  return text === LegacyNoTextResponse ? null : text
}

function readStandaloneFinalAgentError(output: unknown): string | null {
  const record = asRecord(output)
  const direct = readNonBlankString(record.error) ?? readNonBlankString(record.message)
  if (direct) return direct
  return readNonBlankString(asRecord(record.error).message)
}

function sanitizeStandaloneChatMessages(messages: readonly ChatMessage[]): ChatMessage[] {
  return messages.flatMap((message) => {
    if (message.role !== 'assistant') return [message]
    const blocks = message.blocks.filter((block) =>
      block.type !== 'text' || isModelVisibleAssistantText(block.text, block.tone)
    )
    if (blocks.length === 0) return []
    return blocks.length === message.blocks.length ? [message] : [{ ...message, blocks }]
  })
}

function readStandaloneModelVisibleText(message: ChatMessage): string {
  return message.blocks
    .filter((block) =>
      block.type === 'text'
      && (message.role !== 'assistant' || isModelVisibleAssistantText(block.text, block.tone))
    )
    .map((block) => block.type === 'text' ? block.text : '')
    .filter((text) => text.trim())
    .join('\n')
}

function hasStandaloneVisibleAssistantReply(messages: readonly ChatMessage[]): boolean {
  const lastUserIndex = messages.findLastIndex((message) => message.role === 'user')
  return messages.slice(lastUserIndex + 1).some((message) =>
    message.role === 'assistant' && readStandaloneModelVisibleText(message).trim().length > 0
  )
}

function shouldBlockStandaloneRunSubmission(
  status: StandaloneConversationRuntime['status'],
  hasPendingExecution: boolean,
  accountSignInPending: boolean
): boolean {
  return status === 'running'
    || status === 'awaiting-input'
    || status === 'awaiting-confirmation'
    || hasPendingExecution
    || accountSignInPending
}

function applyStandaloneCompletedRunResult<TState extends StandaloneConversationRuntime>(
  state: TState,
  messages: readonly ChatMessage[],
  noTextError: string,
  now = Date.now()
): TState {
  const completed = applyStandaloneAgentRuntimeEvent(state, { kind: 'done' }, now)
  return hasStandaloneVisibleAssistantReply(messages)
    ? completed
    : patchRuntime(completed, {
        status: 'failed',
        teamPhase: null,
        lastError: noTextError,
      })
}

function isModelVisibleAssistantText(text: string, tone: 'default' | 'error' | undefined): boolean {
  const normalized = text.trim()
  return tone !== 'error' && !!normalized && normalized !== LegacyNoTextResponse
}

function readTeamExecutionPhase(
  value: unknown
): StandaloneConversationRuntime['teamPhase'] {
  return typeof value === 'string'
    && TeamExecutionPhases.has(value as NonNullable<StandaloneConversationRuntime['teamPhase']>)
    ? value as NonNullable<StandaloneConversationRuntime['teamPhase']>
    : null
}

/**
 * 确认信封的结构化明细。
 *
 * 逐 kind 白名单重建（而不是整包透传）：明细来自 main，但会走 Kernel 事件桥的不透明载荷，
 * 形状不合就当没有——渲染层回落到散文 message，而不是把半个对象喂给确认卡。
 * `authorization` 是所有 kind 共用的授权抬头（操作标签/目标/作用域），单独拼。
 */
function readStandaloneConfirmationDetail(
  value: unknown
): StandaloneConversationRuntime['awaitingConfirmationDetail'] {
  const detail = asRecord(value)
  const authorization = readStandaloneConfirmationAuthorization(detail.authorization)
  if (
    detail.kind === 'tool-category-authorization'
    && typeof detail.categoryId === 'string'
    && typeof detail.categoryLabel === 'string'
    && typeof detail.toolName === 'string'
  ) return {
    kind: 'tool-category-authorization',
    categoryId: detail.categoryId,
    categoryLabel: detail.categoryLabel,
    toolName: detail.toolName,
    ...authorization,
  }
  if (
    detail.kind === 'mcp-tool-call'
    && typeof detail.serverName === 'string'
    && typeof detail.toolName === 'string'
  ) return {
    kind: 'mcp-tool-call',
    serverName: detail.serverName,
    toolName: detail.toolName,
    ...authorization,
  }
  // 原生执行栈的通用审批（项目补丁、破坏性命令、技能加载…）都走这一支：
  // createTaskApprovalPort 统一给 `operation-authorization` + authorization 抬头。
  if (detail.kind === 'operation-authorization') return {
    kind: 'operation-authorization',
    ...authorization,
  }
  if (
    detail.kind === 'skill-load'
    && typeof detail.skillId === 'string'
    && typeof detail.label === 'string'
  ) return {
    kind: 'skill-load',
    skillId: detail.skillId,
    label: detail.label,
    ...(typeof detail.description === 'string' ? { description: detail.description } : {}),
    ...authorization,
  }
  return null
}

type StandaloneConfirmationAuthorization = Pick<
  NonNullable<StandaloneConversationRuntime['awaitingConfirmationDetail']>,
  'authorization'
>

function readStandaloneConfirmationAuthorization(
  value: unknown
): StandaloneConfirmationAuthorization {
  const authorization = asRecord(value)
  if (typeof authorization.label !== 'string') return {}
  const scope = authorization.scope === 'call' || authorization.scope === 'task-operation'
    ? authorization.scope
    : 'call'
  return {
    authorization: {
      label: authorization.label,
      scope,
      ...(typeof authorization.target === 'string' ? { target: authorization.target } : {}),
      ...(typeof authorization.requester === 'string'
        ? { requester: authorization.requester }
        : {}),
    },
  }
}

function readPositiveInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null
}

function readNonBlankString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

/**
 * main 每轮送核前算出的上下文用量。
 *
 * 只留仪表要用的三格；完整载荷还带账本、压力面与治理投影，那些是调试视图的事，
 * 全量搬到 renderer 状态里只会让每一轮都拖着一份没人读的对象。
 */
interface StandaloneContextUsageEstimate {
  readonly percent: number
  readonly estimatedTokens: number
  readonly usableContextWindow: number
}

/** 从 `context-usage-estimate` 运行时事件里收一份用量；形状不全一律当没有。 */
function readStandaloneContextUsageEstimate(
  value: unknown
): Nullable<StandaloneContextUsageEstimate> {
  const payload = asRecord(value)
  if (payload.kind !== 'context-usage-estimate') return null
  const percent = payload.percent
  const estimatedTokens = payload.estimatedTokens
  const usableContextWindow = payload.usableContextWindow
  if (
    typeof percent !== 'number' || !Number.isFinite(percent)
    || typeof estimatedTokens !== 'number' || !Number.isFinite(estimatedTokens)
    || typeof usableContextWindow !== 'number' || usableContextWindow <= 0
  ) return null
  return { percent, estimatedTokens, usableContextWindow }
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

export {
  applyStandaloneAgentRuntimeEvent,
  applyStandaloneCompletedRunResult,
  asRecord,
  beginStandaloneAgentStop,
  hasStandaloneVisibleAssistantReply,
  isStandaloneAgentRuntimeEvent,
  LegacyNoTextResponse,
  readStandaloneAgentRuntimeKind,
  readStandaloneAgentTerminalKind,
  readStandaloneContextUsageEstimate,
  readStandaloneFinalAgentError,
  readStandaloneFinalAgentStatus,
  readStandaloneFinalAgentText,
  readStandaloneModelVisibleText,
  sanitizeStandaloneChatMessages,
  shouldBlockStandaloneRunSubmission,
}
export type {
  StandaloneAgentTerminalKind,
  StandaloneContextUsageEstimate,
  StandaloneConversationRuntime,
}
