import { optionalWhen, toOptional } from '@velaros-ai/core'
import { type ConversationView } from '@velaros-ai/ui/conversation'
import { isConversationTurnInputMessage, isRunGuidanceMessage } from '@velaros-ai/ui/conversation/contracts'
import { type ChatMessage } from '@velaros-ai/ui/conversation/contracts'

import type { WorkbenchConversationState } from '@shared/workbenchConversation'
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
  | 'awaitingConfirmationExecutionId'
  | 'lastRunFinishedAt'
> & {
  /** 正在等回答的交互请求；卡片上的回答按它认。 */
  readonly awaitingConfirmationId: Nullable<string>
  /** 重试或限流等待时主进程给的说明（例如每小时用量上限），状态行显示它。 */
  readonly connectionRetryMessage: Nullable<string>
}

const LegacyNoTextResponse = 'Run completed without a text response.'
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

/** 重开会话时上次的执行已经结束；保留错误，未收尾的执行明确恢复成中断。 */
function restoreStandaloneRunStatus(
  stored: {
    status?: unknown
    lastError?: unknown
    lastRunStartedAt?: unknown
    lastRunFinishedAt?: unknown
  },
  interruptedMessage: string
): Pick<StandaloneConversationRuntime, 'status' | 'lastError'> {
  const { status, lastError } = stored
  if (status === 'aborted' || status === 'failed')
    return { status, lastError: readNonBlankString(lastError) }
  // 旧历史只保存终止状态，运行中的身份从已开始、未结束的时间记录恢复。
  const startedAt = readFiniteNumber(stored.lastRunStartedAt)
  const finishedAt = readFiniteNumber(stored.lastRunFinishedAt)
  const unfinishedLegacyRun =
    status === undefined && startedAt !== null && (finishedAt === null || startedAt > finishedAt)
  if (
    status === 'running' ||
    status === 'stopping' ||
    status === 'awaiting-input' ||
    status === 'awaiting-confirmation' ||
    unfinishedLegacyRun
  )
    return { status: 'aborted', lastError: interruptedMessage }
  return { status: 'idle', lastError: null }
}

/** 会话运行状态随主进程推来的运行状态变化（与 Desktop 的运行状态规约同一套规则）。 */
function applyStandaloneConversationState<TState extends StandaloneConversationRuntime>(
  state: TState,
  runtime: WorkbenchConversationState,
  now = Date.now()
): TState {
  switch (runtime.kind) {
    case 'phase': {
      const teamPhase = readTeamExecutionPhase(runtime.teamPhase)
      if (!teamPhase) return state
      return patchRuntime(state, {
        ...clearAwaitingRuntime(),
        status: 'running',
        teamPhase,
        connectionRetryAttempt: null,
        connectionRetryMaxAttempts: null,
        connectionRetryMessage: null,
      })
    }
    case 'turn-start':
      return patchRuntime(state, {
        ...clearAwaitingRuntime(),
        status: 'running',
        teamPhase: 'executing',
        activeTurn: readPositiveInteger(runtime.turn) ?? state.activeTurn,
        connectionRetryAttempt: null,
        connectionRetryMaxAttempts: null,
        connectionRetryMessage: null,
      })
    case 'turn-end':
      return patchRuntime(state, {
        teamPhase: state.teamPhase === 'executing' ? 'researching' : state.teamPhase,
        activeTurn: null,
        completedTurns: readPositiveInteger(runtime.turn) ?? state.completedTurns,
        connectionRetryAttempt: null,
        connectionRetryMaxAttempts: null,
        connectionRetryMessage: null,
      })
    case 'reconnecting':
      return patchRuntime(state, {
        ...clearAwaitingRuntime(),
        status: 'running',
        connectionRetryAttempt: readPositiveInteger(runtime.attempt) ?? 1,
        connectionRetryMaxAttempts: null,
        connectionRetryMessage: runtime.message?.trim() || null,
      })
    case 'awaiting-input':
      return patchRuntime(state, {
        ...clearPendingRuntime(),
        status: 'awaiting-input',
        teamPhase: 'waiting-confirmation',
        activeTurn: null,
        lastError: null,
        awaitingInputQuestion: runtime.question.trim() || null,
        awaitingConfirmationExecutionId: runtime.executionId,
      })
    case 'awaiting-confirmation':
      return patchRuntime(state, {
        ...clearPendingRuntime(),
        status: 'awaiting-confirmation',
        teamPhase: 'waiting-confirmation',
        activeTurn: null,
        lastError: null,
        awaitingConfirmationMessage: runtime.confirmationMessage.trim() || null,
        awaitingConfirmationId: runtime.confirmationId,
        awaitingConfirmationExecutionId: runtime.executionId,
      })
    case 'done':
      return patchRuntime(state, {
        ...clearPendingRuntime(),
        status: 'completed',
        teamPhase: 'completed',
        activeTurn: null,
        lastError: null,
        lastRunFinishedAt: now,
      })
    case 'aborted':
      return patchRuntime(state, {
        ...clearPendingRuntime(),
        status: 'aborted',
        teamPhase: null,
        activeTurn: null,
        lastError: readNonBlankString(runtime.message) ?? state.lastError,
        lastRunFinishedAt: now,
      })
    case 'error':
      return patchRuntime(state, {
        ...clearPendingRuntime(),
        status: 'failed',
        teamPhase: null,
        activeTurn: null,
        lastError: readNonBlankString(runtime.message) ?? state.lastError,
        lastRunFinishedAt: now,
      })
    default:
      return state
  }
}

