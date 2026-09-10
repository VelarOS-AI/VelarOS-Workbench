import { isConversationTurnInputMessage } from '@velaros-ai/agent/protocol'
import type { ConversationView } from '@velaros-ai/ui/conversation'

import type { ChatMessage } from '@shared/contracts'
import type { WorkbenchChatRunChangesSummary } from '@shared/workbenchGit'

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

/**
 * 一轮收尾时仍没被读走的运行中引导：执行栈不会再送它，标成「已暂停」，而不是一直挂着
 * 「已接收，等待纳入上下文」。正常完成时执行栈在收尾边界会把已受理的引导全部读走（takeOrSeal），
 * 能留到这里的只有中止 / 失败的那一轮。
 *
 * `includePending`：恢复持久化会话时连「引导中」（投递回执还没回来）也一并暂停——重启后那一轮早就不在了。
 */
function pauseUnappliedRunGuidance(
  messages: readonly ChatMessage[],
  { includePending = false }: { includePending?: boolean } = {}
): ChatMessage[] {
  return messages.map((message) =>
    message.guidanceStatus === 'accepted'
    || (includePending && message.guidanceStatus === 'pending')
      ? { ...message, guidanceStatus: 'paused' }
      : message
  )
}

/**
 * 共享会话视图的运行标记：一轮收尾时记在这一轮最后一条助手消息上。
 *
 * `runChanges` 是这一轮的「本轮改动」摘要（Desktop 在同一位置记整份 workspaceCheckpointDiff）。
 * 补丁全文在主进程数据区的记录文件里，这里只有定长摘要和记录 id——标记随会话进 localStorage。
 */
type StandaloneRunMarker = ConversationView['messageRunMarkers'][number] & {
  readonly runChanges?: WorkbenchChatRunChangesSummary
}

type StandaloneTerminalRunStatus = Extract<
  StandaloneConversationRuntime['status'],
  'completed' | 'aborted' | 'failed'
>

function isStandaloneTerminalRunStatus(value: unknown): value is StandaloneTerminalRunStatus {
  return value === 'completed' || value === 'aborted' || value === 'failed'
}

/**
 * 一轮收尾时给这一轮的最后一条助手消息记运行标记（与 Desktop `setLastAssistantMessageRunMarker` 同一规则）。
 *
 * 共享会话视图靠它把已完成回答的过程收进「已处理」、显示耗时，并在中止 / 失败的回答末尾挂状态角标——
 * 回答已有正文时，中止与失败的运行提示不会再在正文里出现，没有标记就看不出这一轮停在了哪里。
 * 这一轮一条助手消息都没产出（开口前就失败）时不记：最近那条助手回复属于上一轮。
 * 已中止的标记不会被随后迟到的完成回执改写成已完成。
 */
function markStandaloneRun(
  input: {
    messages: readonly ChatMessage[]
    markers: readonly StandaloneRunMarker[]
    status: StandaloneConversationRuntime['status']
    lastError: StandaloneConversationRuntime['lastError']
    completedTurns: number
    lastRunStartedAt: Nullable<number>
    lastRunFinishedAt: Nullable<number>
  },
  now = Date.now()
): readonly StandaloneRunMarker[] {
  const status = input.status
  if (!isStandaloneTerminalRunStatus(status)) return input.markers
  const anchorIndex = input.messages.findLastIndex((message) => message.role === 'assistant')
  if (anchorIndex < 0 || anchorIndex < input.messages.findLastIndex(isConversationTurnInputMessage))
    return input.markers

  const messageId = input.messages[anchorIndex]!.id
  const existing = input.markers.find((marker) => marker.messageId === messageId)
  if (existing?.status === 'aborted' && status === 'completed') return input.markers

  const timestamp = input.lastRunFinishedAt ?? now
  const startedAt =
    input.lastRunStartedAt !== null && input.lastRunStartedAt <= timestamp
      ? input.lastRunStartedAt
      : null
  const marker: StandaloneRunMarker = {
    messageId,
    status,
    detail: status === 'completed' ? null : input.lastError,
    turnCount: input.completedTurns > 0 ? input.completedTurns : null,
    turnKind: input.completedTurns > 0 ? 'totalTurns' : null,
    ...(startedAt !== null ? { startedAt, durationMs: timestamp - startedAt } : {}),
    // 改动摘要是收尾之后才采集到的，重记标记不能把它（和它指向的记录文件）弄丢。
    ...(existing?.runChanges ? { runChanges: existing.runChanges } : {}),
    timestamp,
  }
  if (
    existing
    && existing.status === marker.status
    && existing.detail === marker.detail
    && existing.turnCount === marker.turnCount
    && existing.timestamp === marker.timestamp
  ) return input.markers

  return existing
    ? input.markers.map((entry) => (entry === existing ? marker : entry))
    : [...input.markers, marker]
}

