import {
  type ReactElement,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import { ArrowRightIcon } from '@phosphor-icons/react'
import type {
  WorkbenchChatCompositionAdapter,
  WorkbenchChatLiveRunChanges,
  WorkbenchChatProjectRuntime,
  WorkbenchChatSessionSnapshot,
  WorkbenchChatSessionSurfaceProps,
} from '@renderer/composition'
import { useWorkbenchI18n } from '@renderer/i18n'

import type { ReasoningLevel, RunProfileSelectionId } from '@velaros-ai/agent/protocol'
import { AgentCapabilityProtocolVersion } from '@velaros-ai/agent/protocol/agent-capability'
import { Log } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'
import {
  ChatConversationPane,
  ChatThinkingVisibilityProvider,
  type ConversationRewindPlan,
  type ConversationView,
  useConversationTranslatorRuntime,
  useScrollToBottom,
} from '@velaros-ai/ui/conversation'
import {
  type ChatComposerControl,
  type ChatInputSendDraft,
  ChatSurfaceComposer,
} from '@velaros-ai/ui/conversation/composer'

import type {
  BrowserElementSelection,
  ChatMessage,
  ContentBlock,
  ToolCallBlock,
} from '@shared/contracts'
import type { WorkbenchChatRunChangesSummary } from '@shared/workbenchGit'
import type { WorkbenchAgentEngineModelCatalog } from '@shared/workbenchResourcePlugins'

import workbenchAppIconUrl from '../../../../build/icon.svg?url'
import type { WorkbenchChatProviderId } from '../../../plugins/agent-engines/identity'
import { resolveWorkbenchChatComposerPlaceholder } from '../models/chat/workbenchChatComposerPlaceholder'
import {
  formatWorkbenchChatPathForDisplay,
  resolveWorkbenchChatAbsolutePath,
} from '../models/chat/workbenchChatWorkspacePath'
import { resolveWorkbenchGoalAutoContinue } from '../models/chat/workbenchGoalAutoContinue'
import { readWorkbenchPermissionConfirmationMode } from '../models/settings/workbenchPreferences'
import styles from '../styles/workbenchPageStyles'
import { useLatest, useMemoizedFn } from '../support/genericHooks'

import { WorkbenchContextUsageIndicator } from './conversation/WorkbenchContextUsageIndicator'
import {
  type WorkbenchRunChangesScope,
  WorkbenchRunChangesScopeContext,
} from './conversation/WorkbenchRunChangesCard'
import {
  type WorkbenchWorkerThreadScope,
  WorkbenchWorkerThreadScopeContext,
} from './conversation/WorkbenchWorkerThreadPanel'
import { createCoalescedChatPersistence, isSameIdentityList } from './standaloneChatPersistence'
import {
  readStandaloneChatScrollPosition,
  saveStandaloneChatScrollPosition,
} from './standaloneChatScrollPositions'
import {
  projectStandaloneSessionGroups,
  standaloneProjectFolderId,
} from './standaloneChatSessionList'
import { useStandaloneModelPricing } from './standaloneModelPricing'
import { useStandaloneQueuedDrafts } from './standaloneQueuedDrafts'
import {
  applyStandaloneAgentRuntimeEvent,
  applyStandaloneCompletedRunResult,
  attachStandaloneRunChanges,
  beginStandaloneAgentStop,
  hasStandaloneVisibleAssistantReply,
  isStandaloneAgentRuntimeEvent,
  markStandaloneRun,
  pauseUnappliedRunGuidance,
  readStandaloneAgentTerminalKind,
  readStandaloneContextUsageEstimate,
  readStandaloneFinalAgentError,
  readStandaloneFinalAgentStatus,
  readStandaloneFinalAgentText,
  readStandaloneLiveActivity,
  readStandaloneModelVisibleText,
  resolveStandaloneRunChangesAnchor,
  restoreStandaloneRunMarkers,
  sanitizeStandaloneChatMessages,
  shouldBlockStandaloneRunSubmission,
  type StandaloneAgentTerminalKind,
  type StandaloneContextUsageEstimate,
  type StandaloneConversationRuntime,
  type StandaloneRunMarker,
} from './standaloneWorkbenchChatRuntime'
import {
  getStandaloneWorkbenchManagedProvider,
  isStandaloneWorkbenchManagedProviderId,
  refreshStandaloneWorkbenchManagedModels,
  useStandaloneWorkbenchManagedModels,
} from './standaloneWorkbenchManagedModels'
import { createStandaloneWorkbenchConfiguredModelSelectorProviders } from './standaloneWorkbenchModelCatalog'
import {
  selectStandaloneWorkbenchAgentModel,
  selectStandaloneWorkbenchModelProvider,
  useStandaloneWorkbenchModelConfig,
} from './standaloneWorkbenchModelConfig'
import {
  appendStandaloneCheckpoint,
  buildRewindNoticeText,
  buildRewindPlan,
  createStandaloneSystemNotice,
  isStoredStandaloneCheckpoint,
  NoRewindFileOutcome,
  resolveRewindFidelity,
  resolveRewindFileCapability,
  type RewindFileOutcome,
  selectStandaloneRewind,
  type StandaloneChatCheckpoint,
  surveyRewindRemoval,
} from './standaloneWorkbenchRewind'
import {
  createStandaloneRunChangeCapture,
  type StandaloneRunChangeCapture,
  StandaloneRunChangeCaptureTiming,
} from './standaloneWorkbenchRunChangeCapture'
import { awaitStandaloneAgentStopSettlement } from './standaloneWorkbenchStopSettlement'
import {
  createStandaloneStreamPacer,
  type StandalonePacedStreamEvent,
} from './standaloneWorkbenchStreamPacer'
import {
  applyStandaloneWorkerThreadEvent,
  createEmptyWorkerThreadProjection,
  type StandaloneWorkerThreadProjection,
} from './standaloneWorkbenchWorkerThreads'
import {
  createWorkbenchAgentProjectWriteTracker,
  publishWorkbenchAgentProjectWrite,
  type WorkbenchAgentProjectWriteTracker,
} from './workbenchAgentProjectWrites'
import {
  performWorkbenchAgentUiRequest,
  readWorkbenchAgentUiRequest,
} from './workbenchAgentUiHost'
import {
  buildBrowserElementDisplayFallback,
  formatBrowserElementSelectionsForPrompt,
} from './workbenchBrowserElementContext'
import { resolveWorkbenchClipboardFilePath } from './workbenchClipboardFile'
import { workbenchMessage } from './workbenchMessageHost'

const log = Log.tag('workbench-chat-adapter')

interface StandaloneChatState extends StandaloneConversationRuntime {
  readonly providerId: WorkbenchChatProviderId
  readonly projectRoot: string
  readonly sessionId: string
  readonly folderId: string
  readonly messages: readonly ChatMessage[]
  readonly lastRunStartedAt: number | null
  /** 本轮派出去的子 Agent 线程；不持久化——它描述的是「这次跑了什么」，不是会话内容。 */
  readonly workerThreads: StandaloneWorkerThreadProjection
  /** main 最近一次送核前算出的上下文用量；仪表读它，renderer 不自己重算。 */
  readonly contextUsage: Nullable<StandaloneContextUsageEstimate>
  /** 每轮开跑前的工作区检查点（对话边界 + git 影子提交），回溯时据此一并回退文件。 */
  readonly checkpoints: readonly StandaloneChatCheckpoint[]
  /** 每轮收尾时记在这一轮最后一条助手消息上的运行标记（已处理折叠、耗时、中止/失败角标）。 */
  readonly messageRunMarkers: readonly StandaloneRunMarker[]
  /** 正在跑的这一轮实时采到的改动；不持久化——重启时那次执行早已不在。 */
  readonly liveRunChanges: Nullable<WorkbenchChatLiveRunChanges>
  readonly revision: number
}

interface AgentExecutionEnvelope {
  protocolVersion?: unknown
  executionId?: unknown
  sourceProductId?: unknown
  sourceSessionId?: unknown
  sessionCorrelationId?: unknown
  channel?: unknown
  payload?: unknown
}

interface ActiveAgentExecution {
  readonly executionId: string
  readonly sessionCorrelationId: string
  readonly sessionId: string
  readonly projectRoot: string
  readonly providerId: WorkbenchChatProviderId
  /** 这一轮的写入识别器：认出主 Agent 与子 Agent 的项目写工具结果（见 workbenchAgentProjectWrites）。 */
  readonly projectWrites: WorkbenchAgentProjectWriteTracker
  /**
   * 这一轮的「本轮改动」：运行中的实时采集与收尾时的最终采集；没有检查点（外部引擎、不是 git 仓库）
   * 时为 null。收尾一律走它的 `finish`。
   */
  readonly runChangeCapture: Nullable<StandaloneRunChangeCapture>
  readonly terminalSettlement: Promise<StandaloneAgentTerminalKind>
  terminalKind: StandaloneAgentTerminalKind | null
  readonly settleTerminal: (kind: StandaloneAgentTerminalKind) => void
}

const states = new Map<string, StandaloneChatState>()
const inactiveStates = new Map<string, StandaloneChatState[]>()
const stateUpdateTargets = new Map<string, string>()
const listeners = new Set<() => void>()
const activeAgentExecutions = new Map<string, ActiveAgentExecution>()
const engineCatalogCache = new Map<string, WorkbenchAgentEngineModelCatalog>()
const engineCatalogRequests = new Map<string, Promise<WorkbenchAgentEngineModelCatalog>>()
const WorkbenchAgentStopSettlementTimeoutMs = 2_250
/** main 已跑完、起搏器还在逐帧吐字时，最多等这么久再一次性排空（积压极大或收尾事件丢失时的兜底）。 */
const StreamPacingSettleLimitMs = 60_000
let idSequence = 0
let streamSequence = 0

/**
 * 会话流的屏显节奏：执行事件先进起搏器，正文逐帧吐字、结构事件按序逐帧应用、干净收尾等积压吐完，
 * 再由下面两个应用函数改会话状态（见 standaloneWorkbenchStreamPacer）。
 */
const standaloneStreamPacer = createStandaloneStreamPacer({
  applyText: applyPacedStreamText,
  applyEvent: applyPacedStreamEvent,
  isStreaming: (executionId) => activeAgentExecutions.has(executionId),
  isSuspended: () => typeof document !== 'undefined' && document.visibilityState === 'hidden',
})

function nextId(prefix: string): string {
  idSequence += 1
  return `${prefix}-${Date.now().toString(36)}-${idSequence.toString(36)}`
}

function createActiveAgentExecution(
  input: Omit<
    ActiveAgentExecution,
    'settleTerminal' | 'terminalKind' | 'terminalSettlement'
  >
): ActiveAgentExecution {
  let settleTerminalPromise!: (kind: StandaloneAgentTerminalKind) => void
  const terminalSettlement = new Promise<StandaloneAgentTerminalKind>((resolve) => {
    settleTerminalPromise = resolve
  })
  const execution: ActiveAgentExecution = {
    ...input,
    terminalKind: null,
    terminalSettlement,
    settleTerminal: (kind) => {
      if (execution.terminalKind) return
      execution.terminalKind = kind
      settleTerminalPromise(kind)
    },
  }
  return execution
}

function settleActiveExecutionFromControlFailure(
  execution: ActiveAgentExecution,
  failure: unknown,
  fallbackMessage: string
): void {
  if (activeAgentExecutions.get(execution.executionId) !== execution) return
  // 已收到的正文先落地，再以失败了结（挂着的干净收尾作废）。
  standaloneStreamPacer.flushImmediate(execution.executionId)
  activeAgentExecutions.delete(execution.executionId)
  execution.settleTerminal('error')
  withStateUpdateTarget(execution.projectRoot, execution.providerId, execution.sessionId, () => {
    finishWithError(
      execution.projectRoot,
      execution.providerId,
      failure instanceof Error ? failure.message : fallbackMessage
    )
  })
  // 这一轮在界面上已经了结（可以接着发下一条）：「进行中」的改动现在就按正常收尾规则落定或撤下，
  // 不等底层 invoke 哪天返回——那时下一轮可能已经开跑，再比对就混进了下一轮的改动。
  execution.runChangeCapture?.finish()
}

function resolveCurrentFileLabel(path: string): string {
  const segments = path.replace(/\\/gu, '/').split('/').filter(Boolean)
  return segments.at(-1) ?? path
}

function stateKey(projectRoot: string, providerId: WorkbenchChatProviderId): string {
  return `${providerId}\0${projectRoot.trim()}`
}

function createState(
  projectRoot: string,
  providerId: WorkbenchChatProviderId,
  restoreStored = true
): StandaloneChatState {
  const id = nextId(`workbench-${providerId}`)
  const empty: StandaloneChatState = {
    providerId,
    projectRoot,
    sessionId: id,
    folderId: `folder-${id}`,
    messages: [],
    status: 'idle',
    teamPhase: null,
    activeTurn: null,
    completedTurns: 0,
    lastError: null,
    connectionRetryAttempt: null,
    connectionRetryMaxAttempts: null,
    awaitingInputQuestion: null,
    awaitingConfirmationMessage: null,
    awaitingConfirmationDetail: null,
    lastRunStartedAt: null,
    lastRunFinishedAt: null,
    workerThreads: createEmptyWorkerThreadProjection(),
    contextUsage: null,
    checkpoints: [],
    messageRunMarkers: [],
    liveRunChanges: null,
    revision: 0,
  }
  if (!restoreStored || !projectRoot || typeof window === 'undefined') return empty
  try {
    const raw = window.localStorage.getItem(chatStorageKey(projectRoot, providerId))
      ?? (providerId === 'workbench'
        ? window.localStorage.getItem(legacyChatStorageKey(projectRoot))
        : null)
    if (!raw) return empty
    const stored = JSON.parse(raw) as Record<string, unknown>
    const storedSessions = stored.version === 2 && Array.isArray(stored.sessions)
      ? stored.sessions
      : [stored]
    const restored = storedSessions
      .map((candidate) => restoreStoredState(candidate, empty))
      .filter((candidate): candidate is StandaloneChatState => candidate !== null)
    if (restored.length === 0) return empty
    const activeSessionId = typeof stored.activeSessionId === 'string'
      ? stored.activeSessionId
      : restored[0]!.sessionId
    const active = restored.find((candidate) => candidate.sessionId === activeSessionId)
      ?? restored[0]!
    inactiveStates.set(
      stateKey(projectRoot, providerId),
      restored.filter((candidate) => candidate.sessionId !== active.sessionId)
    )
    return active
  } catch {
    return empty
  }
}

function restoreStoredState(
  value: unknown,
  empty: StandaloneChatState
): StandaloneChatState | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const stored = value as Partial<StandaloneChatState>
  if (!Array.isArray(stored.messages)) return null
  // 被打断的一轮随会话留存（Desktop 靠持久化的运行 marker）：重启后提示还在，
  // 下一条消息也仍按续接处理。运行中的状态不留存——重启时那次执行早已不在。
  const interruptedStatus = stored.status && isInterruptedRunStatus(stored.status)
    ? stored.status
    : null
  const messages = pauseUnappliedRunGuidance(
    sanitizeStandaloneChatMessages(stored.messages.filter(isStoredChatMessage)),
    { includePending: true }
  )
  return {
    ...empty,
    sessionId: typeof stored.sessionId === 'string' ? stored.sessionId : empty.sessionId,
    folderId: typeof stored.folderId === 'string' ? stored.folderId : empty.folderId,
    messages,
    status: interruptedStatus ?? empty.status,
    lastError: interruptedStatus && typeof stored.lastError === 'string' ? stored.lastError : null,
    checkpoints: Array.isArray(stored.checkpoints)
      ? stored.checkpoints.filter(isStoredStandaloneCheckpoint)
      : [],
    messageRunMarkers: restoreStandaloneRunMarkers(stored.messageRunMarkers, messages),
    revision: typeof stored.revision === 'number' ? stored.revision : 0,
    lastRunStartedAt: typeof stored.lastRunStartedAt === 'number'
      ? stored.lastRunStartedAt
      : null,
    lastRunFinishedAt: typeof stored.lastRunFinishedAt === 'number'
      ? stored.lastRunFinishedAt
      : null,
    // 上一轮的用量随会话留存：重新打开对话时仪表直接显示，不必等下一轮送核。
    contextUsage: readStandaloneContextUsageEstimate({
      ...asRecord(stored.contextUsage),
      kind: 'context-usage-estimate',
    }),
  }
}