function clearAwaitingRuntime(): Pick<
  StandaloneConversationRuntime,
  | 'awaitingInputQuestion'
  | 'awaitingConfirmationMessage'
  | 'awaitingConfirmationId'
  | 'awaitingConfirmationExecutionId'
> {
  return {
    awaitingInputQuestion: null,
    awaitingConfirmationMessage: null,
    awaitingConfirmationId: null,
    awaitingConfirmationExecutionId: null,
  }
}

function clearPendingRuntime(): Pick<
  StandaloneConversationRuntime,
  | 'connectionRetryAttempt'
  | 'connectionRetryMaxAttempts'
  | 'connectionRetryMessage'
  | 'awaitingInputQuestion'
  | 'awaitingConfirmationMessage'
  | 'awaitingConfirmationId'
  | 'awaitingConfirmationExecutionId'
> {
  return {
    connectionRetryAttempt: null,
    connectionRetryMaxAttempts: null,
    connectionRetryMessage: null,
    ...clearAwaitingRuntime(),
  }
}

/** 界面这一侧先把运行收敛到「停止中」：晚到的进度事件不能把按钮重新变回运行态。 */
function beginStandaloneAgentStop<TState extends StandaloneConversationRuntime>(
  state: TState
): TState {
  if (
    state.status !== 'running' &&
    state.status !== 'awaiting-input' &&
    state.status !== 'awaiting-confirmation'
  )
    return state

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
  // 停止已受理后仍可能收到排队中的阶段、回合、等待交互事件；这些进度事件不能把 UI 从 stopping 拉回
  // running。只有明确终态才允许结束 stopping。
  if (
    state.status === 'stopping' &&
    nextStatus !== 'completed' &&
    nextStatus !== 'aborted' &&
    nextStatus !== 'failed'
  )
    return { ...next, status: 'stopping', teamPhase: null } as TState

  return next
}

function readStandaloneTerminalKind(
  runtime: WorkbenchConversationState
): Nullable<StandaloneAgentTerminalKind> {
  return runtime.kind === 'done' || runtime.kind === 'aborted' || runtime.kind === 'error'
    ? runtime.kind
    : null
}

function sanitizeStandaloneChatMessages(messages: readonly ChatMessage[]): ChatMessage[] {
  return messages.flatMap((message) => {
    if (message.role !== 'assistant') return [message]
    const blocks = message.blocks.filter(
      (block) => block.type !== 'text' || isModelVisibleAssistantText(block.text, block.tone)
    )
    if (blocks.length === 0) return []
    return blocks.length === message.blocks.length ? [message] : [{ ...message, blocks }]
  })
}