/** 恢复持久化的运行标记：只收终态标记、只留仍在会话里的消息；形状不对的当没有。 */
function restoreStandaloneRunMarkers(
  value: unknown,
  messages: readonly ChatMessage[]
): StandaloneRunMarker[] {
  if (!Array.isArray(value)) return []
  const messageIds = new Set(messages.map((message) => message.id))
  return value.flatMap((candidate): StandaloneRunMarker[] => {
    const record = asRecord(candidate)
    const { messageId, status, timestamp } = record
    if (
      typeof messageId !== 'string'
      || !messageIds.has(messageId)
      || !isStandaloneTerminalRunStatus(status)
      || typeof timestamp !== 'number'
    ) return []
    const startedAt = readFiniteNumber(record.startedAt)
    const durationMs = readFiniteNumber(record.durationMs)
    const turnCount = readPositiveInteger(record.turnCount)
    const runChanges = readStoredRunChanges(record.runChanges)
    return [{
      messageId,
      status,
      detail: readNonBlankString(record.detail),
      turnCount,
      turnKind: turnCount !== null ? 'totalTurns' : null,
      ...(startedAt !== null && durationMs !== null ? { startedAt, durationMs } : {}),
      ...(runChanges ? { runChanges } : {}),
      timestamp,
    }]
  })
}

function readStoredRunChanges(value: unknown): WorkbenchChatRunChangesSummary | null {
  const record = asRecord(value)
  const { recordId, capturedAt, fileCount, additions, deletions, error } = record
  if (
    typeof recordId !== 'string'
    || typeof capturedAt !== 'number'
    || !isCount(fileCount)
    || !isCount(additions)
    || !isCount(deletions)
  ) return null
  return {
    recordId,
    capturedAt,
    fileCount,
    additions,
    deletions,
    error: readNonBlankString(error),
  }
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
}

/**
 * 这一轮的「本轮改动」记在哪条消息上：刚收尾的这一轮、已完成的运行标记所在的那条助手消息。
 * 它必须排在这一轮开跑前的检查点之后——这一轮一条助手消息都没产出时，最近的助手回复属于上一轮。
 */
function resolveStandaloneRunChangesAnchor(
  messages: readonly ChatMessage[],
  markers: readonly StandaloneRunMarker[],
  captureMessageCount: number
): string | null {
  const anchorIndex = messages.findLastIndex((message) => message.role === 'assistant')
  if (anchorIndex < 0 || anchorIndex < captureMessageCount) return null
  const messageId = messages[anchorIndex]!.id
  return markers.some((marker) => marker.messageId === messageId && marker.status === 'completed')
    ? messageId
    : null
}

/**
 * 把采集到的改动摘要记到那条消息的运行标记上。标记已不在或不再是已完成（采集期间被回溯掉、
 * 被后来的中止改写）时返回 null——调用方要删掉刚写下的记录；替换掉的旧记录 id 同样交给调用方删。
 */
function attachStandaloneRunChanges(
  markers: readonly StandaloneRunMarker[],
  messageId: string,
  runChanges: WorkbenchChatRunChangesSummary
): { markers: StandaloneRunMarker[]; replacedRecordId: string | null } | null {
  const marker = markers.find((entry) => entry.messageId === messageId)
  if (marker?.status !== 'completed') return null
  const previous = marker.runChanges?.recordId
  return {
    markers: markers.map((entry) => (entry === marker ? { ...entry, runChanges } : entry)),
    replacedRecordId: previous && previous !== runChanges.recordId ? previous : null,
  }
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

function readFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
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
  attachStandaloneRunChanges,
  beginStandaloneAgentStop,
  hasStandaloneVisibleAssistantReply,
  isStandaloneAgentRuntimeEvent,
  LegacyNoTextResponse,
  markStandaloneRun,
  pauseUnappliedRunGuidance,
  readStandaloneAgentRuntimeKind,
  readStandaloneAgentTerminalKind,
  readStandaloneContextUsageEstimate,
  readStandaloneFinalAgentError,
  readStandaloneFinalAgentStatus,
  readStandaloneFinalAgentText,
  readStandaloneModelVisibleText,
  resolveStandaloneRunChangesAnchor,
  restoreStandaloneRunMarkers,
  sanitizeStandaloneChatMessages,
  shouldBlockStandaloneRunSubmission,
}
export type {
  StandaloneAgentTerminalKind,
  StandaloneContextUsageEstimate,
  StandaloneConversationRuntime,
  StandaloneRunMarker,
}