function useAgentEngineCatalog(
  providerId: WorkbenchChatProviderId
): WorkbenchAgentEngineModelCatalog | null {
  const [catalogRevision, setCatalogRevision] = useState(0)
  const [catalog, setCatalog] = useState<WorkbenchAgentEngineModelCatalog | null>(() =>
    providerId === 'workbench' ? null : engineCatalogCache.get(providerId) ?? null
  )
  useEffect(() => window.velarosWorkbenchResourcePlugins.onChanged(() => {
    engineCatalogCache.delete('claude-code')
    engineCatalogCache.delete('codex')
    engineCatalogRequests.delete('claude-code')
    engineCatalogRequests.delete('codex')
    setCatalog(null)
    setCatalogRevision((revision) => revision + 1)
  }), [])
  useEffect(() => {
    if (providerId === 'workbench') {
      setCatalog(null)
      return
    }
    const cached = engineCatalogCache.get(providerId)
    if (cached) {
      setCatalog(cached)
      return
    }
    const request = engineCatalogRequests.get(providerId)
      ?? window.velarosWorkbenchResourcePlugins.listAgentEngineModels(providerId).catch((error) => ({
        engineId: providerId,
        available: false,
        reason: error instanceof Error ? error.message : String(error),
        models: [],
      }))
    engineCatalogRequests.set(providerId, request)
    let cancelled = false
    void request.then((next) => {
      engineCatalogCache.set(providerId, next)
      engineCatalogRequests.delete(providerId)
      if (!cancelled) setCatalog(next)
    })
    return () => {
      cancelled = true
    }
  }, [catalogRevision, providerId])
  return catalog
}

function getState(
  projectRoot: string,
  providerId: WorkbenchChatProviderId
): StandaloneChatState {
  const normalized = projectRoot.trim()
  const key = stateKey(normalized, providerId)
  const existing = states.get(key)
  if (existing) return existing
  const created = createState(normalized, providerId)
  states.set(key, created)
  return created
}

function updateState(
  projectRoot: string,
  providerId: WorkbenchChatProviderId,
  updater: (state: StandaloneChatState) => StandaloneChatState
): void {
  const key = stateKey(projectRoot, providerId)
  const active = getState(projectRoot, providerId)
  const targetSessionId = stateUpdateTargets.get(key) ?? active.sessionId
  if (targetSessionId !== active.sessionId) {
    const inactive = inactiveStates.get(key) ?? []
    const targetIndex = inactive.findIndex((candidate) => candidate.sessionId === targetSessionId)
    if (targetIndex < 0) return
    const nextInactive = [...inactive]
    const next = updater(inactive[targetIndex]!)
    nextInactive[targetIndex] = next
    inactiveStates.set(key, nextInactive)
    persistState(active)
    for (const listener of listeners) listener()
    return
  }
  const next = updater(active)
  states.set(key, next)
  persistState(next)
  for (const listener of listeners) listener()
}

function withStateUpdateTarget(
  projectRoot: string,
  providerId: WorkbenchChatProviderId,
  sessionId: string,
  action: () => void
): void {
  const key = stateKey(projectRoot, providerId)
  const previous = stateUpdateTargets.get(key)
  stateUpdateTargets.set(key, sessionId)
  try {
    action()
  } finally {
    if (previous) stateUpdateTargets.set(key, previous)
    else stateUpdateTargets.delete(key)
  }
}

function readAllStates(
  projectRoot: string,
  providerId: WorkbenchChatProviderId
): readonly StandaloneChatState[] {
  const active = getState(projectRoot, providerId)
  return [active, ...(inactiveStates.get(stateKey(projectRoot, providerId)) ?? [])]
}

function activateState(
  projectRoot: string,
  providerId: WorkbenchChatProviderId,
  sessionId: string
): boolean {
  const key = stateKey(projectRoot, providerId)
  const active = getState(projectRoot, providerId)
  if (active.sessionId === sessionId) return true
  const inactive = inactiveStates.get(key) ?? []
  const next = inactive.find((candidate) => candidate.sessionId === sessionId)
  if (!next) return false
  states.set(key, next)
  inactiveStates.set(key, [active, ...inactive.filter((candidate) => candidate !== next)])
  persistState(next, { immediate: true })
  for (const listener of listeners) listener()
  return true
}