/**
 * 一轮收尾时仍没被读走的运行中引导：运行时不会再送它，标成「已暂停」，而不是一直挂着「已接收，等待纳入
 * 上下文」。正常完成时 Platform 在收尾边界会把已受理的引导读走，能留到这里的只有中止 / 失败的那一轮。
 *
 * `includePending`：恢复持久化会话时连「引导中」（投递回执还没回来）也一并暂停——重启后那一轮早就不在了。
 */
function pauseUnappliedRunGuidance(
  messages: readonly ChatMessage[],
  {
    includePending = false,
    inputIds,
  }: { includePending?: boolean; inputIds?: readonly string[] } = {}
): ChatMessage[] {
  const only = inputIds ? new Set(inputIds) : null
  return messages.map((message) =>
    (message.guidanceStatus === 'accepted' ||
      (includePending && message.guidanceStatus === 'pending')) &&
    (!only || only.has(message.id))
      ? { ...message, guidanceStatus: 'paused' }
      : message
  )
}

/** 引导被运行时读进了上下文：那条引导记为「已纳入」。 */
function markStandaloneGuidanceApplied(
  messages: readonly ChatMessage[],
  inputId: string
): readonly ChatMessage[] {
  const index = messages.findIndex((message) => message.id === inputId && isRunGuidanceMessage(message))
  if (index < 0 || messages[index]!.guidanceStatus === 'applied') return messages
  return messages.map((message, position) =>
    position === index ? { ...message, guidanceStatus: 'applied' } : message
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
 * 共享会话视图靠它把已完成回答的过程收进「已处理」、显示耗时，并在中止 / 失败的回答末尾挂状态角标。
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
    goalMode?: boolean
    goalStatus?: StandaloneRunMarker['goalStatus']
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
    goalMode: optionalWhen(input.goalMode === true, true),
    goalStatus: input.goalStatus,
    // 改动摘要是收尾之后才采集到的，重记标记不能把它（和它指向的记录文件）弄丢。
    runChanges: existing?.runChanges,
    timestamp,
  }
  if (
    existing &&
    existing.status === marker.status &&
    existing.detail === marker.detail &&
    existing.turnCount === marker.turnCount &&
    existing.timestamp === marker.timestamp
  )
    return input.markers

  return existing
    ? input.markers.map((entry) => (entry === existing ? marker : entry))
    : [...input.markers, marker]
}

const GoalStatuses = new Set(['active', 'paused', 'complete', 'blocked', 'cancelled', 'removed'])

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
      typeof messageId !== 'string' ||
      !messageIds.has(messageId) ||
      !isStandaloneTerminalRunStatus(status) ||
      typeof timestamp !== 'number'
    )
      return []
    const startedAt = readFiniteNumber(record.startedAt)
    const durationMs = readFiniteNumber(record.durationMs)
    const turnCount = readPositiveInteger(record.turnCount)
    const runChanges = readStoredRunChanges(record.runChanges)
    const goalStatus =
      typeof record.goalStatus === 'string' && GoalStatuses.has(record.goalStatus)
        ? (record.goalStatus as StandaloneRunMarker['goalStatus'])
        : undefined
    return [
      {
        messageId,
        status,
        detail: readNonBlankString(record.detail),
        turnCount,
        turnKind: turnCount !== null ? 'totalTurns' : null,
        ...(startedAt !== null && durationMs !== null ? { startedAt, durationMs } : {}),
        goalMode: optionalWhen(record.goalMode === true, true),
        goalStatus,
        runChanges: toOptional(runChanges),
        timestamp,
      },
    ]
  })
}

function readStoredRunChanges(value: unknown): WorkbenchChatRunChangesSummary | null {
  const record = asRecord(value)
  const { recordId, capturedAt, fileCount, additions, deletions, error } = record
  if (
    typeof recordId !== 'string' ||
    typeof capturedAt !== 'number' ||
    !isCount(fileCount) ||
    !isCount(additions) ||
    !isCount(deletions)
  )
    return null
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
  // 停下、失败的一轮同样记：文件可能已经改了，「AI 改动」要列全每一轮。
  return markers.some(
    (marker) => marker.messageId === messageId && isStandaloneTerminalRunStatus(marker.status)
  )
    ? messageId
    : null
}

/**
 * 把采集到的改动摘要记到那条消息的运行标记上。标记已不在时返回 null——调用方要删掉刚写下的记录；替换掉的
 * 旧记录 id 同样交给调用方删。
 */
function attachStandaloneRunChanges(
  markers: readonly StandaloneRunMarker[],
  messageId: string,
  runChanges: WorkbenchChatRunChangesSummary
): { markers: StandaloneRunMarker[]; replacedRecordId: string | null } | null {
  const marker = markers.find((entry) => entry.messageId === messageId)
  if (!marker || !isStandaloneTerminalRunStatus(marker.status)) return null
  const previous = marker.runChanges?.recordId
  return {
    markers: markers.map((entry) => (entry === marker ? { ...entry, runChanges } : entry)),
    replacedRecordId: previous && previous !== runChanges.recordId ? previous : null,
  }
}

function readStandaloneModelVisibleText(message: ChatMessage): string {
  return message.blocks
    .filter(
      (block) =>
        block.type === 'text' &&
        (message.role !== 'assistant' || isModelVisibleAssistantText(block.text, block.tone))
    )
    .map((block) => (block.type === 'text' ? block.text : ''))
    .filter((text) => text.trim())
    .join('\n')
}

function shouldBlockStandaloneRunSubmission(
  status: StandaloneConversationRuntime['status'],
  hasPendingExecution: boolean,
  accountSignInPending: boolean
): boolean {
  return (
    status === 'running' ||
    status === 'stopping' ||
    status === 'awaiting-input' ||
    status === 'awaiting-confirmation' ||
    hasPendingExecution ||
    accountSignInPending
  )
}

function isModelVisibleAssistantText(text: string, tone: 'default' | 'error' | undefined): boolean {
  const normalized = text.trim()
  return tone !== 'error' && !!normalized && normalized !== LegacyNoTextResponse
}

function readTeamExecutionPhase(value: unknown): StandaloneConversationRuntime['teamPhase'] {
  return typeof value === 'string' &&
    TeamExecutionPhases.has(value as NonNullable<StandaloneConversationRuntime['teamPhase']>)
    ? (value as NonNullable<StandaloneConversationRuntime['teamPhase']>)
    : null
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
 * 主进程回报的上下文用量，以及当前容量是否仍为试探预算。
 */
interface StandaloneContextUsageEstimate {
  readonly percent: number
  readonly estimatedTokens: number
  readonly usableContextWindow: number
  readonly contextWindowEstimated?: boolean
}

/** 从 `context-usage-estimate` 运行状态里收一份用量；形状不全一律当没有。 */
function readStandaloneContextUsageEstimate(
  value: unknown
): Nullable<StandaloneContextUsageEstimate> {
  const payload = asRecord(value)
  if (payload.kind !== 'context-usage-estimate') return null
  const percent = payload.percent
  const estimatedTokens = payload.estimatedTokens
  const usableContextWindow = payload.usableContextWindow
  if (
    typeof percent !== 'number' ||
    !Number.isFinite(percent) ||
    typeof estimatedTokens !== 'number' ||
    !Number.isFinite(estimatedTokens) ||
    typeof usableContextWindow !== 'number' ||
    usableContextWindow <= 0
  )
    return null
  return {
    percent, estimatedTokens, usableContextWindow,
    contextWindowEstimated: payload.contextWindowEstimated === true,
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

export {
  applyStandaloneConversationState,
  asRecord,
  attachStandaloneRunChanges,
  beginStandaloneAgentStop,
  LegacyNoTextResponse,
  markStandaloneGuidanceApplied,
  markStandaloneRun,
  pauseUnappliedRunGuidance,
  readStandaloneContextUsageEstimate,
  readStandaloneModelVisibleText,
  readStandaloneTerminalKind,
  resolveStandaloneRunChangesAnchor,
  restoreStandaloneRunMarkers,
  restoreStandaloneRunStatus,
  sanitizeStandaloneChatMessages,
  shouldBlockStandaloneRunSubmission,
}
export type {
  StandaloneAgentTerminalKind,
  StandaloneContextUsageEstimate,
  StandaloneConversationRuntime,
  StandaloneRunMarker,
}