/** 订阅函数保持同一个引用：换引用会让 useSyncExternalStore 每次渲染都退订再重订。 */
function subscribeStandaloneChatStore(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function useStandaloneChatState(
  projectRoot: string,
  providerId: WorkbenchChatProviderId
): StandaloneChatState {
  return useSyncExternalStore(
    subscribeStandaloneChatStore,
    () => getState(projectRoot, providerId),
    () => getState(projectRoot, providerId)
  )
}

/**
 * 项目级视图（见 WorkbenchChatProjectRuntime）：当前会话、会话列表、各会话的运行标记。
 * 按视图用到的字段判等，字段都没变就交回同一份，订阅它的页面模型直接跳过这次渲染；
 * 流式输出只改最后一条回答的内容，不会让它换新。
 */
interface StandaloneProjectRuntimeView {
  readonly active: StandaloneChatState
  readonly sessions: readonly StandaloneChatState[]
}

const projectRuntimeViews = new Map<
  string,
  { readonly signature: readonly unknown[]; readonly view: StandaloneProjectRuntimeView }
>()

function readStandaloneProjectRuntimeView(
  projectRoot: string,
  providerId: WorkbenchChatProviderId
): StandaloneProjectRuntimeView {
  const key = stateKey(projectRoot, providerId)
  const active = getState(projectRoot, providerId)
  const sessions = readAllStates(projectRoot, providerId)
  const signature = [active.sessionId, ...sessions.flatMap(readProjectRuntimeFieldIdentities)]
  const cached = projectRuntimeViews.get(key)
  if (cached && isSameIdentityList(cached.signature, signature)) return cached.view
  const view = { active, sessions }
  projectRuntimeViews.set(key, { signature, view })
  return view
}

function readProjectRuntimeFieldIdentities(state: StandaloneChatState): unknown[] {
  return [
    state.sessionId,
    state.folderId,
    readStandaloneChatTitle(state),
    state.messages.length === 0,
    isActiveChatRun(state.status),
    state.lastRunStartedAt,
    state.lastRunFinishedAt,
    state.messageRunMarkers,
    state.liveRunChanges,
  ]
}

function toSnapshot(state: StandaloneChatState, folderId: string): WorkbenchChatSessionSnapshot {
  return {
    id: state.sessionId,
    folderId,
    kind: 'chat',
    rootPath: state.projectRoot,
    space: 'project',
    workspaceVersion: state.revision,
    messages: state.messages,
    runtime: {
      status: state.status,
      lastRunStartedAt: state.lastRunStartedAt,
      lastRunFinishedAt: state.lastRunFinishedAt,
    },
    activeBranchId: 'main',
    messagePaging: null,
    messageRunMarkers: state.messageRunMarkers,
    liveRunChanges: state.liveRunChanges,
    workerThreads: [],
  }
}

function useStandaloneProjectRuntime(
  projectRoot: Nullable<string>,
  providerId: WorkbenchChatProviderId = 'workbench'
): WorkbenchChatProjectRuntime {
  const normalizedRoot = projectRoot?.trim() ?? ''
  const readView = (): StandaloneProjectRuntimeView =>
    readStandaloneProjectRuntimeView(normalizedRoot, providerId)
  const view = useSyncExternalStore(subscribeStandaloneChatStore, readView, readView)
  return useMemo(
    () => buildStandaloneProjectRuntime(projectRoot, normalizedRoot, providerId, view),
    [normalizedRoot, projectRoot, providerId, view]
  )
}

function buildStandaloneProjectRuntime(
  projectRoot: Nullable<string>,
  normalizedRoot: string,
  providerId: WorkbenchChatProviderId,
  { active: state, sessions: allStates }: StandaloneProjectRuntimeView
): WorkbenchChatProjectRuntime {
  // 一个项目一个会话文件夹，会话是它的成员（见 standaloneChatSessionList）。
  const folderId = standaloneProjectFolderId(normalizedRoot, providerId)
  // 当前会话在前，其余按最近使用排（切走时排到最前）。
  const groups = projectStandaloneSessionGroups({
    folderId,
    projectRoot: normalizedRoot,
    activeSessionId: state.sessionId,
    title: readStandaloneChatTitle(state),
    entries: allStates.map((candidate) => ({
      sessionId: candidate.sessionId,
      title: readStandaloneChatTitle(candidate),
      projectRoot: candidate.projectRoot,
      updatedAt: candidate.lastRunFinishedAt ?? candidate.lastRunStartedAt ?? 0,
      isEmpty: candidate.messages.length === 0,
      isStreaming: isActiveChatRun(candidate.status),
    })),
  })

  return {
    projectRoot,
    currentSession: toSnapshot(state, folderId),
    sessions: allStates.map((candidate) => toSnapshot(candidate, folderId)),
    conversationVersion: state.revision,
    browserActivationToken: null,
    sessionList: {
      activeMemberSessionId: state.sessionId,
      activeSessionId: folderId,
      deletingSessionId: null,
      diskSessionHydrated: true,
      groups,
      archiveGroups: [],
    },
    actions: {
      addProjectSession: async () => {
        const key = stateKey(normalizedRoot, providerId)
        const active = getState(normalizedRoot, providerId)
        const next = createState(normalizedRoot, providerId, false)
        inactiveStates.set(key, [active, ...(inactiveStates.get(key) ?? [])])
        states.set(key, next)
        persistState(next, { immediate: true })
        for (const listener of listeners) listener()
        return true
      },
      // 面板的「归档当前聊天会话」传的是项目文件夹：归档的是当前这个会话。
      archiveSession: async (targetFolderId) => {
        const key = stateKey(normalizedRoot, providerId)
        const active = getState(normalizedRoot, providerId)
        const inactive = inactiveStates.get(key) ?? []
        const target = targetFolderId === folderId
          ? active
          : [active, ...inactive].find((candidate) => candidate.folderId === targetFolderId)
        if (!target || isActiveChatRun(target.status)) return
        releaseRemovedSession(target)
        if (target.sessionId === active.sessionId) {
          const [replacement, ...remaining] = inactive
          const next = replacement ?? createState(normalizedRoot, providerId, false)
          states.set(key, next)
          inactiveStates.set(key, remaining)
          persistState(next, { immediate: true })
        } else {
          inactiveStates.set(
            key,
            inactive.filter((candidate) => candidate.sessionId !== target.sessionId)
          )
          persistState(active, { immediate: true })
        }
        for (const listener of listeners) listener()
      },
      selectSession: (_folderId, memberSessionId) => {
        activateState(normalizedRoot, providerId, memberSessionId)
      },
      startProjectChat: () => folderId,
    },
  }
}

function StandaloneWorkbenchChatSessionSurface({
  providerId,
  projectRoot,
  currentFilePath,
  conversationRefreshKey,
  scrollNavigatorHidden = false,
  pendingBrowserElementSelections,
  onBrowserElementSelectionsConsumed,
  onOpenFileChange,
  onOpenWorkspacePath,
  onReviewFileChanges,
  onReviewRunChanges,
}: WorkbenchChatSessionSurfaceProps): ReactElement {
  const chat = useStandaloneChatState(projectRoot, providerId)
  const hasPendingAgentExecution = !!findActiveExecution(
    projectRoot,
    providerId,
    chat.sessionId
  )
  const { t, locale } = useWorkbenchI18n()
  const conversationTranslator = useConversationTranslatorRuntime()
  const modelConfig = useStandaloneWorkbenchModelConfig()
  const managedModelState = useStandaloneWorkbenchManagedModels()
  const selectedManagedProvider = getStandaloneWorkbenchManagedProvider(
    modelConfig.provider,
    managedModelState
  )
  const engineCatalog = useAgentEngineCatalog(providerId)
  const [engineModel, setEngineModel] = useState(() => readStoredEngineModel(providerId))
  const [prompt, setPrompt] = useState('')
  const [files, setFiles] = useState<File[]>([])
  /** 用户在浏览器里拾取、还没随消息发出的页面元素（输入框上方的 chip）。 */
  const [browserSelections, setBrowserSelections] = useState<BrowserElementSelection[]>([])
  const [includedCurrentFilePath, setIncludedCurrentFilePath] =
    useState<Nullable<string>>(currentFilePath)
  const [goalMode, setGoalMode] = useState(false)
  const [planMode, setPlanMode] = useState(false)
  const [runProfile, setRunProfile] = useState<RunProfileSelectionId>(readStoredRunProfile)
  const [reasoningLevel, setReasoningLevel] = useState<ReasoningLevel>(readStoredReasoningLevel)
  const [showThinkingProcess, setShowThinkingProcess] = useState(true)
  const [accountSignInPending, setAccountSignInPending] = useState(false)
  // 原生执行栈正在跑（本会话有在途执行）：输入框保持可用，发送即引导；显式「结束后发送」进排队。
  const canSteerRun =
    providerId === 'workbench' && chat.status === 'running' && hasPendingAgentExecution
  const queuedDrafts = useStandaloneQueuedDrafts({
    scopeId: chat.sessionId,
    isRunBlocked: shouldBlockStandaloneRunSubmission(
      chat.status,
      hasPendingAgentExecution,
      accountSignInPending
    ),
    // 用户按了停止（或本轮失败）：保留排队，但不替他自动发下一条（与 Desktop 一致）。
    pauseAutomaticDrain: chat.status === 'stopping' || isInterruptedRunStatus(chat.status),
    submitDraft: (draft) =>
      new Promise<boolean>((resolve) => {
        void submit(draft.value, draft.files, { onAccepted: () => resolve(true) }).then(resolve)
      }),
  })
  // 目标自动续跑（规则见 resolveWorkbenchGoalAutoContinue）：每个会话自上次用户亲自发言以来续跑了几轮。
  const goalAutoContinueRoundsRef = useRef(new Map<string, number>())
  const handledGoalContinueRunRef = useRef<Nullable<string>>(null)
  const queuedDraftCountLatest = useLatest(queuedDrafts.drafts.length)

  useEffect(() => {
    // 流里的完成事件先把状态记成 completed，执行记录要等 invoke 返回才释放：释放之前开不了下一轮，
    // 先不处理这一轮，等释放后的那次渲染再判断。
    if (
      providerId !== 'workbench'
      || chat.status !== 'completed'
      || !chat.lastRunFinishedAt
      || hasPendingAgentExecution
    ) return
    const sessionId = chat.sessionId
    const finishedAt = chat.lastRunFinishedAt
    const runKey = `${sessionId}:${finishedAt}`
    if (handledGoalContinueRunRef.current === runKey) return
    handledGoalContinueRunRef.current = runKey

    void (async () => {
      const lifecycle = await window.velarosWorkbenchKernel
        .getGoalLifecycle({ sessionId })
        .catch((error: unknown) => {
          log.warn('读取目标失败，不自动续跑', { sessionId, error })
          return null
        })
      // 读目标期间用户可能已经发了新消息或切到别的会话：只在同一轮结束的现场续跑。
      const current = getState(projectRoot, providerId)
      if (
        current.sessionId !== sessionId
        || current.status !== 'completed'
        || current.lastRunFinishedAt !== finishedAt
        || !!findActiveExecution(projectRoot, providerId, sessionId)
      ) return

      const consecutiveAutoRounds = goalAutoContinueRoundsRef.current.get(sessionId) ?? 0
      const decision = resolveWorkbenchGoalAutoContinue({
        runCompleted: true,
        msSinceRunFinished: Date.now() - finishedAt,
        goal: lifecycle?.ok ? lifecycle.goal : null,
        hasQueuedUserInput: queuedDraftCountLatest.current > 0,
        consecutiveAutoRounds,
      })
      if (decision.kind === 'round-limit') {
        workbenchMessage.info({
          title: t('workbench.goalAutoContinueLimitTitle'),
          description: t('workbench.goalAutoContinueLimitDescription', {
            count: consecutiveAutoRounds,
          }),
        })
        return
      }
      if (decision.kind !== 'continue') return

      goalAutoContinueRoundsRef.current.set(sessionId, consecutiveAutoRounds + 1)
      const summary = t('workbench.goalAutoContinueNotice')
      await submit(summary, [], {
        goalMode: true,
        systemNotice: {
          summary,
          detail: t('workbench.goalAutoContinueInstruction', { objective: decision.objective }),
        },
      })
    })()
  }, [
    chat.lastRunFinishedAt,
    chat.sessionId,
    chat.status,
    hasPendingAgentExecution,
    projectRoot,
    providerId,
  ])

  const lastOutboundMessage = chat.messages.findLast((message) => message.role === 'user')
  const autoScrollResetKey = [
    chat.sessionId,
    lastOutboundMessage?.id ?? '',
    lastOutboundMessage?.timestamp ?? '',
  ].join(':')
  const readScrollTop = useCallback(
    () => readStandaloneChatScrollPosition(chat.sessionId),
    [chat.sessionId]
  )
  const writeScrollTop = useCallback(
    (scrollTop: number) => saveStandaloneChatScrollPosition(chat.sessionId, scrollTop),
    [chat.sessionId]
  )
  // 切会话、收起再打开面板都回到这个会话上次看的位置（与 Desktop 相同）。
  const { followLocked, scrollRef, setFollowLocked } = useScrollToBottom<HTMLDivElement>(
    chat.revision,
    autoScrollResetKey,
    { restoreKey: chat.sessionId, readScrollTop, writeScrollTop }
  )

  useEffect(() => {
    setIncludedCurrentFilePath(currentFilePath)
  }, [currentFilePath])

  // 换会话清空未发出的拾取；必须声明在收件 effect 之前——挂载时两者同帧执行，顺序反了会把
  // 刚收进来的投递立刻清掉。
  useEffect(() => {
    setBrowserSelections([])
  }, [chat.sessionId])

  // 宿主投递来的拾取结果收进输入框，并回执「已接收」让宿主清掉待投递项。
  useEffect(() => {
    if (pendingBrowserElementSelections.length === 0) return
    setBrowserSelections((current) => {
      const known = new Set(current.map((selection) => selection.id))
      const incoming = pendingBrowserElementSelections
        .map((delivery) => delivery.selection)
        .filter((selection) => !known.has(selection.id))
      return incoming.length > 0 ? [...current, ...incoming] : current
    })
    onBrowserElementSelectionsConsumed?.(
      pendingBrowserElementSelections.map((delivery) => delivery.deliveryId)
    )
  }, [onBrowserElementSelectionsConsumed, pendingBrowserElementSelections])

  useEffect(() => {
    if (
      managedModelState.status !== 'ready'
      || !isStandaloneWorkbenchManagedProviderId(modelConfig.provider)
      || selectedManagedProvider
    ) return
    selectStandaloneWorkbenchModelProvider('openrouter')
  }, [managedModelState.status, modelConfig.provider, selectedManagedProvider])

  useEffect(() => {
    if (!engineCatalog?.available || engineCatalog.models.length === 0) return
    const selected = engineCatalog.models.some((model) => model.value === engineModel)
      ? engineModel
      : engineCatalog.models.find((model) => model.isDefault)?.value
        ?? engineCatalog.models[0]?.value
        ?? ''
    if (!selected || selected === engineModel) return
    setEngineModel(selected)
    storeEngineModel(providerId, selected)
  }, [engineCatalog, engineModel, providerId])

  useEffect(() =>
    window.velarosWorkbenchKernel.onAgentExecution((rawEnvelope) => {
      const envelope = rawEnvelope as AgentExecutionEnvelope
      if (
        envelope.protocolVersion !== AgentCapabilityProtocolVersion
        || envelope.sourceProductId !== 'velaros.workbench'
      ) return
      const executionId = typeof envelope.executionId === 'string'
        ? envelope.executionId
        : null
      const activeExecution = executionId
        ? activeAgentExecutions.get(executionId)
        : null
      if (
        !activeExecution
        || envelope.sourceSessionId !== activeExecution.sessionId
        || envelope.sessionCorrelationId !== activeExecution.sessionCorrelationId
      ) return
      // `workbench:*` 工具的界面请求：交给页面在界面上执行，回执交回主进程；不进会话内容。
      const uiRequest = envelope.channel === 'agent'
        ? readWorkbenchAgentUiRequest(readAgentEventPayload(envelope))
        : null
      if (uiRequest) {
        void performWorkbenchAgentUiRequest(activeExecution.projectRoot, uiRequest)
          .then((response) => window.velarosWorkbenchKernel.respondAgentUiRequest(response))
          .catch((error: unknown) => {
            log.warn('Agent 界面请求回执失败', { requestId: uiRequest.requestId, error })
          })
        return
      }
      // 进起搏器按屏显节奏落地（与 Desktop 同一个起搏器）：正文逐帧吐字，其余按序逐帧应用。
      const payload = readAgentEventPayload(envelope)
      if (!payload) return
      // Agent（含子 Agent）写了项目文件：这一轮的「本轮改动」跟上，Git 等界面也按项目根收到通知。
      if (envelope.channel === 'agent' && activeExecution.projectWrites.observe(payload)) {
        activeExecution.runChangeCapture?.request()
        publishWorkbenchAgentProjectWrite(activeExecution.projectRoot)
      }
      streamSequence += 1
      if (envelope.channel === 'agent' && payload.type === 'text-delta') {
        if (typeof payload.text === 'string')
          standaloneStreamPacer.enqueueText(activeExecution.executionId, streamSequence, payload.text)
        return
      }
      standaloneStreamPacer.enqueueLiveEvent(activeExecution.executionId, streamSequence, {
        kind: 'envelope',
        channel: envelope.channel,
        payload,
      })
    }), [])

  async function stop(): Promise<void> {
    const activeExecution = findActiveExecution(projectRoot, providerId, chat.sessionId)
    if (!activeExecution) return

    // 先在 renderer 收敛到 stopping，阻止晚到的 phase/token 把按钮重新变回运行态；
    // 同时解除用户可能显式开启的强制跟随，让停止期间也能自由查看已有结果。
    setFollowLocked(false)
    withStateUpdateTarget(projectRoot, providerId, activeExecution.sessionId, () => {
      updateState(projectRoot, providerId, (state) => ({
        ...beginStandaloneAgentStop(state),
        revision: state.revision + 1,
      }))
    })
    // 要停就不再逐帧吐字：已收到的正文立刻落地。main 若已跑完，挂着的收尾也随之落地，
    // 停止在这里就了结，不必干等打字效果吐完。
    standaloneStreamPacer.drain(activeExecution.executionId)

    const settlement = await awaitStandaloneAgentStopSettlement({
      // 协调器先启动 timeout，再进入此 IPC；preload/main 永不返回也能有界释放 UI。
      requestAbort: () => window.velarosWorkbenchKernel.abortAgentExecution({
        executionId: activeExecution.executionId,
      }),
      terminalSettlement: activeExecution.terminalSettlement,
      readTerminalKind: () => activeExecution.terminalKind,
      timeoutMs: WorkbenchAgentStopSettlementTimeoutMs,
    })
    if (
      settlement.kind === 'terminal'
      || activeAgentExecutions.get(activeExecution.executionId) !== activeExecution
    ) return

    // rejected/error/timeout 都没有确认底层已终止，不能伪装成 aborted；恢复可发送并明确失败。
    settleActiveExecutionFromControlFailure(
      activeExecution,
      settlement.kind === 'request-error' ? settlement.error : null,
      t('workbench.chatStopFailed')
    )
  }

  /**
   * 点开输入框里的附件（与 Desktop 相同，附件得有本机路径）：项目里的文件在编辑器里打开，
   * 项目之外的交给系统默认应用。
   */
  async function openAttachedFile(file: File): Promise<void> {
    const path = resolveWorkbenchClipboardFilePath(file, window.velarosWorkbenchProjectHub.getPathForFile)
    if (!path) return
    if (onOpenWorkspacePath && (await onOpenWorkspacePath(path)) !== false) return
    const opened = await window.velarosWorkbenchProjectHub.openSystemPath(path)
    if (!opened.opened)
      workbenchMessage.error({
        title: t('chat.fileChangeOpenErrorTitle'),
        description: opened.error ?? path,
      })
  }

  /**
   * 输入框的发送入口：运行中显式选「结束后发送」进排队，其余交给 submit（运行中即引导）。
   * 以「受理」为界返回——输入框在返回前一直处于发送中，不能让它等整轮跑完。
   */
  function sendComposerDraft(draft?: ChatInputSendDraft): Promise<void> {
    const value = draft?.value ?? prompt
    const draftFiles = draft?.files ?? files
    // 引导通道只带文本：运行中附带文件的消息改为本轮结束后发送。
    if (canSteerRun && (draft?.delivery === 'after-current' || draftFiles.length > 0)) {
      if (!value.trim() && draftFiles.length === 0) return Promise.resolve()
      queuedDrafts.enqueue({ value, files: draftFiles })
      setPrompt('')
      setFiles([])
      return Promise.resolve()
    }
    return new Promise<void>((resolve) => {
      void submit(value, draftFiles, { onAccepted: resolve }).finally(resolve)
    })
  }

  async function sendRunGuidance(
    text: string,
    selections: readonly BrowserElementSelection[] = []
  ): Promise<boolean> {
    const sessionId = chat.sessionId
    const guidance: ChatMessage = {
      ...createTextMessage('user', text || buildBrowserElementDisplayFallback(selections)),
      conversationKind: 'run-guidance',
      guidanceStatus: 'pending',
      ...(selections.length > 0 ? { browserElementSelections: [...selections] } : {}),
    }
    // 引导通道只带文字：拾取的元素折成上下文段跟在正文后面。
    const guidanceText = [text, formatBrowserElementSelectionsForPrompt(selections)]
      .filter(Boolean)
      .join('\n\n')
    // 回执回来时用户可能已切到别的会话：更新一律落回发出引导的那个会话。
    const updateGuidanceSession = (
      updater: (state: StandaloneChatState) => StandaloneChatState
    ): void =>
      withStateUpdateTarget(projectRoot, providerId, sessionId, () =>
        updateState(projectRoot, providerId, updater)
      )
    setPrompt('')
    setBrowserSelections([])
    updateGuidanceSession((state) => ({
      ...state,
      messages: [...state.messages, guidance],
      revision: state.revision + 1,
    }))
    const accepted = await window.velarosWorkbenchKernel
      .provideAgentGuidance({ sessionId, inputId: guidance.id, text: guidanceText })
      .catch(() => false)
    if (accepted) {
      // 只推进「引导中」：回执之前 input-applied 可能已经先到（已纳入），不能被拉回。
      // 回执到时这一轮已经收尾的，引导不会再被读走——直接记为已暂停。
      updateGuidanceSession((state) => ({
        ...state,
        messages: state.messages.map((message) =>
          message.id === guidance.id && message.guidanceStatus === 'pending'
            ? { ...message, guidanceStatus: isActiveChatRun(state.status) ? 'accepted' : 'paused' }
            : message
        ),
        revision: state.revision + 1,
      }))
      return true
    }
    // 这一轮恰好收尾、或执行体不接收引导：撤回这条引导，原文放回输入框，由用户重新发送。
    updateGuidanceSession((state) => ({
      ...state,
      messages: state.messages.filter((message) => message.id !== guidance.id),
      revision: state.revision + 1,
    }))
    setPrompt(text)
    setBrowserSelections([...selections])
    workbenchMessage.warning({
      title: t('workbench.chatGuidanceRejectedTitle'),
      description: t('workbench.chatGuidanceRejectedDescription'),
    })
    return false
  }

  /**
   * 本轮开跑前的检查点：对话边界（这条用户消息的下标）+ 项目工作树的 git 影子提交。
   * 不是 git 仓库或捕获失败时 commitId 为 null——照样记下边界，这一轮只能回溯对话。
   */
  async function captureRunCheckpoint(
    sessionId: string,
    captureMessageCount: number,
    label: string
  ): Promise<StandaloneChatCheckpoint> {
    const checkpointId = nextId('workbench-checkpoint')
    const captured = await window.velarosWorkbenchGit
      .captureChatCheckpoint({
        workspaceRoot: projectRoot,
        sessionId,
        checkpointId,
        label: label.replace(/\s+/gu, ' ').trim().slice(0, 48),
      })
      .catch(() => null)
    const checkpoint: StandaloneChatCheckpoint = {
      id: checkpointId,
      captureMessageCount,
      createdAt: Date.now(),
      commitId: captured?.ok ? captured.value.commitId : null,
    }
    let evicted: StandaloneChatCheckpoint[] = []
    withStateUpdateTarget(projectRoot, providerId, sessionId, () =>
      updateState(projectRoot, providerId, (state) => {
        const appended = appendStandaloneCheckpoint(state.checkpoints, checkpoint)
        evicted = appended.evicted
        return { ...state, checkpoints: appended.checkpoints }
      })
    )
    releaseCheckpointRefs(projectRoot, sessionId, evicted)
    return checkpoint
  }

  /**
   * 这一轮的「本轮改动」：运行中写工具的结果一到（按节奏合并）就拿工作树与这一轮开跑前的检查点比一次，
   * 与收尾时的最终采集用同一个记录 id、覆盖同一条记录；摘要挂在会话的「进行中」上，「AI 改动」面板
   * 据此实时显示这一轮。收尾时的最终采集见 `captureRunChanges`。
   */
  function createRunChangeCapture(
    sessionId: string,
    checkpoint: StandaloneChatCheckpoint
  ): Nullable<StandaloneRunChangeCapture> {
    const baseCommitId = checkpoint.commitId
    if (!baseCommitId) return null
    return createStandaloneRunChangeCapture({
      timing: StandaloneRunChangeCaptureTiming,
      capture: () =>
        window.velarosWorkbenchGit
          .captureChatRunChanges({
            workspaceRoot: projectRoot,
            sessionId,
            recordId: checkpoint.id,
            baseCommitId,
          })
          .then(
            (result) => {
              if (result.ok) return result.value
              log.warn('本轮改动实时采集失败', { sessionId, message: result.message })
              return null
            },
            (error: unknown) => {
              log.warn('本轮改动采集通道不可用', { sessionId, error })
              return null
            }
          ),
      onCaptured: (summary) => {
        withStateUpdateTarget(projectRoot, providerId, sessionId, () =>
          updateState(projectRoot, providerId, (state) => ({
            ...state,
            liveRunChanges: { firstMessageIndex: checkpoint.captureMessageCount, summary },
          }))
        )
      },
      settle: () => captureRunChanges(sessionId, checkpoint),
    })
  }

  /**
   * 一轮收尾后记下「本轮改动」（Desktop captureCompletedRunWorkspaceDiff 的对位件）：拿工作树与
   * 这一轮开跑前的检查点比，补丁落进主进程的记录文件，运行标记上只挂摘要；运行中实时采到的那份随之撤下。
   *
   * 采集请求在收尾的同一拍同步发出：main 按项目根串行，它排在下一条排队消息开跑前的检查点之前，
   * 下一轮的改动混不进这一轮。
   */
  function captureRunChanges(sessionId: string, checkpoint: StandaloneChatCheckpoint): void {
    const baseCommitId = checkpoint.commitId
    const session = readAllStates(projectRoot, providerId)
      .find((candidate) => candidate.sessionId === sessionId)
    if (!baseCommitId || !session) return
    const anchorId = resolveStandaloneRunChangesAnchor(
      session.messages,
      session.messageRunMarkers,
      checkpoint.captureMessageCount
    )
    // 最终摘要挂不上：运行中实时采到的那份连同它的记录一起撤掉，面板里不留一轮永远「进行中」。
    const withdrawLive = (): void => {
      if (withdrawLiveRunChanges(projectRoot, providerId, sessionId, checkpoint.id))
        releaseRunChangeRecords(projectRoot, sessionId, [checkpoint.id])
    }
    if (!anchorId) {
      withdrawLive()
      return
    }

    void window.velarosWorkbenchGit
      .captureChatRunChanges({
        workspaceRoot: projectRoot,
        sessionId,
        recordId: checkpoint.id,
        baseCommitId,
      })
      .then((result) => {
        if (!result.ok) {
          log.warn('本轮改动采集失败', { sessionId, message: result.message })
          withdrawLive()
          return
        }
        const attached = attachRunChanges(projectRoot, providerId, sessionId, anchorId, result.value)
        // 这条消息在采集期间被回溯掉了：刚写下的记录没人引用；被替换掉的旧记录同理。
        const orphaned = attached
          ? attached.replacedRecordId
          : result.value.fileCount > 0 ? checkpoint.id : null
        if (orphaned) releaseRunChangeRecords(projectRoot, sessionId, [orphaned])
      }, (error: unknown) => {
        log.warn('本轮改动采集通道不可用', { sessionId, error })
        withdrawLive()
      })
  }

  /**
   * 回溯预览：确认框打开那一刻同步算出「这次会移除什么、文件能不能跟着回」。与真正执行回溯共用
   * 同一对纯函数（survey + capability），弹窗上写的和实际发生的不会分家。
   */
  function buildRewindPlanForMessage(messageId: string): Nullable<ConversationRewindPlan> {
    const session = getState(projectRoot, providerId)
    const selection = selectStandaloneRewind(session.messages, session.checkpoints, messageId)
    if (!selection) return null
    const survey = surveyRewindRemoval(selection.removedMessages)
    return buildRewindPlan({
      survey,
      files: resolveRewindFileCapability({
        checkpoint: selection.checkpoint,
        changedFilePaths: survey.changedFilePaths,
        toolCallCount: survey.toolCallCount,
      }),
    })
  }

  /**
   * 回溯到某条用户消息之前：截断对话（这条消息本身也移除），按用户选择把项目文件还原到那一轮
   * 开跑前，非干净回溯给模型留一条说明，最后把这条消息的原文放回输入框（与 Desktop 一致）。
   */
  async function rewindToMessage(
    messageId: string,
    options?: { restoreFiles?: boolean }
  ): Promise<void> {
    const sessionId = chat.sessionId
    const session = getState(projectRoot, providerId)
    if (isActiveChatRun(session.status) || findActiveExecution(projectRoot, providerId, sessionId))
      throw new AppError('VALIDATION', t('workbench.chatRewindWhileActive'))

    const selection = session.sessionId === sessionId
      ? selectStandaloneRewind(session.messages, session.checkpoints, messageId)
      : null
    if (!selection) throw new AppError('NOT_FOUND', t('workbench.chatRewindMessageNotFound'))
    const survey = surveyRewindRemoval(selection.removedMessages)
    const files = resolveRewindFileCapability({
      checkpoint: selection.checkpoint,
      changedFilePaths: survey.changedFilePaths,
      toolCallCount: survey.toolCallCount,
    })

    let fileOutcome: RewindFileOutcome = NoRewindFileOutcome
    const commitId = selection.checkpoint?.commitId
    if (options?.restoreFiles && files.kind === 'restorable' && commitId) {
      const restored = await window.velarosWorkbenchGit
        .restoreChatCheckpoint({ workspaceRoot: projectRoot, commitId })
        .catch((error: unknown) => ({
          ok: false as const,
          message: error instanceof Error ? error.message : String(error),
        }))
      fileOutcome = restored.ok
        ? { attempted: true, restored: restored.value.restored, error: restored.value.error }
        : { attempted: true, restored: false, error: restored.message }
    }

    const rewoundAt = Date.now()
    const noticeText = buildRewindNoticeText({
      t,
      fidelity: resolveRewindFidelity({ survey, fileOutcome }),
      survey,
      fileOutcome,
    })
    const notice = noticeText
      ? createStandaloneSystemNotice({ id: nextId('workbench-notice'), ...noticeText, timestamp: rewoundAt })
      : null

    let evicted: StandaloneChatCheckpoint[] = []
    let droppedRunChangeRecordIds: string[] = []
    let applied = false
    withStateUpdateTarget(projectRoot, providerId, sessionId, () =>
      updateState(projectRoot, providerId, (state) => {
        const latest = selectStandaloneRewind(state.messages, state.checkpoints, messageId)
        if (!latest) return state
        applied = true
        evicted = latest.evictedCheckpoints
        const kept = state.messages.slice(0, latest.targetIndex)
        const keptIds = new Set(kept.map((message) => message.id))
        // 被移除的回答连同它们的「本轮改动」记录一起走。
        droppedRunChangeRecordIds = readRunChangeRecordIds(
          state.messageRunMarkers.filter((marker) => !keptIds.has(marker.messageId))
        )
        return {
          ...state,
          messages: notice ? [...kept, notice] : kept,
          checkpoints: latest.keptCheckpoints,
          messageRunMarkers: state.messageRunMarkers.filter((marker) => keptIds.has(marker.messageId)),
          status: 'idle',
          teamPhase: null,
          activeTurn: null,
          completedTurns: 0,
          lastError: null,
          connectionRetryAttempt: null,
          connectionRetryMaxAttempts: null,
          awaitingInputQuestion: null,
          awaitingConfirmationMessage: null,
          awaitingConfirmationDetail: null,
          workerThreads: createEmptyWorkerThreadProjection(),
          // 用量是按被截掉的那段历史算的，留着会让仪表继续显示回溯前的占用。
          contextUsage: null,
          revision: state.revision + 1,
        }
      })
    )
    // 文件已经动过、对话却没截断，是最坏的半途而废：宁可报错让用户看见，也不能静默留一个
    // 「磁盘回到过去、对话停在未来」的反向错位。
    if (!applied)
      throw new AppError(
        fileOutcome.attempted ? 'CONFLICT' : 'NOT_FOUND',
        t(fileOutcome.attempted
          ? 'workbench.chatRewindAppliedFilesOnly'
          : 'workbench.chatRewindMessageNotFound')
      )
    releaseCheckpointRefs(projectRoot, sessionId, evicted)
    releaseRunChangeRecords(projectRoot, sessionId, droppedRunChangeRecordIds)
    // 原文放回输入框；附件的文件句柄已经不在了，只带文字（只有附件的消息正文就是文件名，不回填）。
    const rewound = selection.removedMessages[0]
    const rewoundText = rewound ? readStandaloneModelVisibleText(rewound) : ''
    const attachmentNames = rewound?.attachments?.map((attachment) => attachment.name).join(', ')
    if (rewoundText && rewoundText !== attachmentNames) setPrompt(rewoundText)
    const rewoundSelections = rewound ? readMessageBrowserSelections(rewound) : []
    if (rewoundSelections.length > 0) setBrowserSelections([...rewoundSelections])
  }

  /**
   * 发一条消息。返回是否受理；`onAccepted` 在消息追加进对话、这一轮开始跑的那一刻回调——
   * 函数本身要等整轮结束才 resolve，输入框和排队出队都以「受理」为界，不能等整轮跑完。
   */
  async function submit(
    draftValue = prompt,
    draftFiles = files,
    options?: {
      onAccepted?: () => void
      /** 目标卡的「继续」：这一轮按目标模式跑，不看输入框里的模式开关（与 Desktop continueGoal 相同）。 */
      goalMode?: boolean
      /**
       * 宿主替用户开的一轮（目标自动续跑）：以系统说明而不是用户消息起头，不动输入框里的草稿、附件和
       * 拾取的元素，也不附带当前文件。
       */
      systemNotice?: { summary: string; detail: string }
    }
  ): Promise<boolean> {
    const systemNotice = options?.systemNotice
    // 宿主续跑只接在一轮正常完成之后：运行中进来的话会被当成引导注入，冒充用户发言。
    if (systemNotice && getState(projectRoot, providerId).status !== 'completed') return false
    const text = draftValue.trim()
    const selections = systemNotice ? [] : browserSelections
    // 运行中补发 = 引导：注入正在执行的这一轮，而不是排到结束后另起一轮（与 Desktop 一致）。
    // 外部引擎没有中途注入语义、引导通道也不带附件（附件由输入框入口改为结束后发送），这两种仍按原规则拦下。
    if (
      providerId === 'workbench'
      && chat.status === 'running'
      && (text || selections.length > 0)
      && draftFiles.length === 0
    ) return sendRunGuidance(text, selections)
    if (
      (!text && draftFiles.length === 0 && selections.length === 0)
      || shouldBlockStandaloneRunSubmission(
        chat.status,
        hasPendingAgentExecution,
        accountSignInPending
      )
    ) return false
    if (
      providerId === 'workbench'
      && (!modelConfig.provider.trim() || !modelConfig.model.trim())
    ) {
      workbenchMessage.warning({
        title: t('workbench.chatModelMissingTitle'),
        description: t('workbench.chatModelMissingDescription'),
      })
      return false
    }
    if (providerId !== 'workbench' && !engineCatalog) {
      workbenchMessage.warning({
        title: t('workbench.chatEngineLoadingTitle', {
          engine: providerId === 'claude-code' ? 'Claude Code' : 'ChatGPT / Codex',
        }),
        description: t('workbench.chatEngineLoadingDescription'),
      })
      return false
    }
    if (providerId !== 'workbench' && engineCatalog && !engineCatalog.available) {
      workbenchMessage.warning({
        title: t('workbench.chatEngineUnavailableTitle', {
          engine: providerId === 'claude-code' ? 'Claude Code' : 'ChatGPT / Codex',
        }),
        description: engineCatalog.reason ?? t('workbench.chatEngineUnavailableDescription'),
      })
      return false
    }
    if (providerId === 'workbench') {
      setAccountSignInPending(true)
      try {
        const account = await window.velarosWorkbenchAccount.ensureSignedIn()
        if (account.status !== 'signed-in') return false
      } catch (error) {
        workbenchMessage.warning({
          title: t('workbench.chatSignInFailedTitle'),
          description: t('workbench.chatSignInFailedDescription', {
            error: error instanceof Error ? error.message : String(error),
          }),
        })
        return false
      } finally {
        setAccountSignInPending(false)
      }
    }
    if (
      providerId === 'workbench'
      && isStandaloneWorkbenchManagedProviderId(modelConfig.provider)
    ) {
      try {
        const snapshot = await refreshStandaloneWorkbenchManagedModels()
        const managedProvider = snapshot.managedModels.find(
          (provider) => provider.providerId === modelConfig.provider
        )
        const modelAvailable = managedProvider?.models.some(
          (model) => model.id === modelConfig.model && model.status === 'available'
        )
        if (!managedProvider?.enabled || !modelAvailable) {
          workbenchMessage.warning({
            title: t('workbench.chatManagedModelUnavailableTitle'),
            description: t('workbench.chatManagedModelUnavailableDescription'),
          })
          return false
        }
      } catch (error) {
        workbenchMessage.warning({
          title: t('workbench.chatManagedModelUnavailableTitle'),
          description: t('workbench.chatManagedModelAccessFailed', {
            error: error instanceof Error ? error.message : String(error),
          }),
        })
        return false
      }
    }
    const attachmentContext = await buildAttachmentContext(draftFiles)
    const currentFileContext = includedCurrentFilePath && !systemNotice
      ? `Current Workbench file: ${includedCurrentFilePath}`
      : ''
    const browserElementContext = formatBrowserElementSelectionsForPrompt(selections)
    if (!systemNotice) {
      setPrompt('')
      setFiles([])
      setBrowserSelections([])
      // 用户亲自发了话：目标自动续跑的连续轮数从头算。
      goalAutoContinueRoundsRef.current.delete(chat.sessionId)
    }
    // 只有正常完成才结束一轮：中止或失败后的下一条消息继续被打断的那一轮，按引导呈现、
    // 与上一轮归在同一组里，而不是另起一轮（与 Desktop 的 shouldContinueInterruptedConversation 一致）。
    const continuesInterruptedRun = isInterruptedRunStatus(getState(projectRoot, providerId).status)
    const userMessage: ChatMessage = systemNotice
      ? createStandaloneSystemNotice({
          id: nextId('workbench-goal-continue'),
          ...systemNotice,
          timestamp: Date.now(),
          kind: 'goal-continuation',
        })
      : {
          ...createTextMessage(
            'user',
            text
              || draftFiles.map((file) => file.name).join(', ')
              || buildBrowserElementDisplayFallback(selections)
          ),
          ...(continuesInterruptedRun
            ? { conversationKind: 'run-guidance' as const, guidanceStatus: 'sent' as const }
            : { conversationKind: 'turn-input' as const }),
          ...(selections.length > 0 ? { browserElementSelections: [...selections] } : {}),
        }
    const attachmentMetadata = draftFiles.map((file, index) => ({
      id: `${userMessage.id}-attachment-${index}`,
      kind: file.type.startsWith('image/') ? 'image' as const : 'file' as const,
      name: file.name,
      mediaType: file.type || 'application/octet-stream',
      size: file.size,
      lastModified: file.lastModified,
    }))
    const submittedMessage = attachmentMetadata.length > 0
      ? { ...userMessage, attachments: attachmentMetadata }
      : userMessage
    const submittingSession = getState(projectRoot, providerId)
    updateState(projectRoot, providerId, (state) => ({
      ...state,
      messages: [...state.messages, submittedMessage],
      status: 'running',
      teamPhase: 'creating-task',
      activeTurn: null,
      completedTurns: 0,
      lastError: null,
      connectionRetryAttempt: null,
      connectionRetryMaxAttempts: null,
      awaitingInputQuestion: null,
      awaitingConfirmationMessage: null,
      awaitingConfirmationDetail: null,
      lastRunStartedAt: Date.now(),
      lastRunFinishedAt: null,
      // 子 Agent 线程随轮次归零：上一轮的 worker 卡留在下一轮只会让人以为它还在跑。
      workerThreads: createEmptyWorkerThreadProjection(),
      revision: state.revision + 1,
    }))
    options?.onAccepted?.()
    // 开跑前拍下本轮的工作区检查点，回溯到这条消息时可以一并回退文件（与 Desktop 一致），
    // 收尾后也拿它比出「本轮改动」。只对原生执行栈：外部引擎的会话历史在它自己手里，
    // 回溯改不了它记住的内容，也就不提供回溯。
    const runCheckpoint = providerId === 'workbench'
      ? await captureRunCheckpoint(
          submittingSession.sessionId,
          submittingSession.messages.length,
          text || submittedMessage.attachments?.map((attachment) => attachment.name).join(', ') || ''
        )
      : null

    // P6：模型运行时已在本进程（BYOK 选择直接进 Agent 执行栈），不再有
    // `model.supports-provider` 这种远端预检——provider 不认识时由执行本身报错。
    const latest = getState(projectRoot, providerId)
    const executionId = nextId('workbench-execution')
    const sessionCorrelationId = nextId('workbench-correlation')
    const activeExecution = createActiveAgentExecution({
      executionId,
      sessionCorrelationId,
      sessionId: latest.sessionId,
      projectRoot,
      providerId,
      projectWrites: createWorkbenchAgentProjectWriteTracker(),
      runChangeCapture: runCheckpoint ? createRunChangeCapture(latest.sessionId, runCheckpoint) : null,
    })
    activeAgentExecutions.set(executionId, activeExecution)
    const result = await window.velarosWorkbenchKernel.invoke({
      route: 'agent.execute',
      input: {
        protocolVersion: AgentCapabilityProtocolVersion,
        execution: {
          id: executionId,
          source: {
            productId: 'velaros.workbench',
            sessionId: latest.sessionId,
            correlationId: sessionCorrelationId,
          },
          scopeMetadata: {
            resourceId: projectRoot,
            surface: 'project',
          },
        },
        messages: sanitizeStandaloneChatMessages(latest.messages)
          .map((message) => ({
            role: message.role,
            // 宿主留痕（回溯说明）带着语义过去，main 把它包成系统说明而不是一句用户原话。
            ...(message.conversationKind === 'system-notice'
              ? { conversationKind: 'system-notice' as const }
              : {}),
            content: [
              readStandaloneModelVisibleText(message),
              ...(message.attachments?.length
                ? [message.attachments
                    .map((attachment) =>
                      `Attachment: ${attachment.name} (${attachment.mediaType})`
                    )
                    .join('\n')]
                : []),
              ...(message.id === submittedMessage.id
                ? [currentFileContext, attachmentContext, browserElementContext].filter(Boolean)
                : []),
            ].filter(Boolean).join('\n\n'),
          }))
          .filter((message) => message.content.trim()),
        config: {
          ...(providerId === 'workbench'
            ? {
              modelSelection: {
                provider: modelConfig.provider.trim(),
                model: modelConfig.model.trim(),
                apiKey: modelConfig.apiKey,
                baseURL: modelConfig.baseURL.trim(),
                // 思考力度是模型请求参数，随选择一起下发（与 Desktop 同一条路径）。
                reasoningLevel,
              },
              runProfile,
              // 权限确认策略随每一轮下发（而不是 main 侧常驻）：设置页改档后立刻对下一轮
              // 生效，不必重启会话，也不需要 main 反向读 renderer 的 localStorage。
              // 只对原生执行栈有意义——外部引擎有自己的审批档（approvalPolicy / 沙箱）。
              permissionConfirmationMode: readWorkbenchPermissionConfirmationMode(),
            }
            : {
                engineId: providerId,
                ...(engineModel ? { model: engineModel } : {}),
              }),
          executionModes: [
            ...((options?.goalMode ?? goalMode) ? ['goal' as const] : []),
            ...(planMode ? ['plan' as const] : []),
          ],
        },
      },
    })
    // 停下或失败的一轮也可能已经改了文件：下面每条收尾路径最后都记下「本轮改动」（「AI 改动」要列全
    // 每一轮）。`finish` 只生效一次：停止超时或控制失败时会话面已经提前了结过，这里就是空操作。
    if (!result.ok) {
      const stopped = getState(projectRoot, providerId).status === 'stopping'
      // 起搏器里没吐完的正文先落地；挂着的干净收尾作废——这一轮以停止/失败收尾。
      standaloneStreamPacer.flushImmediate(executionId)
      activeExecution.settleTerminal(stopped ? 'aborted' : 'error')
      const executionStillActive = activeAgentExecutions.delete(executionId)
      if (executionStillActive) {
        withStateUpdateTarget(projectRoot, providerId, activeExecution.sessionId, () => {
          if (stopped) {
            finishRun(projectRoot, providerId, 'aborted')
          } else {
            finishWithError(projectRoot, providerId, result.error.message)
          }
        })
      }
      activeExecution.runChangeCapture?.finish()
      return true
    }

    const finalStatus = readStandaloneFinalAgentStatus(result.output)
    // 正常跑完：等起搏器把正文平滑吐完、落地收尾再了结；停止/失败直接排空积压。
    if (finalStatus === 'aborted' || finalStatus === 'error') standaloneStreamPacer.flushImmediate(executionId)
    else await settleStreamPacing(executionId)
    activeExecution.settleTerminal(
      finalStatus === 'aborted' || finalStatus === 'error' ? finalStatus : 'done'
    )
    const executionStillActive = activeAgentExecutions.delete(executionId)
    // 流里的终态事件已经把这一轮收了尾（停止、失败）：只差记下改动。
    if (!executionStillActive) {
      activeExecution.runChangeCapture?.finish()
      return true
    }
    if (finalStatus === 'aborted') {
      withStateUpdateTarget(projectRoot, providerId, activeExecution.sessionId, () => {
        finishRun(projectRoot, providerId, 'aborted')
      })
      activeExecution.runChangeCapture?.finish()
      return true
    }
    if (finalStatus === 'error') {
      withStateUpdateTarget(projectRoot, providerId, activeExecution.sessionId, () => {
        finishWithError(
          projectRoot,
          providerId,
          readStandaloneFinalAgentError(result.output) ?? t('workbench.chatExecutionFailed')
        )
      })
      activeExecution.runChangeCapture?.finish()
      return true
    }
    withStateUpdateTarget(projectRoot, providerId, activeExecution.sessionId, () => {
      finishCompletedRun(
        projectRoot,
        providerId,
        readStandaloneFinalAgentText(result.output),
        t('workbench.chatNoTextResponse')
      )
    })
    activeExecution.runChangeCapture?.finish()
    return true
  }

  const lastMessage = chat.messages.at(-1)
  const activeAssistantMessage = isActiveChatRun(chat.status) && lastMessage?.role === 'assistant'
    ? lastMessage
    : null
  const starterSuggestions = useMemo(
    () => [
      {
        id: 'overview-project',
        title: t('workbench.chatStarterOverviewTitle'),
        prompt: t('workbench.chatStarterOverviewPrompt'),
      },
      {
        id: 'explain-current-file',
        title: t('workbench.chatStarterExplainTitle'),
        prompt: currentFilePath
          ? t('workbench.chatStarterExplainFilePrompt', { path: resolveCurrentFileLabel(currentFilePath) })
          : t('workbench.chatStarterExplainProjectPrompt'),
      },
      {
        id: 'review-project',
        title: t('workbench.chatStarterReviewTitle'),
        prompt: t('workbench.chatStarterReviewPrompt'),
      },
    ],
    [currentFilePath, t]
  )
  const pricingCatalog = useStandaloneModelPricing()
  const billingProvider = providerId === 'workbench' ? modelConfig.provider.trim() : ''
  const billingModelId = providerId === 'workbench' ? modelConfig.model.trim() : ''
  const billingModel = useMemo(
    () =>
      billingProvider && billingModelId
        ? { provider: billingProvider, model: billingModelId }
        : null,
    [billingModelId, billingProvider]
  )
  const conversation = useMemo<ConversationView>(() => {
    // 状态行上「现在在做什么」：思考阶段名或正在跑的工具（Desktop 由执行轨迹算同一格）。
    const liveActivity = readStandaloneLiveActivity(
      activeAssistantMessage,
      locale,
      (path) =>
        formatWorkbenchChatPathForDisplay(
          resolveWorkbenchChatAbsolutePath(path, projectRoot),
          projectRoot
        ),
      conversationTranslator
    )
    return {
      sessionId: chat.sessionId,
      activeMemberSessionId: chat.sessionId,
      supportsProjectFiles: true,
      messages: [...chat.messages] as ConversationView['messages'],
      messageRunMarkers: [...chat.messageRunMarkers],
      workerThreads: [...chat.workerThreads.threads],
      runtime: {
        status: chat.status,
        teamPhase: chat.teamPhase,
        activeTurn: chat.activeTurn,
        completedTurns: chat.completedTurns,
        lastError: chat.lastError,
        connectionRetryAttempt: chat.connectionRetryAttempt,
        connectionRetryMaxAttempts: chat.connectionRetryMaxAttempts,
        lastRunStartedAt: chat.lastRunStartedAt,
        awaitingConfirmationMessage: chat.awaitingConfirmationMessage,
        awaitingInputQuestion: chat.awaitingInputQuestion,
        conversationCards: [],
        stickyDockItems: [],
        awaitingConfirmationUserActionCards: [],
        awaitingConfirmationExecutionId: chat.awaitingConfirmationMessage
          ? findActiveExecution(projectRoot, providerId, chat.sessionId)?.executionId ?? null
          : null,
        awaitingConfirmationDetail: chat.awaitingConfirmationDetail,
        lastRunFinishedAt: chat.lastRunFinishedAt,
        usageTelemetry: [],
      },
      isStreaming: isActiveChatRun(chat.status),
      streamingAssistantMessageId: activeAssistantMessage?.id,
      hasStreamingThinkingBlock: liveActivity.hasStreamingThinkingBlock,
      liveTraceSummary: liveActivity.liveTraceSummary,
      runningLabel: t('chat.running'),
      activeProjectRoot: projectRoot,
      workspaceSourceRoot: projectRoot,
      // 回答末尾的约价：按当前选的模型与公开价格目录估算（与 Desktop 相同）；外部引擎自管计费，不估。
      billingModel,
      pricingCatalog,
    }
  },
    [
      activeAssistantMessage,
      conversationTranslator,
      locale,
      billingModel,
      pricingCatalog,
      chat.lastRunFinishedAt,
      chat.lastRunStartedAt,
      chat.awaitingInputQuestion,
      chat.awaitingConfirmationDetail,
      chat.awaitingConfirmationMessage,
      chat.activeTurn,
      chat.completedTurns,
      chat.connectionRetryAttempt,
      chat.connectionRetryMaxAttempts,
      chat.lastError,
      chat.messageRunMarkers,
      chat.messages,
      chat.sessionId,
      chat.status,
      chat.teamPhase,
      chat.workerThreads,
      projectRoot,
      t,
    ]
  )
  const composerControl = useMemo<ChatComposerControl>(
    () => ({
      scopeKey: chat.sessionId,
      input: {
        input: {
          value: prompt,
          placeholder: resolveWorkbenchChatComposerPlaceholder(includedCurrentFilePath, t),
          disabled:
            !canSteerRun
            && shouldBlockStandaloneRunSubmission(
              chat.status,
              hasPendingAgentExecution,
              accountSignInPending
            ),
          onValueChange: setPrompt,
          onSend: (draft) => sendComposerDraft(draft),
        },
        attachments: {
          files,
          onFilesChange: setFiles,
          onOpenFile: openAttachedFile,
        },
        // 排队与引导只对原生执行栈开放：外部引擎没有中途注入语义。
        ...(providerId === 'workbench'
          ? {
              queue: {
                canEnqueue: canSteerRun,
                canGuideCurrentTask: true,
                isPaused: queuedDrafts.isPaused,
                errorMessage: queuedDrafts.errorMessage,
                onResume: queuedDrafts.resume,
                queuedDrafts: queuedDrafts.drafts,
                drainingId: queuedDrafts.drainingId,
                isQueueDraining: queuedDrafts.isDraining,
                onQueuedDraftMove: queuedDrafts.move,
                onQueuedDraftRemove: queuedDrafts.remove,
                onQueuedDraftUpdate: queuedDrafts.update,
                onQueuedDraftGuide: canSteerRun
                  ? async (id: string) => {
                      // 引导通道只带文字：带附件的排队项留在队里，本轮结束后照常发送。
                      if (queuedDrafts.drafts.find((entry) => entry.id === id)?.files.length) {
                        workbenchMessage.warning({
                          title: t('workbench.chatGuidanceFilesTitle'),
                          description: t('workbench.chatGuidanceFilesDescription'),
                        })
                        return
                      }
                      const draft = queuedDrafts.take(id)
                      if (draft) await sendRunGuidance(draft.value)
                    }
                  : undefined,
                onQueuedDraftReturnToInput: (id: string) => {
                  const draft = queuedDrafts.take(id)
                  if (!draft) return
                  setPrompt(draft.value)
                  setFiles(draft.files)
                },
                onQueuedDraftRunNow: queuedDrafts.runNow,
              },
            }
          : {}),
        execution: {
          goalMode,
          onGoalModeChange: setGoalMode,
          planMode,
          onPlanModeChange: setPlanMode,
        },
        // 运行模式与思考力度只对原生执行栈有意义：外部引擎自带运行档与推理档，
        // 由引擎自己的模型选择决定，这里整格不注入而不是给一个点了没反应的开关。
        ...(providerId === 'workbench'
          ? {
              runProfile: {
                value: runProfile,
                disabled: isActiveChatRun(chat.status),
                onChange: (value: RunProfileSelectionId) => {
                  setRunProfile(value)
                  storeRunProfile(value)
                },
              },
              thinkingDepth: {
                value: reasoningLevel,
                disabled: isActiveChatRun(chat.status),
                onChange: (value: ReasoningLevel) => {
                  setReasoningLevel(value)
                  storeReasoningLevel(value)
                },
              },
            }
          : {}),
        thinkingVisibility: {
          value: showThinkingProcess,
          onChange: setShowThinkingProcess,
        },
        features: {
          workbenchCurrentFilePath: includedCurrentFilePath ?? undefined,
          onDismissWorkbenchCurrentFile: () => setIncludedCurrentFilePath(null),
          browserElementSelections: browserSelections,
          onRemoveBrowserElementSelection: (id: string) =>
            setBrowserSelections((current) => current.filter((selection) => selection.id !== id)),
        },
        streaming: {
          isStreaming: isActiveChatRun(chat.status),
          canStop: true,
          onStop: stop,
        },
      },
      modelSelector: providerId === 'workbench'
        && (
          !isStandaloneWorkbenchManagedProviderId(modelConfig.provider)
          || selectedManagedProvider?.enabled
        )
        ? {
            label: t('chat.composerModelSection'),
            provider: modelConfig.provider,
            model: modelConfig.model,
            providers: createStandaloneWorkbenchConfiguredModelSelectorProviders(
              modelConfig.provider,
              modelConfig.model,
              selectedManagedProvider
            ),
            onChange: (provider, model) =>
              selectStandaloneWorkbenchAgentModel(provider, model),
          }
        : engineCatalog?.available && engineCatalog.models.length > 0
          ? {
              label: t('chat.composerModelSection'),
              hint: providerId === 'claude-code'
                ? t('workbench.chatEngineCatalogClaude')
                : t('workbench.chatEngineCatalogCodex'),
              provider: providerId,
              model: engineModel,
              providers: [{
                value: providerId,
                label: providerId === 'claude-code' ? 'Claude Code' : 'ChatGPT / Codex',
                defaultModel: engineCatalog.models.find((model) => model.isDefault)?.value
                  ?? engineCatalog.models[0]!.value,
                models: engineCatalog.models.map((model) => ({
                  value: model.value,
                  label: model.label,
                  ...(model.description ? { description: model.description } : {}),
                })),
              }],
              onChange: (_provider, model) => {
                setEngineModel(model)
                storeEngineModel(providerId, model)
              },
            }
          : undefined,
      // 上下文用量仪表只对原生执行栈有意义：外部引擎自管上下文与压缩，Velar 侧的转录不是
      // 它真正送核的那一份，挂一个恒 0% 的表比不挂更误导。
      ...(providerId === 'workbench'
        ? {
            slots: {
              contextUsageIndicator: (
                <WorkbenchContextUsageIndicator usage={chat.contextUsage} />
              ),
            },
          }
        : {}),
      ...(providerId !== 'workbench' && (!engineCatalog || !engineCatalog.available)
        ? {
            modelRunSummary: {
              primaryLabel: providerId === 'claude-code' ? 'Claude Code' : 'ChatGPT / Codex',
              secondaryLabel: engineCatalog?.reason ?? t('workbench.chatEngineLoadingModels'),
            },
          }
        : {}),
    }),
    [
      chat.sessionId,
      chat.status,
      // 每轮送核前到达一次；漏了它，仪表要等这一轮收尾、status 变了才跟着刷新。
      chat.contextUsage,
      accountSignInPending,
      browserSelections,
      files,
      goalMode,
      hasPendingAgentExecution,
      includedCurrentFilePath,
      queuedDrafts.drafts,
      queuedDrafts.drainingId,
      queuedDrafts.errorMessage,
      queuedDrafts.isPaused,
      reasoningLevel,
      runProfile,
      engineCatalog,
      engineModel,
      modelConfig.model,
      modelConfig.provider,
      selectedManagedProvider,
      onOpenWorkspacePath,
      planMode,
      prompt,
      providerId,
      showThinkingProcess,
      t,
    ]
  )

  // 「本轮改动」卡按消息查摘要：走 context，不受共享气泡 memo 的比较字段限制。
  const runChangesScope = useMemo<WorkbenchRunChangesScope>(
    () => ({
      projectRoot,
      sessionId: chat.sessionId,
      summaries: new Map(
        chat.messageRunMarkers.flatMap((marker) =>
          marker.runChanges ? [[marker.messageId, marker.runChanges] as const] : []
        )
      ),
      ...(onReviewRunChanges ? { onReviewRound: onReviewRunChanges } : {}),
    }),
    [chat.messageRunMarkers, chat.sessionId, onReviewRunChanges, projectRoot]
  )

  // 回溯入口传进每一条用户消息（消息气泡按引用判等）。两者都在点击时才读最新会话，
  // 引用固定下来不会读到旧数据；不固定的话，每个 token 都会让整段对话重画一遍。
  const stableRewindToMessage = useMemoizedFn(rewindToMessage)
  const stableRewindPlan = useMemoizedFn(buildRewindPlanForMessage)

  // 子 Agent 卡片里嵌的时间线与会话落到同一组宿主入口。
  const workerThreadScope = useMemo<WorkbenchWorkerThreadScope>(
    () => ({
      projectRoot,
      onOpenProjectPath: onOpenWorkspacePath,
      onOpenFileChange,
      onReviewFileChanges,
    }),
    [onOpenFileChange, onOpenWorkspacePath, onReviewFileChanges, projectRoot]
  )

  return (
    <ChatThinkingVisibilityProvider visible={showThinkingProcess}>
      <WorkbenchRunChangesScopeContext.Provider value={runChangesScope}>
        <WorkbenchWorkerThreadScopeContext.Provider value={workerThreadScope}>
          <ChatConversationPane
            conversation={conversation}
            conversationRefreshKey={conversationRefreshKey}
            composer={<ChatSurfaceComposer control={composerControl} variant="side" />}
            followLocked={followLocked}
            scrollRef={scrollRef}
            scrollNavigatorHidden={scrollNavigatorHidden}
            streamSlot={chat.messages.length === 0 ? (
              <div className={styles.workbenchChatEmptyState} data-workbench-chat-empty="true">
                <div className={styles.workbenchChatEmptyContent}>
                  <img
                    className={styles.workbenchChatEmptyIcon}
                    src={workbenchAppIconUrl}
                    alt=""
                    aria-hidden="true"
                  />
                  <div
                    className={styles.workbenchChatStarterList}
                    aria-label={t('workbench.chatStarterSuggestions')}
                  >
                    {starterSuggestions.map((suggestion) => (
                      <button
                        key={suggestion.id}
                        type="button"
                        className={styles.workbenchChatStarterButton}
                        onClick={() => {
                          setPrompt(suggestion.prompt)
                          void submit(suggestion.prompt)
                        }}
                      >
                        <span className={styles.workbenchChatStarterCopy}>
                          <span className={styles.workbenchChatStarterTitle}>{suggestion.title}</span>
                          <span className={styles.workbenchChatStarterPrompt}>{suggestion.prompt}</span>
                        </span>
                        <ArrowRightIcon className={styles.workbenchChatStarterArrow} size={13} />
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            ) : undefined}
            variant="side"
            onSubmitInput={async (answer) => {
              const accepted = await window.velarosWorkbenchKernel.resolveAgentInput({
                sessionId: chat.sessionId,
                answer,
              })
              if (!accepted) return
              updateState(projectRoot, providerId, (state) => ({
                ...state,
                status: 'running',
                teamPhase: 'creating-task',
                activeTurn: null,
                lastError: null,
                connectionRetryAttempt: null,
                connectionRetryMaxAttempts: null,
                awaitingInputQuestion: null,
                awaitingConfirmationMessage: null,
                awaitingConfirmationDetail: null,
                revision: state.revision + 1,
              }))
            }}
            onResolveConfirmation={async (approved, rejectionMessage) => {
              const accepted = await window.velarosWorkbenchKernel.resolveAgentConfirmation({
                sessionId: chat.sessionId,
                approved,
                ...(rejectionMessage?.trim() ? { rejectionMessage } : {}),
              })
              if (!accepted) return
              updateState(projectRoot, providerId, (state) => ({
                ...state,
                status: 'running',
                teamPhase: 'executing',
                activeTurn: null,
                lastError: null,
                connectionRetryAttempt: null,
                connectionRetryMaxAttempts: null,
                awaitingInputQuestion: null,
                awaitingConfirmationMessage: null,
                awaitingConfirmationDetail: null,
                revision: state.revision + 1,
              }))
            }}
            // 回溯只对原生执行栈：外部引擎的会话历史在它自己手里，截断这边的对话改不了它记住的内容。
            {...(providerId === 'workbench'
              ? { onRewindToMessage: stableRewindToMessage, getRewindPlan: stableRewindPlan }
              : {})}
            // 回答里的项目路径、文件改动卡与「查看改动」都落到宿主编辑器（与 Desktop 同一组入口）。
            onOpenProjectPath={onOpenWorkspacePath}
            onOpenFileChange={onOpenFileChange}
            onReviewFileChanges={onReviewFileChanges}
            // 目标卡的「继续」在空闲时另起一轮（运行中则经动作端口投引导）。
            onContinueGoal={(guidance) => submit(guidance, [], { goalMode: true })}
            onFollowLockedChange={setFollowLocked}
          />
        </WorkbenchWorkerThreadScopeContext.Provider>
      </WorkbenchRunChangesScopeContext.Provider>
    </ChatThinkingVisibilityProvider>
  )
}

function findActiveExecution(
  projectRoot: string,
  providerId: WorkbenchChatProviderId,
  sessionId?: string
): ActiveAgentExecution | null {
  for (const execution of activeAgentExecutions.values()) {
    if (
      execution.projectRoot === projectRoot
      && execution.providerId === providerId
      && (!sessionId || execution.sessionId === sessionId)
    ) return execution
  }
  return null
}

function readStandaloneChatTitle(state: StandaloneChatState): string {
  const firstUserMessage = state.messages.find((message) => message.role === 'user')
  const title = firstUserMessage?.blocks
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join(' ')
    .trim()
  if (!title) return ''
  return title.length > 36 ? `${title.slice(0, 36)}…` : title
}

function appendAssistantText(
  projectRoot: string,
  providerId: WorkbenchChatProviderId,
  text: string
): void {
  updateAssistantBlocks(projectRoot, providerId, (blocks) => {
    const last = blocks.at(-1)
    if (last?.type !== 'text') return [...blocks, { type: 'text', text }]
    return [...blocks.slice(0, -1), { ...last, text: last.text + text }]
  })
}

/** 起搏器吐出的一段正文，落到这一轮所在的会话上。 */
function applyPacedStreamText(executionId: string, text: string): void {
  const execution = activeAgentExecutions.get(executionId)
  if (!execution) return
  withStateUpdateTarget(execution.projectRoot, execution.providerId, execution.sessionId, () => {
    appendAssistantText(execution.projectRoot, execution.providerId, text)
  })
}

/** 起搏器放行的一条事件：改会话状态，遇到终态就了结这一轮执行。 */
function applyPacedStreamEvent(executionId: string, event: StandalonePacedStreamEvent): void {
  const execution = activeAgentExecutions.get(executionId)
  if (!execution) return
  const { projectRoot, providerId } = execution
  withStateUpdateTarget(projectRoot, providerId, execution.sessionId, () => {
    if (event.kind === 'reasoning') {
      appendAssistantReasoning(projectRoot, providerId, event.id, event.text)
      return
    }
    const record: AgentExecutionEnvelope = { channel: event.channel, payload: event.payload }
    applyAgentStreamEvent(projectRoot, providerId, record)
    const terminalKind = applyAgentRuntimeEvent(projectRoot, providerId, record)
    if (!terminalKind) return
    execution.settleTerminal(terminalKind)
    if (terminalKind !== 'done') activeAgentExecutions.delete(executionId)
  })
}

/**
 * main 那边这一轮已经跑完（agent.execute 已返回），起搏器可能还在逐帧吐正文、挂着收尾：等它吐完
 * 再收尾——否则后面的正文会落在一个已了结的执行上被丢掉。积压总会按速率吐完，超过兜底上限
 * （收尾事件丢失、积压极大）就一次性排空。
 */
async function settleStreamPacing(executionId: string): Promise<void> {
  const deadline = Date.now() + StreamPacingSettleLimitMs
  while (standaloneStreamPacer.hasPendingOutput(executionId) && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 50))
  standaloneStreamPacer.drain(executionId)
}

/** 窗口隐藏或关闭前：所有进行中的一轮立刻排空积压（后台动画帧不走，关闭前要落盘完整回答）。 */
function drainStreamPacing(): void {
  for (const executionId of activeAgentExecutions.keys()) standaloneStreamPacer.drain(executionId)
}

function appendAssistantReasoning(
  projectRoot: string,
  providerId: WorkbenchChatProviderId,
  streamId: string,
  text: string
): void {
  // 紧挨着的最后一块是思考才续写，否则另起一块（与 Desktop、子 Agent 线程同一规则）。不能按 id 往回找：
  // 一轮里各步骤的思考流 id 会重复（Anthropic 每次响应都是 "0"），会把后一步的思考拼进工具卡上面那块。
  updateAssistantBlocks(projectRoot, providerId, (blocks) => {
    const last = blocks.at(-1)
    if (last?.type !== 'thinking') return [...blocks, { type: 'thinking', streamId, text }]
    return [...blocks.slice(0, -1), { ...last, text: last.text + text }]
  })
}

function applyAgentStreamEvent(
  projectRoot: string,
  providerId: WorkbenchChatProviderId,
  record: AgentExecutionEnvelope
): void {
  if (record.channel !== 'agent') return
  const event = readAgentEventPayload(record)
  if (!event) return
  if (event.type === 'worker-thread') {
    updateState(projectRoot, providerId, (state) => {
      const workerThreads = applyStandaloneWorkerThreadEvent(state.workerThreads, event.payload)
      return workerThreads === state.workerThreads
        ? state
        : { ...state, workerThreads, revision: state.revision + 1 }
    })
    return
  }
  if (event.type === 'text-delta' && typeof event.text === 'string') {
    appendAssistantText(projectRoot, providerId, event.text)
    return
  }
  if (event.type === 'reasoning-delta' && typeof event.text === 'string') {
    appendAssistantReasoning(
      projectRoot,
      providerId,
      typeof event.id === 'string' ? event.id : 'reasoning',
      event.text
    )
    return
  }
  if (
    event.type === 'tool-start'
    && typeof event.toolCallId === 'string'
    && typeof event.toolName === 'string'
  ) {
    const toolCallId = event.toolCallId
    const toolName = event.toolName
    updateAssistantBlocks(projectRoot, providerId, (blocks) => [
      ...blocks.filter(
        (block) => block.type !== 'tool-call' || block.toolCallId !== toolCallId
      ),
      {
        type: 'tool-call',
        toolCallId,
        toolName,
        args: asRecord(event.args),
        categoryId: typeof event.categoryId === 'string' ? event.categoryId : undefined,
        isRunning: true,
        startedAt: Date.now(),
      },
    ])
    return
  }
  if (event.type === 'tool-progress' && typeof event.toolCallId === 'string') {
    updateToolCallBlock(projectRoot, providerId, event.toolCallId, (block) => ({
      ...block,
      progress: `${block.progress ?? ''}${typeof event.chunk === 'string' ? event.chunk : ''}`,
    }))
    return
  }
  if (event.type === 'tool-metadata' && typeof event.toolCallId === 'string') {
    updateToolCallBlock(projectRoot, providerId, event.toolCallId, (block) => ({
      ...block,
      ...(typeof event.title === 'string' ? { title: event.title } : {}),
      metadata: { ...block.metadata, ...asRecord(event.metadata) },
    }))
    return
  }
  if (event.type === 'tool-done' && typeof event.toolCallId === 'string') {
    updateToolCallBlock(projectRoot, providerId, event.toolCallId, (block) => ({
      ...block,
      result: event.result,
      ...(typeof event.error === 'string' ? { error: event.error } : {}),
      isRunning: false,
      finishedAt: Date.now(),
      effects: asRecord(event.effects) as ToolCallBlock['effects'],
    }))
  }
}

function applyAgentRuntimeEvent(
  projectRoot: string,
  providerId: WorkbenchChatProviderId,
  record: AgentExecutionEnvelope
): StandaloneAgentTerminalKind | null {
  const runtime = readAgentRuntimePayload(record)
  if (!runtime) return null
  const contextUsage = readStandaloneContextUsageEstimate(runtime)
  if (contextUsage) {
    updateState(projectRoot, providerId, (state) => ({
      ...state,
      contextUsage,
      revision: state.revision + 1,
    }))
    return null
  }
  const appliedInputId = readAppliedGuidanceInputId(runtime)
  if (appliedInputId) {
    updateState(projectRoot, providerId, (state) => {
      const index = state.messages.findIndex((message) => message.id === appliedInputId)
      if (index < 0 || state.messages[index].guidanceStatus === 'applied') return state
      return {
        ...state,
        messages: state.messages.map((message, messageIndex) =>
          messageIndex === index ? { ...message, guidanceStatus: 'applied' } : message
        ),
        revision: state.revision + 1,
      }
    })
    return null
  }
  if (!isStandaloneAgentRuntimeEvent(runtime)) return null
  const terminalKind = readStandaloneAgentTerminalKind(runtime)
  updateState(projectRoot, providerId, (state) => {
    const base = terminalKind
      ? { ...state, messages: settleTerminalMessages(state.messages) }
      : state
    const next = applyStandaloneAgentRuntimeEvent(base, runtime)
    if (next === state) return state
    return { ...(terminalKind ? withRunMarker(next) : next), revision: state.revision + 1 }
  })
  // 一轮收尾时回答已经完整：立刻落盘，不等合并窗口。
  if (terminalKind) flushChatPersistence()
  return terminalKind
}

/** 主 Agent 读到一条运行中引导时，执行栈回的 `input-applied` 事件里带着那条引导消息的 id。 */
function readAppliedGuidanceInputId(runtime: Record<string, unknown>): string | null {
  return runtime.kind === 'input-applied' && typeof runtime.inputId === 'string'
    ? runtime.inputId
    : null
}

function updateToolCallBlock(
  projectRoot: string,
  providerId: WorkbenchChatProviderId,
  toolCallId: string,
  updater: (block: ToolCallBlock) => ToolCallBlock
): void {
  updateAssistantBlocks(projectRoot, providerId, (blocks) =>
    blocks.map((block) =>
      block.type === 'tool-call' && block.toolCallId === toolCallId ? updater(block) : block
    )
  )
}

function updateAssistantBlocks(
  projectRoot: string,
  providerId: WorkbenchChatProviderId,
  updater: (blocks: ContentBlock[]) => ContentBlock[]
): void {
  updateState(projectRoot, providerId, (state) => {
    const last = state.messages.at(-1)
    const assistant = last?.role === 'assistant'
      ? last
      : { ...createTextMessage('assistant', ''), blocks: [] }
    const nextAssistant = { ...assistant, blocks: updater([...assistant.blocks]) }
    return {
      ...state,
      messages: last?.role === 'assistant'
        ? [...state.messages.slice(0, -1), nextAssistant]
        : [...state.messages, nextAssistant],
      revision: state.revision + 1,
    }
  })
}

function finishWithError(
  projectRoot: string,
  providerId: WorkbenchChatProviderId,
  message: string
): void {
  updateState(projectRoot, providerId, (state) => ({
    ...withRunMarker(applyStandaloneAgentRuntimeEvent(
      { ...state, messages: settleTerminalMessages(state.messages) },
      { kind: 'error', message }
    )),
    revision: state.revision + 1,
  }))
}

/** 一轮收尾时的消息整理：去掉模型不可见的占位文本，并暂停没被读走的运行中引导。 */
function settleTerminalMessages(messages: readonly ChatMessage[]): ChatMessage[] {
  return pauseUnappliedRunGuidance(sanitizeStandaloneChatMessages(messages))
}

/** 一轮收尾后的状态：给这一轮最后一条助手消息记运行标记（与 Desktop 同一规则）。 */
function withRunMarker(state: StandaloneChatState): StandaloneChatState {
  const messageRunMarkers = markStandaloneRun({
    messages: state.messages,
    markers: state.messageRunMarkers,
    status: state.status,
    lastError: state.lastError,
    completedTurns: state.completedTurns,
    lastRunStartedAt: state.lastRunStartedAt,
    lastRunFinishedAt: state.lastRunFinishedAt,
  })
  return messageRunMarkers === state.messageRunMarkers ? state : { ...state, messageRunMarkers }
}

function finishCompletedRun(
  projectRoot: string,
  providerId: WorkbenchChatProviderId,
  finalText: string | null,
  noTextError: string
): void {
  updateState(projectRoot, providerId, (state) => {
    let messages: readonly ChatMessage[] = settleTerminalMessages(state.messages)
    if (!hasStandaloneVisibleAssistantReply(messages) && finalText) {
      const last = messages.at(-1)
      messages = last?.role === 'assistant'
        ? [
            ...messages.slice(0, -1),
            { ...last, blocks: [...last.blocks, { type: 'text', text: finalText }] },
          ]
        : [...messages, createTextMessage('assistant', finalText)]
    }
    const completed = applyStandaloneCompletedRunResult(
      { ...state, messages },
      messages,
      noTextError
    )
    return { ...withRunMarker(completed), revision: state.revision + 1 }
  })
}

function createTextMessage(role: ChatMessage['role'], text: string): ChatMessage {
  return {
    id: nextId(`workbench-${role}`),
    role,
    blocks: [{ type: 'text', text }],
    timestamp: Date.now(),
  }
}

/**
 * 用户消息上随发的拾取元素。字段属于共享会话视图的消息形状（气泡据此显示 chip），Agent 协议的
 * ChatMessage 不声明它；读取时按数组校验，持久化恢复回来的旧数据形状不对就当没有。
 */
function readMessageBrowserSelections(message: ChatMessage): readonly BrowserElementSelection[] {
  const selections = (message as { browserElementSelections?: unknown }).browserElementSelections
  return Array.isArray(selections) ? (selections as BrowserElementSelection[]) : []
}

function readAgentRuntimePayload(
  record: AgentExecutionEnvelope
): Record<string, unknown> | null {
  const event = readAgentEventPayload(record)
  if (!event) return null
  return event.type === 'runtime' ? asRecord(event.payload) : event
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function readAgentEventPayload(
  record: AgentExecutionEnvelope
): Record<string, unknown> | null {
  return typeof record.payload === 'object'
    && record.payload !== null
    && !Array.isArray(record.payload)
    ? record.payload as Record<string, unknown>
    : null
}

function finishRun(
  projectRoot: string,
  providerId: WorkbenchChatProviderId,
  status: Extract<StandaloneChatState['status'], 'completed' | 'aborted'>
): void {
  updateState(projectRoot, providerId, (state) => ({
    ...withRunMarker(applyStandaloneAgentRuntimeEvent(
      { ...state, messages: settleTerminalMessages(state.messages) },
      status === 'completed'
        ? { kind: 'done' }
        : { kind: 'aborted', message: '' }
    )),
    revision: state.revision + 1,
  }))
}

function isActiveChatRun(status: StandaloneChatState['status']): boolean {
  return status === 'running'
    || status === 'stopping'
    || status === 'awaiting-input'
    || status === 'awaiting-confirmation'
}

/** 上一轮是被打断的（用户停止或执行失败），而不是正常完成。 */
function isInterruptedRunStatus(
  status: StandaloneChatState['status']
): status is 'aborted' | 'failed' {
  return status === 'aborted' || status === 'failed'
}

async function buildAttachmentContext(files: readonly File[]): Promise<string> {
  const descriptions = await Promise.all(files.map(async (file) => {
    const path = resolveWorkbenchClipboardFilePath(
      file,
      window.velarosWorkbenchProjectHub.getPathForFile
    )
    if (path) return `Attached file: ${path}`
    if (file.size <= 64 * 1_024 && isTextAttachment(file)) return `Attached file ${file.name}:\n\`\`\`\n${await file.text()}\n\`\`\``
    return `Attached file: ${file.name} (${file.type || 'application/octet-stream'}, ${file.size} bytes)`
  }))
  return descriptions.join('\n\n')
}

function isTextAttachment(file: File): boolean {
  return file.type.startsWith('text/')
    || /\.(?:c|cc|cpp|css|csv|go|h|html|java|js|json|jsx|md|py|rs|sql|toml|ts|tsx|txt|vel|xml|ya?ml)$/iu.test(file.name)
}

/**
 * 运行模式 / 思考力度的本地档位。
 *
 * 与 Desktop 的语义一致但存储更轻：Workbench 没有会话级 composer draft 账本，档位按**产品**
 * 记忆（跨会话保留），这样换项目、换会话不会把用户刚调好的档悄悄打回默认。
 */
const WorkbenchRunProfiles = new Set<RunProfileSelectionId>([
  'auto',
  'compact',
  'balanced',
  'expanded',
])
const WorkbenchReasoningLevels = new Set<ReasoningLevel>([
  'off',
  'low',
  'medium',
  'high',
  'ultra',
])
const DefaultWorkbenchRunProfile: RunProfileSelectionId = 'auto'
const DefaultWorkbenchReasoningLevel: ReasoningLevel = 'medium'

function readStoredRunProfile(): RunProfileSelectionId {
  if (typeof window === 'undefined') return DefaultWorkbenchRunProfile
  const stored = window.localStorage.getItem('velaros.workbench.run-profile')
  return stored && WorkbenchRunProfiles.has(stored as RunProfileSelectionId)
    ? stored as RunProfileSelectionId
    : DefaultWorkbenchRunProfile
}

function storeRunProfile(runProfile: RunProfileSelectionId): void {
  if (typeof window === 'undefined') return
  window.localStorage.setItem('velaros.workbench.run-profile', runProfile)
}

function readStoredReasoningLevel(): ReasoningLevel {
  if (typeof window === 'undefined') return DefaultWorkbenchReasoningLevel
  const stored = window.localStorage.getItem('velaros.workbench.thinking-depth')
  return stored && WorkbenchReasoningLevels.has(stored as ReasoningLevel)
    ? stored as ReasoningLevel
    : DefaultWorkbenchReasoningLevel
}

function storeReasoningLevel(level: ReasoningLevel): void {
  if (typeof window === 'undefined') return
  window.localStorage.setItem('velaros.workbench.thinking-depth', level)
}

function readStoredEngineModel(providerId: WorkbenchChatProviderId): string {
  if (providerId === 'workbench' || typeof window === 'undefined') return ''
  return window.localStorage.getItem(`velaros.workbench.engine-model:${providerId}`) ?? ''
}

function storeEngineModel(providerId: WorkbenchChatProviderId, model: string): void {
  if (providerId === 'workbench' || typeof window === 'undefined') return
  window.localStorage.setItem(`velaros.workbench.engine-model:${providerId}`, model)
}

function chatStorageKey(projectRoot: string, providerId: WorkbenchChatProviderId): string {
  return `velaros.workbench.chat:${providerId}:${encodeURIComponent(projectRoot)}`
}

function legacyChatStorageKey(projectRoot: string): string {
  return `velaros.workbench.chat:${encodeURIComponent(projectRoot)}`
}

/** 已就「历史存不下」提示过的项目根；同一次运行只打扰用户一次。 */
const persistFailureNotified = new Set<string>()

/**
 * 落盘会话状态。
 *
 * ## 为什么不能再吞异常
 *
 * 这里是**会话权威本身**，不是缓存——localStorage 撞配额或被清理时，写失败等于用户的聊天
 * 历史永久丢失。旧实现把异常整个吞掉、只留一句「不能打断 Kernel run」的注释，结果是静默丢
 * 数据：用户不知道没保存，也没有日志可查。现在改成**不中断执行、但必须让人知道**，
 * 同时把同一份镜像到主进程磁盘兜底。
 *
 * > 会话权威搬进主进程、renderer 退回投影才是正解，但那是结构改动（见 Desktop 仓
 * > `docs/workbench-alignment-audit-2026-08.md`）。本函数是那之前的遏制层。
 */
/**
 * 聊天历史落盘是**合并写**。
 *
 * 流式输出时每个 token 都改一次状态。以前每改一次就把这个项目的全部会话序列化（带着完整工具结果，
 * 常见几百 KB 到上 MB）、同步写进 localStorage、再经 IPC 写一份磁盘备份——按 token 频率重复，
 * 渲染进程、存储进程、主进程和磁盘一起空转，界面发卡、风扇常转。
 *
 * 现在状态变了只记下「这个项目要写」，一个窗口期内同一项目只写一次；写之前与上次写入比落盘字段，
 * 一个都没变（子 Agent 线程、上下文用量、运行阶段这类只在内存里的更新）就不写。一轮结束与新建、
 * 切换、归档会话这些结构性变化立刻写；窗口隐藏或关闭前把没写的补上。
 */
const ChatPersistCoalesceMs = 1_000

const chatPersistence = createCoalescedChatPersistence<{
  readonly projectRoot: string
  readonly providerId: WorkbenchChatProviderId
}>({
  delayMs: ChatPersistCoalesceMs,
  readSignature: ({ projectRoot, providerId }) => [
    getState(projectRoot, providerId).sessionId,
    ...readAllStates(projectRoot, providerId).flatMap(readPersistedFieldIdentities),
  ],
  write: (_key, { projectRoot, providerId }) => writePersistedChatHistory(projectRoot, providerId),
})

function persistState(state: StandaloneChatState, options?: { immediate?: boolean }): void {
  if (!state.projectRoot || typeof window === 'undefined') return
  chatPersistence.schedule(
    stateKey(state.projectRoot, state.providerId),
    { projectRoot: state.projectRoot, providerId: state.providerId },
    options
  )
}

function flushChatPersistence(): void {
  chatPersistence.flush()
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  // 退出、刷新、切到后台前：起搏器里没吐完的正文先落地（后台动画帧不走），再补写历史
  // （localStorage 是同步写，来得及）。
  const settleBeforeLeaving = (): void => {
    drainStreamPacing()
    flushChatPersistence()
  }
  window.addEventListener('pagehide', settleBeforeLeaving)
  window.addEventListener('beforeunload', settleBeforeLeaving)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') settleBeforeLeaving()
  })
}

function writePersistedChatHistory(projectRoot: string, providerId: WorkbenchChatProviderId): void {
  const key = stateKey(projectRoot, providerId)
  const activeSessionId = getState(projectRoot, providerId).sessionId
  const sessions = readAllStates(projectRoot, providerId)
  const payload = JSON.stringify({
    version: 2,
    activeSessionId,
    sessions: sessions.map(serializeStoredState),
  })

  try {
    window.localStorage.setItem(chatStorageKey(projectRoot, providerId), payload)
    persistFailureNotified.delete(key)
  } catch (error) {
    // 不中断正在跑的 Kernel run,但绝不静默:日志 + 用户可见提示(每个项目根只提示一次)。
    log.error('聊天历史写入 localStorage 失败', {
      projectRoot,
      messageCount: sessions.reduce((count, session) => count + session.messages.length, 0),
      error,
    })
    if (!persistFailureNotified.has(key)) {
      persistFailureNotified.add(key)
      workbenchMessage.error({
        title: '聊天历史未能保存',
        description:
          '浏览器存储写入失败(可能已满)。当前对话仍可继续,但重启后可能丢失;已尝试写入本地备份。',
      })
    }
  }

  backupChatHistoryToDisk(key, payload)
}

/**
 * 落盘字段的身份：状态按不可变方式更新，字段没换引用就是没变。`revision` 不在里面——它随每次
 * 内存更新递增，只为下次启动接着计数，晚一点写不影响任何东西。
 */
function readPersistedFieldIdentities(state: StandaloneChatState): unknown[] {
  const interrupted = isInterruptedRunStatus(state.status)
  return [
    state.sessionId,
    state.folderId,
    state.messages,
    state.lastRunStartedAt,
    state.lastRunFinishedAt,
    interrupted ? state.status : null,
    interrupted ? state.lastError : null,
    state.checkpoints,
    state.messageRunMarkers,
    state.contextUsage,
  ]
}

function serializeStoredState(state: StandaloneChatState): Record<string, unknown> {
  return {
    providerId: state.providerId,
    sessionId: state.sessionId,
    folderId: state.folderId,
    messages: state.messages,
    lastRunStartedAt: state.lastRunStartedAt,
    lastRunFinishedAt: state.lastRunFinishedAt,
    ...(isInterruptedRunStatus(state.status)
      ? { status: state.status, lastError: state.lastError }
      : {}),
    checkpoints: state.checkpoints,
    messageRunMarkers: state.messageRunMarkers,
    ...(state.contextUsage ? { contextUsage: state.contextUsage } : {}),
    revision: state.revision,
  }
}

/**
 * 会话从存储里整个移除：它的检查点再没有回溯的机会、本轮改动记录也不再有人看，主进程里它的执行
 * 装配与活动上下文（目标、计划）一并释放。
 */
function releaseRemovedSession(session: StandaloneChatState): void {
  releaseCheckpointRefs(session.projectRoot, session.sessionId, session.checkpoints)
  releaseRunChangeRecords(session.projectRoot, session.sessionId)
  void window.velarosWorkbenchKernel
    .releaseAgentSession({ sessionId: session.sessionId })
    .catch(() => {
      // 释放失败只会在主进程留下一份没人用的装配与制品文件。
    })
}

/** 清掉检查点的影子 ref（回溯淘汰的「未来」检查点、超出保留上限的、被删掉的会话的）。 */
function releaseCheckpointRefs(
  projectRoot: string,
  sessionId: string,
  checkpoints: readonly StandaloneChatCheckpoint[]
): void {
  const checkpointIds = checkpoints
    .filter((checkpoint) => checkpoint.commitId)
    .map((checkpoint) => checkpoint.id)
  if (!projectRoot || checkpointIds.length === 0) return
  void window.velarosWorkbenchGit
    .deleteChatCheckpoints({ workspaceRoot: projectRoot, sessionId, checkpointIds })
    .catch(() => {
      // 清理按幂等处理：残留的私有 ref 只占少量对象，不影响任何功能。
    })
}

/**
 * 把本轮改动摘要记到指定会话的运行标记上，同一次更新里撤下这一轮运行中实时采到的那份——面板里
 * 同一轮从「进行中」直接变成已完成，中间不空一拍。null = 标记已不在或不再是已完成。
 */
function attachRunChanges(
  projectRoot: string,
  providerId: WorkbenchChatProviderId,
  sessionId: string,
  messageId: string,
  runChanges: WorkbenchChatRunChangesSummary
): ReturnType<typeof attachStandaloneRunChanges> {
  let attached: ReturnType<typeof attachStandaloneRunChanges> = null
  withStateUpdateTarget(projectRoot, providerId, sessionId, () =>
    updateState(projectRoot, providerId, (state) => {
      attached = attachStandaloneRunChanges(state.messageRunMarkers, messageId, runChanges)
      const settled = withoutLiveRunChanges(state, runChanges.recordId)
      return attached
        ? { ...settled, messageRunMarkers: attached.markers, revision: state.revision + 1 }
        : settled
    })
  )
  return attached
}

/** 撤下这一轮运行中实时采到的改动；返回它是否留下了记录文件（有改动才写）。 */
function withdrawLiveRunChanges(
  projectRoot: string,
  providerId: WorkbenchChatProviderId,
  sessionId: string,
  recordId: string
): boolean {
  let recorded = false
  withStateUpdateTarget(projectRoot, providerId, sessionId, () =>
    updateState(projectRoot, providerId, (state) => {
      recorded = state.liveRunChanges?.summary.recordId === recordId
        && state.liveRunChanges.summary.fileCount > 0
      return withoutLiveRunChanges(state, recordId)
    })
  )
  return recorded
}

function withoutLiveRunChanges(state: StandaloneChatState, recordId: string): StandaloneChatState {
  return state.liveRunChanges?.summary.recordId === recordId
    ? { ...state, liveRunChanges: null }
    : state
}

/** 运行标记上摘要指向的改动记录（本轮改动的补丁文件）。 */
function readRunChangeRecordIds(markers: readonly StandaloneRunMarker[]): string[] {
  return markers.flatMap((marker) => (marker.runChanges ? [marker.runChanges.recordId] : []))
}

/**
 * 删掉本轮改动的记录文件：回溯移除的消息、被移除的会话（不传 recordIds = 整个会话）。
 * 与检查点 ref 一样按幂等清理，残留文件不影响任何功能。
 */
function releaseRunChangeRecords(
  projectRoot: string,
  sessionId: string,
  recordIds?: readonly string[]
): void {
  if (!projectRoot || recordIds?.length === 0) return
  void window.velarosWorkbenchGit
    .deleteChatRunChanges({
      workspaceRoot: projectRoot,
      sessionId,
      ...(recordIds ? { recordIds: [...recordIds] } : {}),
    })
    .catch(() => {
      // 同上：清理失败只留下一个没人引用的记录文件。
    })
}

/**
 * 把同一份历史镜像到主进程数据区。
 *
 * localStorage 会被「清除浏览数据」或配额回收整片抹掉,那时这份磁盘副本是唯一残存物。
 * 刻意 fire-and-forget:备份失败只记日志,不弹提示、不影响聊天——它是兜底,不是主路径。
 */
function backupChatHistoryToDisk(projectRoot: string, payload: string): void {
  void window.velarosWorkbenchKernel
    .backupChatHistory({ projectRoot, payload })
    .then((result) => {
      if (!result.ok) {
        log.error('聊天历史备份落盘失败', { projectRoot, message: result.message })
      }
    })
    .catch((error: unknown) => {
      log.error('聊天历史备份通道不可用', { projectRoot, error })
    })
}

function isStoredChatMessage(value: unknown): value is ChatMessage {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return (
    typeof record.id === 'string'
    && (record.role === 'user' || record.role === 'assistant')
    && typeof record.timestamp === 'number'
    && Array.isArray(record.blocks)
  )
}

export const standaloneWorkbenchChatAdapter: WorkbenchChatCompositionAdapter = {
  useProjectRuntime: useStandaloneProjectRuntime,
  SessionSurface: StandaloneWorkbenchChatSessionSurface,
}
