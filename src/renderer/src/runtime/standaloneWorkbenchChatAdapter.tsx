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
import { type WorkbenchChatCompositionAdapter, type WorkbenchChatLiveRunChanges, type WorkbenchChatProjectRuntime, type WorkbenchChatSessionActionsProps, type WorkbenchChatSessionSnapshot, type WorkbenchChatSessionSurfaceProps } from '@renderer/composition/WorkbenchChatProvider'
import { useWorkbenchProviderModelCatalog } from '@renderer/hooks/useWorkbenchProviderModelCatalog'
import { useWorkbenchI18n } from '@renderer/i18n/WorkbenchLocalizationProvider'

import {
  isPlainObject,
  isString,
  Log,
  mapDefined,
  optionalWhen,
  optionalWhenLazy,
  toOptional,
} from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'
import {
  ChatConversationPane,
  ChatThinkingVisibilityProvider,
  type ConversationView,
  type ConversationWorkerThread,
  useScrollToBottom,
} from '@velaros-ai/ui/conversation'
import {
  type ChatComposerControl,
  type ChatInputSendDraft,
  ChatSurfaceComposer,
} from '@velaros-ai/ui/conversation/composer'
import type { InteractionAnswer, ReasoningLevel } from '@velaros-ai/ui/conversation/contracts'
import { type ChatMessage } from '@velaros-ai/ui/conversation/contracts'
import { type BrowserElementSelection } from '@velaros-ai/velaros/browser/contracts'

import {
  ConversationCommandOutputNotice,
  ConversationProjectActivityNotice,
  type WorkbenchConversationEngineSelection,
  type WorkbenchConversationEventEnvelope,
  type WorkbenchConversationImage,
  type WorkbenchConversationState,
  type WorkbenchExecutionMode,
} from '@shared/workbenchConversation'
import type { WorkbenchChatRunChangesSummary } from '@shared/workbenchGit'
import type { WorkbenchPeerEvent, WorkbenchPeerTask } from '@shared/workbenchSessionPeers'

import workbenchAppIconUrl from '../../../../resources/icons/icon.svg?url'
import {
  readWorkbenchAppLocale,
  translateWorkbenchAppMessage,
} from '../i18n/useStandaloneWorkbenchLocalization'
import { resolveWorkbenchChatComposerPlaceholder } from '../models/chat/workbenchChatComposerPlaceholder'
import {
  appendWorkbenchChatFileReferences,
  buildWorkbenchChatFileReferenceOptions,
  formatWorkbenchChatFileReferencesForPrompt,
  readWorkbenchChatFileReferencePath,
  workbenchChatFileReferenceId,
} from '../models/chat/workbenchChatFileReferences'
import { resolveWorkbenchGoalAutoContinue } from '../models/chat/workbenchGoalAutoContinue'
import {
  readWorkbenchConversationRunPreferences,
  readWorkbenchPermissionConfirmationMode,
} from '../models/workbenchPreferences'
import styles from '../styles/workbenchPageStyles'
import { useLatest } from '../support/genericHooks'

import { WorkbenchAgentProcesses } from './conversation/WorkbenchAgentProcesses'
import { WorkbenchContextUsageIndicator } from './conversation/WorkbenchContextUsageIndicator'
import { WorkbenchConversationEngineContext } from './conversation/workbenchConversationEngineContext'
import {
  applyWorkbenchConversationNotice,
  withExpiredInteractions,
  withoutConversationPreviews,
  withSettledScripts,
  withSettledToolCalls,
  withSettledWorkerThreads,
} from './conversation/workbenchConversationNotices'
import { WorkbenchNotebook } from './conversation/WorkbenchNotebook'
import {
  type WorkbenchRunChangesScope,
  WorkbenchRunChangesScopeContext,
} from './conversation/WorkbenchRunChangesCard'
import { applyWorkbenchScriptLiveOutput } from './conversation/workbenchScriptLiveOutput'
import {
  type WorkbenchWorkerThreadScope,
  WorkbenchWorkerThreadScopeContext,
} from './conversation/WorkbenchWorkerThreadPanel'
import {
  appendStandaloneChatContext,
  consumeStandaloneChatDraft,
  EmptyWorkbenchComposerContext,
  forgetStandaloneChatDraft,
  snapshotWorkbenchComposerContext,
  useStandaloneChatDraft,
  type WorkbenchComposerContext,
} from './standaloneChatDrafts'
import { createCoalescedChatPersistence, isSameIdentityList } from './standaloneChatPersistence'
import {
  readStandaloneChatScrollPosition,
  saveStandaloneChatScrollPosition,
} from './standaloneChatScrollPositions'
import {
  projectStandaloneSessionGroups,
  standaloneProjectFolderId,
} from './standaloneChatSessionList'
import {
  forgetStandaloneChatSession,
  registerStandaloneChatSession,
} from './standaloneChatSessionRegistry'
import { sendWorkbenchComposerDraft } from './standaloneComposerSubmission'
import { useStandaloneModelPricing } from './standaloneModelPricing'
import { forgetStandaloneQueuedDrafts, useStandaloneQueuedDrafts } from './standaloneQueuedDrafts'
import {
  appendStandaloneUsageTelemetry,
  readStandaloneUsageTelemetry,
  restoreStandaloneUsageTelemetry,
  serializeStandaloneUsageTelemetry,
  type StandaloneUsageTelemetry,
} from './standaloneUsageTelemetry'
import {
  applyStandaloneConversationState,
  attachStandaloneRunChanges,
  beginStandaloneAgentStop,
  markStandaloneGuidanceApplied,
  markStandaloneRun,
  pauseUnappliedRunGuidance,
  readStandaloneContextUsageEstimate,
  readStandaloneLiveActivity,
  readStandaloneTerminalKind,
  resolveStandaloneRunChangesAnchor,
  restoreStandaloneRunMarkers,
  restoreStandaloneRunStatus,
  sanitizeStandaloneChatMessages,
  shouldBlockStandaloneRunSubmission,
  type StandaloneAgentTerminalKind,
  type StandaloneContextUsageEstimate,
  type StandaloneConversationRuntime,
  type StandaloneRunMarker,
} from './standaloneWorkbenchChatRuntime'
import {
  appendStandaloneCheckpoint,
  createStandaloneSystemNotice,
  isStoredStandaloneCheckpoint,
  type StandaloneChatCheckpoint,
} from './standaloneWorkbenchCheckpoints'
import {
  getStandaloneWorkbenchManagedProvider,
  isStandaloneWorkbenchManagedProviderId,
  refreshStandaloneWorkbenchManagedModels,
  useStandaloneWorkbenchManagedModels,
} from './standaloneWorkbenchManagedModels'
import { createStandaloneWorkbenchModelSelectorProviders } from './standaloneWorkbenchModelCatalog'
import {
  selectStandaloneWorkbenchAgentModel,
  selectStandaloneWorkbenchModelProvider,
  useStandaloneWorkbenchModelConfig,
} from './standaloneWorkbenchModelConfig'
import {
  createStandaloneRunChangeCapture,
  type StandaloneRunChangeCapture,
  StandaloneRunChangeCaptureTiming,
} from './standaloneWorkbenchRunChangeCapture'
import { awaitStandaloneAgentStopSettlement } from './standaloneWorkbenchStopSettlement'
import {
  readWorkbenchEngineSelection,
  resolveWorkbenchEngineModel,
  useWorkbenchAgentEngines,
  workbenchAgentEngineLabel,
} from './workbenchAgentEngines'
import { publishWorkbenchAgentProjectWrite } from './workbenchAgentProjectWrites'
import {
  buildBrowserElementDisplayFallback,
  formatBrowserElementSelectionsForPrompt,
} from './workbenchBrowserElementContext'
import { resolveWorkbenchClipboardFilePath } from './workbenchClipboardFile'
import { workbenchMessage } from './workbenchMessageHost'

const log = Log.tag('workbench-chat-adapter')

interface StandaloneChatState extends StandaloneConversationRuntime {
  readonly projectRoot: string
  readonly sessionId: string
  readonly folderId: string
  readonly messages: readonly ChatMessage[]
  readonly lastRunStartedAt: number | null
  /** 本轮派出去的子 Agent 线程；不持久化——它描述的是「这次跑了什么」，不是会话内容。 */
  readonly workerThreads: readonly ConversationWorkerThread[]
  /** main 最近一次模型请求的上下文用量；仪表读它，renderer 不自己重算。 */
  readonly contextUsage: Nullable<StandaloneContextUsageEstimate>
  /**
   * 每次模型调用的供应方用量（`usage-telemetry`）。共享会话视图按执行时间窗归属，给回答末尾算整轮约价；
   * 随会话持久化（有上限），重启后已完成回答的约价仍在。
   */
  readonly usageTelemetry: readonly StandaloneUsageTelemetry[]
  /** 每轮开跑前的工作区检查点（对话边界 + git 影子提交），「本轮改动」据此比对。 */
  readonly checkpoints: readonly StandaloneChatCheckpoint[]
  /** 每轮收尾时记在这一轮最后一条助手消息上的运行标记（已处理折叠、耗时、中止/失败角标）。 */
  readonly messageRunMarkers: readonly StandaloneRunMarker[]
  /** 正在跑的这一轮实时采到的改动；不持久化——重启时那次执行早已不在。 */
  readonly liveRunChanges: Nullable<WorkbenchChatLiveRunChanges>
  /**
   * 这个会话交给哪个外部引擎（Claude Code、Codex）执行；null 是 VelarOS 自己的 Agent。会话发出第一条消息后
   * 就定下来，引擎的上下文在引擎那边，换执行体要新开会话。
   */
  readonly engine: Nullable<WorkbenchConversationEngineSelection>
  readonly revision: number
}

/** 正在跑的一轮：从发出这一条消息，到主进程推来这一轮的终态。 */
interface ActiveConversationRun {
  readonly projectRoot: string
  readonly sessionId: string
  /** 这一轮的界面身份（用户消息与运行消息同一组）。 */
  readonly scope: { readonly runId: string; readonly turnId: string }
  readonly goalMode: boolean
  /**
   * 这一轮的「本轮改动」：运行中的实时采集与收尾时的最终采集；没有检查点（不是 git 仓库）时为 null。
   * 收尾一律走它的 `finish`。
   */
  runChangeCapture: Nullable<StandaloneRunChangeCapture>
  readonly terminalSettlement: Promise<StandaloneAgentTerminalKind>
  terminalKind: StandaloneAgentTerminalKind | null
  readonly settleTerminal: (kind: StandaloneAgentTerminalKind) => void
}

const states = new Map<string, StandaloneChatState>()
const inactiveStates = new Map<string, StandaloneChatState[]>()
const stateUpdateTargets = new Map<string, string>()
const listeners = new Set<() => void>()
const activeRuns = new Map<string, ActiveConversationRun>()
const pendingSubmissions = new Set<string>()
/** 停止要等主进程把这一轮收完（关运行时、释放脚本进程）；超过这么久还没回音就按停止失败收尾。 */
const WorkbenchAgentStopSettlementTimeoutMs = 15_000
/** 随消息发出的图片：单张上限与张数上限（再大的图描述成附件路径，由 Agent 自己看）。 */
const MaxImageAttachmentBytes = 8 * 1_024 * 1_024
const MaxImageAttachments = 8
let idSequence = 0
let conversationEventSubscription: Nullable<() => void> = null

function nextId(prefix: string): string {
  idSequence += 1
  return `${prefix}-${Date.now().toString(36)}-${idSequence.toString(36)}`
}

function runKey(projectRoot: string, sessionId: string): string {
  return `${projectRoot.trim()}\0${sessionId}`
}

function createActiveRun(
  input: Omit<ActiveConversationRun, 'settleTerminal' | 'terminalKind' | 'terminalSettlement'>
): ActiveConversationRun {
  let settleTerminalPromise!: (kind: StandaloneAgentTerminalKind) => void
  const terminalSettlement = new Promise<StandaloneAgentTerminalKind>((resolve) => {
    settleTerminalPromise = resolve
  })
  const run: ActiveConversationRun = {
    ...input,
    terminalKind: null,
    terminalSettlement,
    settleTerminal: (kind) => {
      if (run.terminalKind) return
      run.terminalKind = kind
      settleTerminalPromise(kind)
    },
  }
  return run
}

function resolveCurrentFileLabel(path: string): string {
  const segments = path.replace(/\\/gu, '/').split('/').filter(Boolean)
  return segments.at(-1) ?? path
}

function stateKey(projectRoot: string): string {
  return projectRoot.trim()
}

function createState(
  projectRoot: string,
  restoreStored = true,
  id = nextId('workbench-workbench')
): StandaloneChatState {
  const empty: StandaloneChatState = {
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
    connectionRetryMessage: null,
    awaitingInputQuestion: null,
    awaitingConfirmationMessage: null,
    awaitingConfirmationId: null,
    awaitingConfirmationExecutionId: null,
    lastRunStartedAt: null,
    lastRunFinishedAt: null,
    workerThreads: [],
    contextUsage: null,
    usageTelemetry: [],
    checkpoints: [],
    messageRunMarkers: [],
    liveRunChanges: null,
    engine: null,
    revision: 0,
  }
  registerStandaloneChatSession(empty.sessionId, projectRoot)
  if (!restoreStored || !projectRoot || typeof window === 'undefined') return empty
  try {
    const raw = window.localStorage.getItem(chatStorageKey(projectRoot))
    if (!raw) return empty
    const stored = JSON.parse(raw) as Record<string, unknown>
    if (stored.version !== 2 || !Array.isArray(stored.sessions)) return empty
    const restored = stored.sessions
      .map((candidate) => restoreStoredState(candidate, empty))
      .filter((candidate): candidate is StandaloneChatState => candidate !== null)
    if (restored.length === 0) return empty
    for (const session of restored) registerStandaloneChatSession(session.sessionId, projectRoot)
    const activeSessionId =
      typeof stored.activeSessionId === 'string' ? stored.activeSessionId : restored[0]!.sessionId
    const active =
      restored.find((candidate) => candidate.sessionId === activeSessionId) ?? restored[0]!
    inactiveStates.set(
      stateKey(projectRoot),
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
  // 重开后未收尾的执行按中断恢复，下一条消息继续这一轮；脚本、交互与未读引导分别收尾。
  const restoredStatus = restoreStandaloneRunStatus(stored, runStoppedText())
  const messages = pauseUnappliedRunGuidance(
    withExpiredInteractions(
      withSettledToolCalls(
        withSettledScripts(
          withoutConversationPreviews(
            sanitizeStandaloneChatMessages(stored.messages.filter(isStoredChatMessage))
          )
        ),
        runStoppedText()
      )
    ),
    { includePending: true }
  )
  return {
    ...empty,
    sessionId: typeof stored.sessionId === 'string' ? stored.sessionId : empty.sessionId,
    folderId: typeof stored.folderId === 'string' ? stored.folderId : empty.folderId,
    messages,
    engine: readWorkbenchEngineSelection(stored.engine),
    ...restoredStatus,
    checkpoints: Array.isArray(stored.checkpoints)
      ? stored.checkpoints.filter(isStoredStandaloneCheckpoint)
      : [],
    messageRunMarkers: restoreStandaloneRunMarkers(stored.messageRunMarkers, messages),
    revision: typeof stored.revision === 'number' ? stored.revision : 0,
    lastRunStartedAt: typeof stored.lastRunStartedAt === 'number' ? stored.lastRunStartedAt : null,
    lastRunFinishedAt:
      typeof stored.lastRunFinishedAt === 'number' ? stored.lastRunFinishedAt : null,
    // 上一轮的用量随会话留存：重新打开对话时仪表直接显示，不必等下一轮。
    contextUsage: readStandaloneContextUsageEstimate({
      ...asRecord(stored.contextUsage),
      kind: 'context-usage-estimate',
    }),
    // 模型调用用量随会话留存：重启后已完成回答的整轮约价照样算得出。
    usageTelemetry: restoreStandaloneUsageTelemetry(stored.usageTelemetry),
  }
}

function getState(projectRoot: string): StandaloneChatState {
  const normalized = projectRoot.trim()
  const key = stateKey(normalized)
  const existing = states.get(key)
  if (existing) return existing
  const created = createState(normalized)
  states.set(key, created)
  return created
}

function updateState(
  projectRoot: string,
  updater: (state: StandaloneChatState) => StandaloneChatState
): void {
  const key = stateKey(projectRoot)
  const active = getState(projectRoot)
  const targetSessionId = stateUpdateTargets.get(key) ?? active.sessionId
  if (targetSessionId !== active.sessionId) {
    const inactive = inactiveStates.get(key) ?? []
    const targetIndex = inactive.findIndex((candidate) => candidate.sessionId === targetSessionId)
    if (targetIndex < 0) return
    const current = inactive[targetIndex]!
    const next = updater(current)
    if (next === current) return
    const nextInactive = [...inactive]
    nextInactive[targetIndex] = next
    inactiveStates.set(key, nextInactive)
    persistState(active)
    for (const listener of listeners) listener()
    return
  }
  const next = updater(active)
  if (next === active) return
  states.set(key, next)
  persistState(next)
  for (const listener of listeners) listener()
}

function withStateUpdateTarget(projectRoot: string, sessionId: string, action: () => void): void {
  const key = stateKey(projectRoot)
  const previous = stateUpdateTargets.get(key)
  stateUpdateTargets.set(key, sessionId)
  try {
    action()
  } finally {
    if (previous) stateUpdateTargets.set(key, previous)
    else stateUpdateTargets.delete(key)
  }
}

/** 改指定会话（不一定是当前显示的那个）：一轮的事件、回执一律落回发起它的会话。 */
function updateSession(
  projectRoot: string,
  sessionId: string,
  updater: (state: StandaloneChatState) => StandaloneChatState
): void {
  withStateUpdateTarget(projectRoot, sessionId, () => updateState(projectRoot, updater))
}

function readAllStates(projectRoot: string): readonly StandaloneChatState[] {
  const active = getState(projectRoot)
  return [active, ...(inactiveStates.get(stateKey(projectRoot)) ?? [])]
}

/** 将界面持有的项目会话同步给宿主；流正文不进入目录。 */
async function syncWorkbenchPeerCatalog(projectRoot: string): Promise<void> {
  const result = await window.velarosWorkbenchSessionPeers.catalog({
    projectRoot,
    members: readAllStates(projectRoot)
      .filter((state) => !state.engine)
      .map((state) => ({
        sessionId: state.sessionId,
        title: readStandaloneChatTitle(state).slice(0, 500),
      })),
  })
  if (!result.ok) throw new AppError('UNAVAILABLE', result.message)
}

function readSession(projectRoot: string, sessionId: string): StandaloneChatState | undefined {
  return readAllStates(projectRoot).find((candidate) => candidate.sessionId === sessionId)
}

function activateState(projectRoot: string, sessionId: string): boolean {
  const key = stateKey(projectRoot)
  const active = getState(projectRoot)
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

function useStandaloneChatState(projectRoot: string): StandaloneChatState {
  return useSyncExternalStore(
    subscribeStandaloneChatStore,
    () => getState(projectRoot),
    () => getState(projectRoot)
  )
}

/**
 * 本轮开跑前的检查点：对话边界（这条用户消息的下标）+ 项目工作树的 git 影子提交。
 * 不是 git 仓库或捕获失败时 commitId 为 null——照样记下边界，这一轮只是没有「本轮改动」。
 */
async function captureRunCheckpoint(
  projectRoot: string,
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
  updateSession(projectRoot, sessionId, (state) => {
    const appended = appendStandaloneCheckpoint(state.checkpoints, checkpoint)
    evicted = appended.evicted
    return { ...state, checkpoints: appended.checkpoints }
  })
  releaseCheckpointRefs(projectRoot, sessionId, evicted)
  return checkpoint
}

/**
 * 这一轮的「本轮改动」：Agent 每改一次项目（主进程推来项目动静）按节奏拿工作树与这一轮开跑前的检查点比
 * 一次，与收尾时的最终采集用同一个记录 id、覆盖同一条记录；摘要挂在会话的「进行中」上，「AI 改动」面板
 * 据此实时显示这一轮。收尾时的最终采集见 `captureRunChanges`。
 */
function createRunChangeCapture(
  projectRoot: string,
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
      updateSession(projectRoot, sessionId, (state) => ({
        ...state,
        liveRunChanges: { firstMessageIndex: checkpoint.captureMessageCount, summary },
      }))
    },
    settle: () => captureRunChanges(projectRoot, sessionId, checkpoint),
  })
}

/**
 * 一轮收尾后记下「本轮改动」：拿工作树与这一轮开跑前的检查点比、按这一轮的改动归属只留 Agent 改的文件，
 * 补丁落进主进程的记录文件，运行标记上只挂摘要；运行中实时采到的那份随之撤下。主进程采完这一次就关掉
 * 这一轮的归属账本。
 *
 * 采集请求在收尾的同一拍同步发出：main 按项目根串行，它排在下一条排队消息开跑前的检查点之前，下一轮的
 * 改动混不进这一轮。
 */
function captureRunChanges(
  projectRoot: string,
  sessionId: string,
  checkpoint: StandaloneChatCheckpoint
): void {
  const baseCommitId = checkpoint.commitId
  const session = readSession(projectRoot, sessionId)
  if (!baseCommitId || !session) return
  const anchorId = resolveStandaloneRunChangesAnchor(
    session.messages,
    session.messageRunMarkers,
    checkpoint.captureMessageCount
  )
  // 最终摘要挂不上：运行中实时采到的那份撤下，面板里不留一轮永远「进行中」；它的记录连同主进程里
  // 这一轮还开着的归属账本一起清掉。
  const withdrawLive = (): void => {
    withdrawLiveRunChanges(projectRoot, sessionId, checkpoint.id)
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
      final: true,
    })
    .then(
      (result) => {
        if (!result.ok) {
          log.warn('本轮改动采集失败', { sessionId, message: result.message })
          withdrawLive()
          return
        }
        const attached = attachRunChanges(projectRoot, sessionId, anchorId, result.value)
        // 这条消息在采集期间已经不在了：刚写下的记录没人引用；被替换掉的旧记录同理。
        const orphaned = attached
          ? attached.replacedRecordId
          : result.value.fileCount > 0
            ? checkpoint.id
            : null
        if (orphaned) releaseRunChangeRecords(projectRoot, sessionId, [orphaned])
      },
      (error: unknown) => {
        log.warn('本轮改动采集通道不可用', { sessionId, error })
        withdrawLive()
      }
    )
}

async function prepareWorkbenchPeerTask(
  task: WorkbenchPeerTask,
  signal: AbortSignal
): Promise<void> {
  const projectRoot = task.projectRoot
  const targetKey = runKey(projectRoot, task.sessionId)
  if (pendingSubmissions.has(targetKey) || activeRuns.has(targetKey))
    throw new AppError('CONFLICT', '目标会话正在提交或运行。')
  let target = readSession(projectRoot, task.sessionId)
  if (!target && task.newSession) {
    target = { ...createState(projectRoot, false, task.sessionId), engine: null }
    inactiveStates.set(stateKey(projectRoot), [
      ...(inactiveStates.get(stateKey(projectRoot)) ?? []),
      target,
    ])
  }
  if (!target || target.engine || isActiveChatRun(target.status))
    throw new AppError('CONFLICT', '目标会话暂时无法接收任务。')
  signal.throwIfAborted()
  pendingSubmissions.add(targetKey)
  const scope = { runId: task.inputId, turnId: nextId('turn') }
  const message: ChatMessage = {
    ...createTextMessage('user', task.text),
    id: task.inputId,
    ...scope,
    conversationKind: 'turn-input',
  }
  const run = createActiveRun({
    projectRoot,
    sessionId: task.sessionId,
    scope,
    goalMode: false,
    runChangeCapture: null,
  })
  activeRuns.set(targetKey, run)
  ensureConversationEventSubscription()
  updateSession(projectRoot, task.sessionId, (state) => ({
    ...state,
    messages: [...state.messages, message],
    status: 'running',
    teamPhase: 'creating-task',
    activeTurn: null,
    completedTurns: 0,
    lastError: null,
    connectionRetryAttempt: null,
    connectionRetryMaxAttempts: null,
    connectionRetryMessage: null,
    awaitingInputQuestion: null,
    awaitingConfirmationMessage: null,
    awaitingConfirmationId: null,
    awaitingConfirmationExecutionId: null,
    lastRunStartedAt: Date.now(),
    lastRunFinishedAt: null,
    workerThreads: [],
    revision: state.revision + 1,
  }))
  try {
    const checkpoint = await captureRunCheckpoint(
      projectRoot,
      task.sessionId,
      target.messages.length,
      task.text
    )
    run.runChangeCapture = createRunChangeCapture(projectRoot, task.sessionId, checkpoint)
    signal.throwIfAborted()
    await syncWorkbenchPeerCatalog(projectRoot)
    signal.throwIfAborted()
  } catch (error) {
    finishRun(run, {
      kind: signal.aborted ? 'aborted' : 'error',
      message: AppError.getMessage(error),
    })
    run.runChangeCapture?.finish()
    throw error
  } finally {
    pendingSubmissions.delete(targetKey)
  }
}

const peerPreparations = new Map<string, AbortController>()
let peerEventSubscription: Nullable<() => void> = null

function receiveWorkbenchPeerEvent(event: WorkbenchPeerEvent): void {
  if (event.type === 'failed') {
    updateSession(event.ref.projectRoot, event.ref.sessionId, (state) => ({
      ...state,
      messages: [...state.messages, createTextMessage('assistant', event.message)],
    }))
    return
  }
  const { task } = event
  const projectRoot = task.projectRoot
  const cancel = (message: string): void => {
    const preparation = peerPreparations.get(task.inputId)
    if (preparation) preparation.abort(new AppError('CANCELLED', message))
    const run = activeRuns.get(runKey(projectRoot, task.sessionId))
    if (run?.scope.runId === task.inputId) finishRun(run, { kind: 'error', message })
  }
  if (event.type === 'cancel') {
    cancel(event.message)
    return
  }
  if (peerPreparations.has(task.inputId)) return
  const controller = new AbortController()
  peerPreparations.set(task.inputId, controller)
  void prepareWorkbenchPeerTask(task, controller.signal)
    .then(
      () =>
        window.velarosWorkbenchSessionPeers.acknowledge({
          projectRoot,
          sessionId: task.sessionId,
          inputId: task.inputId,
        }),
      (error: unknown) =>
        window.velarosWorkbenchSessionPeers.acknowledge({
          projectRoot,
          sessionId: task.sessionId,
          inputId: task.inputId,
          error: AppError.getMessage(error).slice(0, 8000),
        })
    )
    .then((result) => {
      if (!result.ok) cancel(result.message)
    })
    .catch((error: unknown) => {
      cancel(AppError.getMessage(error))
      log.warn('会话任务回执失败', { error })
    })
    .finally(() => peerPreparations.delete(task.inputId))
}

// ---------------------------------------------------------------------------------------------
// 运行中的通知与状态：主进程推来的每一条落到发起那一轮的会话上
// ---------------------------------------------------------------------------------------------

/** 会话通道的事件订阅：全应用一份，第一次挂上会话面时装上。 */
function ensureConversationEventSubscription(): void {
  if (typeof window === 'undefined') return
  peerEventSubscription ??= window.velarosWorkbenchSessionPeers.onEvent(receiveWorkbenchPeerEvent)
  if (conversationEventSubscription) return
  conversationEventSubscription =
    window.velarosWorkbenchConversation.onEvent(applyConversationEnvelope)
}

function applyConversationEnvelope(envelope: WorkbenchConversationEventEnvelope): void {
  const run = activeRuns.get(runKey(envelope.projectRoot, envelope.sessionId))
  if (!run) return
  const { event } = envelope
  if (event.type === 'notice') {
    if (event.kind === ConversationCommandOutputNotice) {
      if (
        isPlainObject(event.payload) &&
        isString(event.payload.id) &&
        isString(event.payload.text)
      )
        applyWorkbenchScriptLiveOutput({ id: event.payload.id, text: event.payload.text })
      return
    }
    if (event.kind === ConversationProjectActivityNotice) {
      // Agent 改项目的一段时间窗结束：这一轮的「本轮改动」跟上，Git 等界面也按项目根收到通知。
      run.runChangeCapture?.request()
      publishWorkbenchAgentProjectWrite(run.projectRoot)
      return
    }
    updateSession(run.projectRoot, run.sessionId, (state) => {
      const next = applyWorkbenchConversationNotice(
        { messages: state.messages, workerThreads: state.workerThreads },
        event.kind,
        event.payload,
        run.scope
      )
      if (next.messages === state.messages && next.workerThreads === state.workerThreads)
        return state
      return {
        ...state,
        messages: next.messages,
        workerThreads: next.workerThreads,
        revision: state.revision + 1,
      }
    })
    return
  }
  applyConversationState(run, event.payload)
}

function applyConversationState(
  run: ActiveConversationRun,
  runtime: WorkbenchConversationState
): void {
  const { projectRoot, sessionId } = run
  switch (runtime.kind) {
    case 'usage-telemetry': {
      const usage = readStandaloneUsageTelemetry(runtime)
      if (!usage) return
      updateSession(projectRoot, sessionId, (state) => ({
        ...state,
        usageTelemetry: appendStandaloneUsageTelemetry(state.usageTelemetry, usage),
        revision: state.revision + 1,
      }))
      return
    }
    case 'context-usage-estimate': {
      const contextUsage = readStandaloneContextUsageEstimate(runtime)
      if (!contextUsage) return
      updateSession(projectRoot, sessionId, (state) => ({
        ...state,
        contextUsage,
        revision: state.revision + 1,
      }))
      return
    }
    case 'input-applied':
      updateSession(projectRoot, sessionId, (state) => {
        const messages = markStandaloneGuidanceApplied(state.messages, runtime.inputId)
        return messages === state.messages
          ? state
          : { ...state, messages, revision: state.revision + 1 }
      })
      return
  }
  const terminalKind = readStandaloneTerminalKind(runtime)
  if (terminalKind) {
    finishRun(run, runtime)
    return
  }
  updateSession(projectRoot, sessionId, (state) => {
    const next = applyStandaloneConversationState(state, runtime)
    return next === state ? state : { ...next, revision: state.revision + 1 }
  })
}

/**
 * 一轮收尾：没收尾的脚本卡按取消、没回答的交互卡按失效、没读走的引导按暂停、还没被接纳的预览撤下，记下
 * 运行标记，立刻落盘；再了结这一轮，并按收尾规则记下「本轮改动」。主进程推来终态、发送失败、停止超时都走这里，
 * 只生效一次。
 */
function finishRun(run: ActiveConversationRun, runtime: WorkbenchConversationState): void {
  const key = runKey(run.projectRoot, run.sessionId)
  if (activeRuns.get(key) !== run) return
  const terminalKind = readStandaloneTerminalKind(runtime) ?? 'error'
  updateSession(run.projectRoot, run.sessionId, (state) => {
    const settled = applyStandaloneConversationState(
      {
        ...state,
        messages: settleTerminalMessages(state.messages),
        workerThreads: withSettledWorkerThreads(state.workerThreads),
      },
      runtime
    )
    return {
      ...withRunMarker(settled, {
        goalMode: run.goalMode,
        goalStatus: runtime.kind === 'done' ? runtime.goalStatus : undefined,
      }),
      revision: state.revision + 1,
    }
  })
  activeRuns.delete(key)
  run.settleTerminal(terminalKind)
  // 一轮收尾时回答已经完整：立刻落盘，不等合并窗口。
  flushChatPersistence()
  // 停下或失败的一轮也可能已经改了文件：「AI 改动」要列全每一轮。
  run.runChangeCapture?.finish()
}

/** 没跑完就收尾的工具卡上写的那一句，按此刻的界面语言。 */
function runStoppedText(): string {
  return translateWorkbenchAppMessage(readWorkbenchAppLocale(), 'chat.runStopped')
}

/** 一轮收尾时的消息整理：去掉预览与不可见占位，收掉没收尾的卡片，暂停没被读走的引导。 */
function settleTerminalMessages(messages: readonly ChatMessage[]): ChatMessage[] {
  return pauseUnappliedRunGuidance(
    withExpiredInteractions(
      withSettledToolCalls(
        withSettledScripts(withoutConversationPreviews(sanitizeStandaloneChatMessages(messages))),
        runStoppedText()
      )
    )
  )
}

/** 一轮收尾后的状态：给这一轮最后一条助手消息记运行标记（与 Desktop 同一规则）。 */
function withRunMarker(
  state: StandaloneChatState,
  goal: { goalMode: boolean; goalStatus?: StandaloneRunMarker['goalStatus'] }
): StandaloneChatState {
  const messageRunMarkers = markStandaloneRun({
    messages: state.messages,
    markers: state.messageRunMarkers,
    status: state.status,
    lastError: state.lastError,
    completedTurns: state.completedTurns,
    lastRunStartedAt: state.lastRunStartedAt,
    lastRunFinishedAt: state.lastRunFinishedAt,
    goalMode: goal.goalMode,
    goalStatus: goal.goalStatus,
  })
  return messageRunMarkers === state.messageRunMarkers ? state : { ...state, messageRunMarkers }
}

function findActiveRun(projectRoot: string, sessionId: string): ActiveConversationRun | null {
  return activeRuns.get(runKey(projectRoot, sessionId)) ?? null
}

// ---------------------------------------------------------------------------------------------
// 项目级视图
// ---------------------------------------------------------------------------------------------

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

function readStandaloneProjectRuntimeView(projectRoot: string): StandaloneProjectRuntimeView {
  const key = stateKey(projectRoot)
  const active = getState(projectRoot)
  const sessions = readAllStates(projectRoot)
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
    state.engine,
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
    engine: state.engine,
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

function useStandaloneProjectRuntime(projectRoot: Nullable<string>): WorkbenchChatProjectRuntime {
  const normalizedRoot = projectRoot?.trim() ?? ''
  const readView = (): StandaloneProjectRuntimeView =>
    readStandaloneProjectRuntimeView(normalizedRoot)
  const view = useSyncExternalStore(subscribeStandaloneChatStore, readView, readView)
  useEffect(() => {
    if (normalizedRoot)
      void syncWorkbenchPeerCatalog(normalizedRoot).catch((error: unknown) =>
        log.warn('会话目录同步失败', { error })
      )
  }, [normalizedRoot, view])
  return useMemo(
    () => buildStandaloneProjectRuntime(projectRoot, normalizedRoot, view),
    [normalizedRoot, projectRoot, view]
  )
}

function buildStandaloneProjectRuntime(
  projectRoot: Nullable<string>,
  normalizedRoot: string,
  { active: state, sessions: allStates }: StandaloneProjectRuntimeView
): WorkbenchChatProjectRuntime {
  // 一个项目一个会话文件夹，会话是它的成员（见 standaloneChatSessionList）。
  const folderId = standaloneProjectFolderId(normalizedRoot)
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
      openAgentChat: (engineId) => {
        const key = stateKey(normalizedRoot)
        const active = getState(normalizedRoot)
        if ((active.engine?.id ?? null) === engineId) return
        const inactive = inactiveStates.get(key) ?? []
        const previous = inactive.find((candidate) => (candidate.engine?.id ?? null) === engineId)
        const next = previous ?? {
          ...createState(normalizedRoot, false),
          engine: engineId ? { id: engineId } : null,
        }
        inactiveStates.set(key, [active, ...inactive.filter((candidate) => candidate !== previous)])
        states.set(key, next)
        persistState(next, { immediate: true })
        for (const listener of listeners) listener()
      },
      addProjectSession: async () => {
        const key = stateKey(normalizedRoot)
        const active = getState(normalizedRoot)
        const next = { ...createState(normalizedRoot, false), engine: active.engine }
        inactiveStates.set(key, [active, ...(inactiveStates.get(key) ?? [])])
        states.set(key, next)
        persistState(next, { immediate: true })
        for (const listener of listeners) listener()
        return true
      },
      // 面板的「归档当前聊天会话」传的是项目文件夹：归档的是当前这个会话。
      archiveSession: async (targetFolderId) => {
        const key = stateKey(normalizedRoot)
        const active = getState(normalizedRoot)
        const inactive = inactiveStates.get(key) ?? []
        const target =
          targetFolderId === folderId
            ? active
            : [active, ...inactive].find((candidate) => candidate.folderId === targetFolderId)
        if (!target || isActiveChatRun(target.status)) return
        releaseRemovedSession(target)
        if (target.sessionId === active.sessionId) {
          const replacement = inactive.find((candidate) => candidate.engine?.id === active.engine?.id)
          const remaining = inactive.filter((candidate) => candidate !== replacement)
          const next = replacement ?? { ...createState(normalizedRoot, false), engine: active.engine }
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
        activateState(normalizedRoot, memberSessionId)
      },
      startProjectChat: () => folderId,
    },
  }
}

// ---------------------------------------------------------------------------------------------
// 会话面
// ---------------------------------------------------------------------------------------------

function StandaloneWorkbenchChatSessionActions({
  projectRoot,
  sessionId,
}: WorkbenchChatSessionActionsProps): Nullable<ReactElement> {
  const chat = useStandaloneChatState(projectRoot)
  if (chat.engine || chat.sessionId !== sessionId) return null
  return (
    <>
      <WorkbenchAgentProcesses projectRoot={projectRoot} sessionId={sessionId} />
      <WorkbenchNotebook projectRoot={projectRoot} sessionId={sessionId} />
    </>
  )
}

function StandaloneWorkbenchChatSessionSurface({
  projectRoot,
  currentFilePath,
  conversationRefreshKey,
  scrollNavigatorHidden = false,
  pendingBrowserElementSelections,
  onBrowserElementSelectionsConsumed,
  pendingFileReferences,
  onFileReferencesConsumed,
  onOpenFileChange,
  onOpenWorkspacePath,
  onReviewFileChanges,
  onReviewRunChanges,
}: WorkbenchChatSessionSurfaceProps): ReactElement {
  const chat = useStandaloneChatState(projectRoot)
  const hasActiveRun = !!findActiveRun(projectRoot, chat.sessionId)
  const { t, locale } = useWorkbenchI18n()
  const modelConfig = useStandaloneWorkbenchModelConfig()
  const managedModelState = useStandaloneWorkbenchManagedModels()
  const selectedManagedProvider = getStandaloneWorkbenchManagedProvider(
    modelConfig.provider,
    managedModelState
  )
  // 交给外部引擎的会话：模型、登录与上下文都是引擎自己的，这一侧只管它选了哪个引擎、哪个模型。
  const engines = useWorkbenchAgentEngines()
  const engine = chat.engine
  const providerCatalog = useWorkbenchProviderModelCatalog(modelConfig, selectedManagedProvider, !engine)
  const engineStatus = engine ? engines.find((status) => status.id === engine.id) : undefined
  const engineLabel = engine ? workbenchAgentEngineLabel(engine.id) : null
  const {
    value: prompt,
    setValue: setPrompt,
    files,
    setFiles,
    context: composerContext,
    setContext: setComposerContext,
    browserSelections,
    setBrowserSelections,
    includedCurrentFilePath,
    setIncludedCurrentFilePath,
    fileReferencePaths,
    setFileReferencePaths,
    selectedFileReferencePaths,
    setSelectedFileReferencePaths,
    goalMode,
    setGoalMode,
    planMode,
    setPlanMode,
    reasoningLevel,
    setReasoningLevel,
  } = useStandaloneChatDraft(`${projectRoot}\0${chat.sessionId}`, {
    currentFilePath,
    reasoningLevel: readStoredReasoningLevel(),
  })
  const [showThinkingProcess, setShowThinkingProcess] = useState(true)
  const [accountSignInSessions, setAccountSignInSessions] = useState<ReadonlySet<string>>(
    () => new Set()
  )
  const accountSignInPending = accountSignInSessions.has(chat.sessionId)
  const setAccountSignInPending = (pending: boolean): void => {
    setAccountSignInSessions((current) => {
      const next = new Set(current)
      if (pending) next.add(chat.sessionId)
      else next.delete(chat.sessionId)
      return next
    })
  }
  const isAwaitingInput = chat.status === 'awaiting-input'
  const isAwaitingConfirmation = chat.status === 'awaiting-confirmation'
  // 运行中输入框发送统一入队；队列项的发送动作可向当前内置 Agent 追加引导。
  const canSteerRun = chat.status === 'running' && hasActiveRun && !engine
  const engineRunActive = !!engine && chat.status === 'running' && hasActiveRun
  const queuedDrafts = useStandaloneQueuedDrafts({
    scopeId: `${projectRoot}\0${chat.sessionId}`,
    isRunBlocked: shouldBlockStandaloneRunSubmission(
      chat.status,
      hasActiveRun,
      accountSignInPending
    ),
    // 用户按了停止（或本轮失败）：保留排队，但不替他自动发下一条（与 Desktop 一致）。
    pauseAutomaticDrain: chat.status === 'stopping' || isInterruptedRunStatus(chat.status),
    submitDraft: (draft) =>
      new Promise<boolean>((resolve) => {
        void submit(draft.value, draft.files, {
          context: draft.context ?? EmptyWorkbenchComposerContext,
          queued: true,
          onAccepted: () => resolve(true),
        }).then(resolve)
      }),
  })
  // 目标自动续跑（规则见 resolveWorkbenchGoalAutoContinue）：每个会话自上次用户亲自发言以来续跑了几轮。
  const goalAutoContinueRoundsRef = useRef(new Map<string, number>())
  const handledGoalContinueRunRef = useRef<Nullable<string>>(null)
  const queuedDraftCountLatest = useLatest(queuedDrafts.drafts.length)

  useEffect(() => {
    ensureConversationEventSubscription()
  }, [])

  useEffect(() => {
    // 目标自动续跑只对 VelarOS 自己的 Agent：外部引擎的目标归引擎自己管。
    if (chat.status !== 'completed' || !chat.lastRunFinishedAt || hasActiveRun || chat.engine)
      return
    const sessionId = chat.sessionId
    const finishedAt = chat.lastRunFinishedAt
    const runKeyForGoal = `${sessionId}:${finishedAt}`
    if (handledGoalContinueRunRef.current === runKeyForGoal) return
    handledGoalContinueRunRef.current = runKeyForGoal

    void (async () => {
      const lifecycle = await window.velarosWorkbenchConversation
        .getGoal({ sessionId, projectRoot })
        .catch((error: unknown) => {
          log.warn('读取目标失败，不自动续跑', { sessionId, error })
          return null
        })
      // 读目标期间用户可能已经发了新消息或切到别的会话：只在同一轮结束的现场续跑。
      const current = getState(projectRoot)
      if (
        current.sessionId !== sessionId ||
        current.status !== 'completed' ||
        current.lastRunFinishedAt !== finishedAt ||
        !!findActiveRun(projectRoot, sessionId)
      )
        return

      const consecutiveAutoRounds = goalAutoContinueRoundsRef.current.get(sessionId) ?? 0
      const decision = resolveWorkbenchGoalAutoContinue({
        runCompleted: true,
        msSinceRunFinished: Date.now() - finishedAt,
        goal: lifecycle?.ok ? lifecycle.value.goal : null,
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
  }, [chat.engine, chat.lastRunFinishedAt, chat.sessionId, chat.status, hasActiveRun, projectRoot])

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

  // 宿主投递来的拾取结果收进输入框，并回执「已接收」让宿主清掉待投递项。
  useEffect(() => {
    if (pendingBrowserElementSelections.length === 0) return
    for (const { targetSessionId, selection } of pendingBrowserElementSelections) {
      if (readSession(projectRoot, targetSessionId))
        appendStandaloneChatContext(runKey(projectRoot, targetSessionId), {
          browserSelections: [selection],
        })
    }
    onBrowserElementSelectionsConsumed?.(
      pendingBrowserElementSelections.map((delivery) => delivery.deliveryId)
    )
  }, [projectRoot, onBrowserElementSelectionsConsumed, pendingBrowserElementSelections])

  // 宿主投递来的「添加到聊天」：挂到这条消息上，同时记进本会话的可引用列表。
  useEffect(() => {
    if (pendingFileReferences.length === 0) return
    for (const { targetSessionId, path } of pendingFileReferences) {
      if (readSession(projectRoot, targetSessionId))
        appendStandaloneChatContext(runKey(projectRoot, targetSessionId), { filePaths: [path] })
    }
    onFileReferencesConsumed?.(pendingFileReferences.map((delivery) => delivery.deliveryId))
  }, [projectRoot, onFileReferencesConsumed, pendingFileReferences])

  const fileReferenceOptions = useMemo(
    () => buildWorkbenchChatFileReferenceOptions(fileReferencePaths),
    [fileReferencePaths]
  )
  /** 这条消息要问的文件：「当前文件」chip 加上挂着的引用，同一个文件只算一次。输入框提示据此说问几个文件。 */
  const askedFilePaths = useMemo(
    () =>
      appendWorkbenchChatFileReferences(
        includedCurrentFilePath ? [includedCurrentFilePath] : [],
        selectedFileReferencePaths
      ),
    [includedCurrentFilePath, selectedFileReferencePaths]
  )

  useEffect(() => {
    if (
      managedModelState.status !== 'ready' ||
      !isStandaloneWorkbenchManagedProviderId(modelConfig.provider) ||
      selectedManagedProvider
    )
      return
    selectStandaloneWorkbenchModelProvider('openrouter')
  }, [managedModelState.status, modelConfig.provider, selectedManagedProvider])

  async function stop(): Promise<void> {
    const run = findActiveRun(projectRoot, chat.sessionId)
    if (!run) return

    // 先在 renderer 收敛到 stopping，阻止晚到的阶段事件把按钮重新变回运行态；同时解除用户可能显式开启的
    // 强制跟随，让停止期间也能自由查看已有结果。
    setFollowLocked(false)
    updateSession(projectRoot, run.sessionId, (state) => ({
      ...beginStandaloneAgentStop(state),
      revision: state.revision + 1,
    }))

    let retainedInputIds: readonly string[] = []
    const settlement = await awaitStandaloneAgentStopSettlement({
      // 协调器先启动 timeout，再进入此 IPC；preload/main 永不返回也能有界释放 UI。
      requestAbort: async () => {
        const result = await window.velarosWorkbenchConversation.cancel({
          sessionId: run.sessionId,
          projectRoot,
        })
        if (result.ok) retainedInputIds = result.value.retainedInputIds ?? []
        return result.ok
      },
      terminalSettlement: run.terminalSettlement,
      readTerminalKind: () => run.terminalKind,
      timeoutMs: WorkbenchAgentStopSettlementTimeoutMs,
    })
    // 停下时还没被读走的引导记为已暂停（其中也有回执还没回来、仍显示「引导中」的）。
    if (retainedInputIds.length > 0)
      updateSession(projectRoot, run.sessionId, (state) => ({
        ...state,
        messages: pauseUnappliedRunGuidance(state.messages, {
          includePending: true,
          inputIds: retainedInputIds,
        }),
        revision: state.revision + 1,
      }))
    if (settlement.kind === 'terminal' || findActiveRun(projectRoot, run.sessionId) !== run) return

    // 没有确认底层已终止，不能伪装成 aborted；恢复可发送并明确失败。
    finishRun(run, {
      kind: 'error',
      message:
        settlement.kind === 'request-error' && settlement.error instanceof Error
          ? settlement.error.message
          : t('workbench.chatStopFailed'),
    })
  }

  /**
   * 点开输入框里的附件（与 Desktop 相同，附件得有本机路径）：项目里的文件在编辑器里打开，
   * 项目之外的交给系统默认应用。
   */
  async function openAttachedFile(file: File): Promise<void> {
    const path = resolveWorkbenchClipboardFilePath(
      file,
      window.velarosWorkbenchProjectHub.getPathForFile
    )
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
   * 输入框发送：等待回答时直接回答，运行中加入队列，空闲时发起任务。
   * 以「受理」为界返回，避免输入框等待整轮执行结束。
   */
  function sendComposerDraft(draft?: ChatInputSendDraft): Promise<void> {
    return sendWorkbenchComposerDraft({
      draft,
      value: prompt,
      files,
      context: composerContext,
      answering: isAwaitingInput,
      canEnqueue: canSteerRun || engineRunActive,
      answer: answerPendingInput,
      enqueue: queuedDrafts.enqueue,
      clear: () => {
        setPrompt('')
        setFiles([])
        setBrowserSelections([])
        setSelectedFileReferencePaths([])
      },
      submit: (value, draftFiles) =>
        new Promise<void>((resolve) => {
          void submit(value, draftFiles, { onAccepted: resolve }).finally(resolve)
        }),
    })
  }

  /** 输入框里回答一句话的提问（卡片上照样写上这句回答）；送不到就把原文放回输入框。 */
  async function answerPendingInput(value: string): Promise<void> {
    const answer = value.trim()
    if (!answer) return
    setPrompt('')
    const result = await window.velarosWorkbenchConversation
      .input({ sessionId: chat.sessionId, projectRoot, answer })
      .catch((error: unknown) => ({ ok: false as const, message: String(error) }))
    if (result.ok) return
    setPrompt((current) => current || value)
    workbenchMessage.warning({
      title: t('workbench.chatInteractionAnswerFailedTitle'),
      description: result.message,
    })
  }

  /** 交互卡上的回答（选项、表单、确认、危险命令）：交给主进程，卡片随后由主进程推来的更新原位写上回答。 */
  async function answerInteraction(requestId: string, answer: InteractionAnswer): Promise<void> {
    const result = await window.velarosWorkbenchConversation
      .answer({ sessionId: chat.sessionId, projectRoot, requestId, answer })
      .catch((error: unknown) => ({ ok: false as const, message: String(error) }))
    if (result.ok) return
    workbenchMessage.warning({
      title: t('workbench.chatInteractionAnswerFailedTitle'),
      description: result.message,
    })
  }

  /** 只挂了文件、没写字就发出去的消息：气泡里写明问的是哪几个文件。 */
  function describeBrowserElements(selections: readonly BrowserElementSelection[]): string {
    return buildBrowserElementDisplayFallback(selections, {
      separator: t('workbench.chatFileReferenceListSeparator'),
      describe: (elements) => t('workbench.chatBrowserElementsMessageFallback', { elements }),
    })
  }

  function buildFileReferenceDisplayFallback(paths: readonly string[]): string {
    if (paths.length === 0) return ''
    return t('workbench.chatFileReferencesMessageFallback', {
      files: buildWorkbenchChatFileReferenceOptions(paths)
        .map((option) => option.label)
        .join(t('workbench.chatFileReferenceListSeparator')),
    })
  }

  async function sendRunGuidance(
    text: string,
    selections: readonly BrowserElementSelection[] = [],
    referencedFilePaths: readonly string[] = [],
    options?: { queued: boolean }
  ): Promise<boolean> {
    const sessionId = chat.sessionId
    const run = findActiveRun(projectRoot, sessionId)
    const guidance: ChatMessage = {
      ...createTextMessage(
        'user',
        text ||
          describeBrowserElements(selections) ||
          buildFileReferenceDisplayFallback(referencedFilePaths)
      ),
      conversationKind: 'run-guidance',
      guidanceStatus: 'pending',
      ...(run ? { runId: run.scope.runId, turnId: run.scope.turnId } : {}),
      browserElementSelections: optionalWhen(selections.length > 0, [...selections]),
    }
    // 引导通道只带文字：拾取的元素、引用的文件路径折成上下文段跟在正文后面。
    const guidanceText = [
      text,
      formatBrowserElementSelectionsForPrompt(selections),
      formatWorkbenchChatFileReferencesForPrompt(referencedFilePaths),
    ]
      .filter(Boolean)
      .join('\n\n')
    if (!options?.queued) {
      consumeStandaloneChatDraft(runKey(projectRoot, sessionId), {
        value: text,
        files: [],
        context: {
          ...composerContext,
          browserSelections: [...selections],
          selectedFileReferencePaths: [...referencedFilePaths],
        },
      })
    }
    updateSession(projectRoot, sessionId, (state) => ({
      ...state,
      messages: [...state.messages, guidance],
      revision: state.revision + 1,
    }))
    const delivered = await window.velarosWorkbenchConversation
      .guidance({ sessionId, projectRoot, inputId: guidance.id, text: guidanceText })
      .catch(() => ({ ok: false as const, message: '' }))
    if (delivered.ok) {
      // 只推进「引导中」：回执之前 input-applied 可能已经先到（已纳入），不能被拉回。
      // 回执到时这一轮已经收尾的，引导不会再被读走——直接记为已暂停。
      updateSession(projectRoot, sessionId, (state) => ({
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
    // 这一轮恰好收尾：撤回这条引导，原文放回输入框，由用户重新发送。
    updateSession(projectRoot, sessionId, (state) => ({
      ...state,
      messages: state.messages.filter((message) => message.id !== guidance.id),
      revision: state.revision + 1,
    }))
    if (!options?.queued) {
      setPrompt((current) => current || text)
      setBrowserSelections((current) => [
        ...current,
        ...selections.filter((selection) => !current.some((item) => item.id === selection.id)),
      ])
      setSelectedFileReferencePaths((current) =>
        appendWorkbenchChatFileReferences(current, referencedFilePaths)
      )
    }
    workbenchMessage.warning({
      title: t('workbench.chatGuidanceRejectedTitle'),
      description: t('workbench.chatGuidanceRejectedDescription'),
    })
    return false
  }

  /**
   * 发一条消息。返回是否受理；`onAccepted` 在主进程接纳本次输入后回调——
   * 函数本身等主进程接纳这条输入才 resolve，不等整轮跑完。
   */
  async function submit(
    draftValue = prompt,
    draftFiles = files,
    options?: {
      onAccepted?: () => void
      context?: WorkbenchComposerContext
      /** 排队发送读取入队快照，不动用户正在编辑的下一条草稿。 */
      queued?: boolean
      /** 目标卡的「继续」：这一轮按目标模式跑，不看输入框里的模式开关（与 Desktop continueGoal 相同）。 */
      goalMode?: boolean
      /**
       * 宿主替用户开的一轮（目标自动续跑）：以系统说明而不是用户消息起头，不动输入框里的草稿、附件和
       * 拾取的元素，也不附带当前文件。
       */
      systemNotice?: { summary: string; detail: string }
    }
  ): Promise<boolean> {
    const submissionKey = runKey(projectRoot, chat.sessionId)
    if (pendingSubmissions.has(submissionKey)) return false
    pendingSubmissions.add(submissionKey)
    try {
      const systemNotice = options?.systemNotice
      // 宿主续跑只接在一轮正常完成之后：运行中进来的话会被当成引导注入，冒充用户发言。
      if (systemNotice && readSession(projectRoot, chat.sessionId)?.status !== 'completed')
        return false
      const text = draftValue.trim()
      const context = snapshotWorkbenchComposerContext(options?.context ?? composerContext)
      const selections = systemNotice ? [] : context.browserSelections
      const referencedFilePaths = systemNotice ? [] : context.selectedFileReferencePaths
      // 运行中补发 = 引导：注入正在执行的这一轮，而不是排到结束后另起一轮（与 Desktop 一致）。
      // 引导通道不带附件（附件由输入框入口改为结束后发送）。
      if (
        canSteerRun &&
        !options?.queued &&
        (text || selections.length > 0 || referencedFilePaths.length > 0) &&
        draftFiles.length === 0
      )
        return await sendRunGuidance(
          text,
          selections,
          appendWorkbenchChatFileReferences(
            context.includedCurrentFilePath ? [context.includedCurrentFilePath] : [],
            referencedFilePaths
          )
        )
      if (
        (!text &&
          draftFiles.length === 0 &&
          selections.length === 0 &&
          referencedFilePaths.length === 0) ||
        shouldBlockStandaloneRunSubmission(chat.status, hasActiveRun, accountSignInPending)
      )
        return false
      if (engine) {
        // 引擎在本机不能用（没装、没登录）：先说清楚，不发出去。还没探到的照常发，失败由引擎报原因。
        if (engineStatus && !engineStatus.available) {
          workbenchMessage.warning({
            title: t('workbench.chatEngineUnavailableTitle', { engine: engineLabel ?? '' }),
            description:
              engineStatus.reason ??
              t('workbench.chatEngineUnavailableDescription', { engine: engineLabel ?? '' }),
          })
          return false
        }
      } else {
        // VelarOS 自己的 Agent：要有模型、登录 VelarOS，托管模型还要在线授权。
        if (!modelConfig.provider.trim() || !modelConfig.model.trim()) {
          workbenchMessage.warning({
            title: t('workbench.chatModelMissingTitle'),
            description: t('workbench.chatModelMissingDescription'),
          })
          return false
        }
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
        if (isStandaloneWorkbenchManagedProviderId(modelConfig.provider)) {
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
      }
      const { images, describedFiles } = await readImageAttachments(draftFiles)
      const attachmentContext = await buildAttachmentContext(describedFiles)
      const currentFileContext =
        context.includedCurrentFilePath && !systemNotice
          ? `Current Workbench file: ${context.includedCurrentFilePath}`
          : ''
      const browserElementContext = formatBrowserElementSelectionsForPrompt(selections)
      // 引用的文件只发路径锚点，内容由 Agent 自己按需去读。
      const fileReferenceContext = formatWorkbenchChatFileReferencesForPrompt(referencedFilePaths)
      if (!systemNotice && !options?.queued) {
        consumeStandaloneChatDraft(submissionKey, { value: draftValue, files: draftFiles, context })
      }
      // 用户亲自发了话：目标自动续跑的连续轮数从头算。
      if (!systemNotice) goalAutoContinueRoundsRef.current.delete(chat.sessionId)
      // 只有正常完成才结束一轮：中止或失败后的下一条消息继续被打断的那一轮，按引导呈现、
      // 与上一轮归在同一组里，而不是另起一轮（与 Desktop 的 shouldContinueInterruptedConversation 一致）。
      const submittingSession = readSession(projectRoot, chat.sessionId)
      if (!submittingSession) return false
      const continuesInterruptedRun = isInterruptedRunStatus(submittingSession.status)
      const previousScope = submittingSession.messages.findLast(
        (message) => message.role === 'user'
      )
      const scope = {
        runId: nextId('run'),
        turnId:
          continuesInterruptedRun && previousScope?.turnId ? previousScope.turnId : nextId('turn'),
      }
      const userMessage: ChatMessage = systemNotice
        ? {
            ...createStandaloneSystemNotice({
              id: nextId('workbench-goal-continue'),
              ...systemNotice,
              timestamp: Date.now(),
              kind: 'goal-continuation',
            }),
            ...scope,
          }
        : {
            ...createTextMessage(
              'user',
              text ||
                draftFiles.map((file) => file.name).join(', ') ||
                describeBrowserElements(selections) ||
                buildFileReferenceDisplayFallback(referencedFilePaths)
            ),
            ...scope,
            ...(continuesInterruptedRun
              ? { conversationKind: 'run-guidance' as const, guidanceStatus: 'sent' as const }
              : { conversationKind: 'turn-input' as const }),
            browserElementSelections: optionalWhen(selections.length > 0, [...selections]),
          }
      const attachmentMetadata = draftFiles.map((file, index) => ({
        id: `${userMessage.id}-attachment-${index}`,
        kind: file.type.startsWith('image/') ? ('image' as const) : ('file' as const),
        name: file.name,
        mediaType: file.type || 'application/octet-stream',
        size: file.size,
        lastModified: file.lastModified,
      }))
      const submittedMessage =
        attachmentMetadata.length > 0
          ? { ...userMessage, attachments: attachmentMetadata }
          : userMessage
      const sessionId = submittingSession.sessionId
      updateSession(projectRoot, sessionId, (state) => ({
        ...state,
        messages: [...state.messages, submittedMessage],
        status: 'running',
        teamPhase: 'creating-task',
        activeTurn: null,
        completedTurns: 0,
        lastError: null,
        connectionRetryAttempt: null,
        connectionRetryMaxAttempts: null,
        connectionRetryMessage: null,
        awaitingInputQuestion: null,
        awaitingConfirmationMessage: null,
        awaitingConfirmationId: null,
        awaitingConfirmationExecutionId: null,
        lastRunStartedAt: Date.now(),
        lastRunFinishedAt: null,
        // 子 Agent 线程随轮次归零：上一轮的 worker 卡留在下一轮只会让人以为它还在跑。
        workerThreads: [],
        revision: state.revision + 1,
      }))
      // 开跑前拍下本轮的工作区检查点，收尾后拿它比出「本轮改动」。
      const runCheckpoint = await captureRunCheckpoint(
        projectRoot,
        sessionId,
        submittingSession.messages.length,
        text || submittedMessage.attachments?.map((attachment) => attachment.name).join(', ') || ''
      )
      const executionModes: WorkbenchExecutionMode[] = [
        ...((options?.goalMode ?? context.goalMode) ? ['goal' as const] : []),
        ...(context.planMode ? ['plan' as const] : []),
      ]
      const run = createActiveRun({
        projectRoot,
        sessionId,
        scope,
        goalMode: executionModes.includes('goal'),
        runChangeCapture: createRunChangeCapture(projectRoot, sessionId, runCheckpoint),
      })
      activeRuns.set(runKey(projectRoot, sessionId), run)
      ensureConversationEventSubscription()
      const inputText = systemNotice
        ? systemNotice.detail
        : [text, currentFileContext, fileReferenceContext, attachmentContext, browserElementContext]
            .filter(Boolean)
            .join('\n\n')
      const runPreferences = readWorkbenchConversationRunPreferences()
      const result = await syncWorkbenchPeerCatalog(projectRoot)
        .then(() =>
          window.velarosWorkbenchConversation.send({
            sessionId,
            projectRoot,
            inputId: submittedMessage.id,
            text: inputText,
            images: optionalWhen(images.length > 0, images),
            locale,
            model: {
              provider: modelConfig.provider,
              model: modelConfig.model.trim(),
              apiKey: modelConfig.apiKey,
              baseURL: modelConfig.baseURL.trim(),
            },
            reasoningLevel: context.reasoningLevel,
            executionModes,
            // 权限确认策略、记忆开关与搜索引擎随每一轮下发：设置页改了立刻对下一轮生效。
            permissionMode: readWorkbenchPermissionConfirmationMode(),
            sandbox: runPreferences.workspaceSandboxEnabled,
            memory: runPreferences.memoryEnabled,
            webSearchEngine: runPreferences.webSearchEngine,
            engine: engine
              ? { id: engine.id, model: resolveWorkbenchEngineModel(engine, engineStatus) }
              : undefined,
          })
        )
        .catch((error: unknown) => ({
          ok: false as const,
          message: error instanceof Error ? error.message : String(error),
        }))
      // 主进程没接纳这条输入：终态通常已经经事件流到了；没到（通道不通、发送前就被拒）就在这里了结这一轮。
      if (!result.ok && findActiveRun(projectRoot, sessionId) === run)
        finishRun(run, {
          kind: 'error',
          message: result.message || t('workbench.chatExecutionFailed'),
        })
      if (result.ok) options?.onAccepted?.()
      return result.ok
    } catch (error) {
      workbenchMessage.warning({
        title: t('workbench.chatExecutionFailed'),
        description: AppError.getMessage(error),
      })
      return false
    } finally {
      pendingSubmissions.delete(submissionKey)
    }
  }

  const lastMessage = chat.messages.at(-1)
  const activeAssistantMessage =
    isActiveChatRun(chat.status) && lastMessage?.role === 'assistant' ? lastMessage : null
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
          ? t('workbench.chatStarterExplainFilePrompt', {
              path: resolveCurrentFileLabel(currentFilePath),
            })
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
  const billingProvider = modelConfig.provider.trim()
  const billingModelId = modelConfig.model.trim()
  // 外部引擎按它自己的账号计费，回答末尾不估 VelarOS 的价。
  const billingModel = useMemo(
    () =>
      !engine && billingProvider && billingModelId
        ? { provider: billingProvider, model: billingModelId }
        : null,
    [billingModelId, billingProvider, engine]
  )
  const conversation = useMemo<ConversationView>(() => {
    // 状态行上「现在在做什么」：限流说明、思考阶段名或正在跑的脚本卡标题。
    const liveActivity = readStandaloneLiveActivity(
      activeAssistantMessage,
      chat.status === 'running' ? chat.connectionRetryMessage : null
    )
    return {
      sessionId: chat.sessionId,
      activeMemberSessionId: chat.sessionId,
      supportsProjectFiles: true,
      messages: [...chat.messages] as ConversationView['messages'],
      messageRunMarkers: [...chat.messageRunMarkers],
      workerThreads: [...chat.workerThreads],
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
        awaitingConfirmationExecutionId: chat.awaitingConfirmationExecutionId,
        awaitingConfirmationId: toOptional(chat.awaitingConfirmationId),
        lastRunFinishedAt: chat.lastRunFinishedAt,
        // 每次模型调用的供应方用量：回答末尾的约价按它算整轮（含全部轮次），不再只数可见问答。
        usageTelemetry: [...chat.usageTelemetry],
      },
      // 等交互时不算在流式输出（与 Desktop 相同）：输入框要能答一句话的提问。
      isStreaming: chat.status === 'running' || chat.status === 'stopping',
      streamingAssistantMessageId: activeAssistantMessage?.id,
      hasStreamingThinkingBlock: liveActivity.hasStreamingThinkingBlock,
      liveTraceSummary: liveActivity.liveTraceSummary,
      runningLabel: t('chat.running'),
      activeProjectRoot: projectRoot,
      workspaceSourceRoot: projectRoot,
      // 回答末尾的约价：按当前选的模型与公开价格目录估算（与 Desktop 相同）。
      billingModel,
      pricingCatalog,
    }
  }, [
    activeAssistantMessage,
    billingModel,
    pricingCatalog,
    chat.lastRunFinishedAt,
    chat.lastRunStartedAt,
    chat.awaitingInputQuestion,
    chat.awaitingConfirmationId,
    chat.awaitingConfirmationExecutionId,
    chat.awaitingConfirmationMessage,
    chat.activeTurn,
    chat.completedTurns,
    chat.connectionRetryAttempt,
    chat.connectionRetryMaxAttempts,
    chat.connectionRetryMessage,
    chat.lastError,
    chat.messageRunMarkers,
    chat.messages,
    chat.sessionId,
    chat.status,
    chat.teamPhase,
    chat.usageTelemetry,
    chat.workerThreads,
    projectRoot,
    t,
  ])
  const isRunActive = isActiveChatRun(chat.status)
  /** 侧边栏决定会话执行体；聊天框只选择当前执行体提供的模型。 */
  const modelSelector = useMemo<ChatComposerControl['modelSelector']>(() => {
    if (engine) {
      const models = engineStatus?.available ? engineStatus.models : []
      return {
        label: t('chat.composerModelSection'),
        hint: engineStatus?.reason ?? t('workbench.chatEngineModelHint', { engine: engineLabel ?? '' }),
        provider: engine.id,
        model: resolveWorkbenchEngineModel(engine, engineStatus) ?? '',
        providers: [{
          value: engine.id,
          label: engineLabel ?? '',
          defaultModel: resolveWorkbenchEngineModel(engine, engineStatus) ?? '',
          models: models.map((model) => ({ value: model.value, label: model.label, description: model.description })),
        }],
        disabled: isRunActive,
        onChange: (provider, model) => {
          if (provider !== engine.id || !models.some((entry) => entry.value === model)) return
          updateSession(projectRoot, chat.sessionId, (state) => ({
            ...state,
            engine: { id: engine.id, model },
            revision: state.revision + 1,
          }))
        },
      }
    }
    const providers =
      !isStandaloneWorkbenchManagedProviderId(modelConfig.provider) || selectedManagedProvider?.enabled
        ? createStandaloneWorkbenchModelSelectorProviders(
            modelConfig.provider,
            modelConfig.model,
            providerCatalog.error ? [] : providerCatalog.catalog?.models ?? [],
            selectedManagedProvider
          )
        : []
    if (providers.length === 0) return undefined
    const providerLabel = providers[0]!.label
    return {
      label: t('chat.composerModelSection'),
      hint: providerCatalog.error
        ? t('workbench.settingsModelCatalogError', { provider: providerLabel, error: providerCatalog.error })
        : providerCatalog.loading
          ? t('workbench.settingsModelCatalogLoading', { provider: providerLabel })
          : undefined,
      provider: modelConfig.provider,
      model: modelConfig.model,
      providers,
      disabled: isRunActive,
      onChange: (provider, model) => {
        if (providers.some((entry) => entry.value === provider && entry.models.some((option) => option.value === model)))
          selectStandaloneWorkbenchAgentModel(provider, model)
      },
    }
  }, [
    chat.sessionId,
    engine,
    engineLabel,
    engineStatus,
    isRunActive,
    modelConfig.model,
    modelConfig.provider,
    projectRoot,
    providerCatalog.catalog,
    providerCatalog.error,
    providerCatalog.loading,
    selectedManagedProvider,
    t,
  ])
  useEffect(() => {
    if (engine || isRunActive || providerCatalog.loading || providerCatalog.error) return
    const provider = modelSelector?.providers.find((entry) => entry.value === modelConfig.provider)
    if (!provider?.models.length || provider.models.some((model) => model.value === modelConfig.model)) return
    selectStandaloneWorkbenchAgentModel(provider.value, provider.defaultModel)
  }, [engine, isRunActive, modelConfig.model, modelConfig.provider, modelSelector, providerCatalog.error, providerCatalog.loading])
  const composerControl = useMemo<ChatComposerControl>(
    () => ({
      scopeKey: chat.sessionId,
      input: {
        input: {
          value: prompt,
          placeholder: resolveWorkbenchChatComposerPlaceholder(askedFilePaths, t, engineLabel),
          // 停止中、等卡片上的回答时不能发；等一句话回答时输入框就是回答。
          disabled:
            chat.status === 'stopping' ||
            isAwaitingConfirmation ||
            (!canSteerRun &&
              !engineRunActive &&
              !isAwaitingInput &&
              shouldBlockStandaloneRunSubmission(chat.status, hasActiveRun, accountSignInPending)),
          onValueChange: setPrompt,
          onSend: (draft) => sendComposerDraft(draft),
        },
        attachments: {
          files,
          onFilesChange: optionalWhen(!isAwaitingInput, setFiles),
          onOpenFile: openAttachedFile,
        },
        queue: {
          canEnqueue: canSteerRun || engineRunActive,
          answering: isAwaitingInput,
          errorMessage: queuedDrafts.errorMessage,
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
                const draft = queuedDrafts.drafts.find((entry) => entry.id === id)
                if (
                  draft &&
                  (await sendRunGuidance(
                    draft.value,
                    draft.context?.browserSelections,
                    appendWorkbenchChatFileReferences(
                      draft.context?.includedCurrentFilePath
                        ? [draft.context.includedCurrentFilePath]
                        : [],
                      draft.context?.selectedFileReferencePaths ?? []
                    ),
                    { queued: true }
                  ))
                )
                  queuedDrafts.remove(id)
              }
            : undefined,
          onQueuedDraftEditingChange: queuedDrafts.setEditingId,
          onQueuedDraftRunNow: queuedDrafts.runNow,
        },
        execution: {
          goalMode,
          onGoalModeChange: setGoalMode,
          planMode,
          onPlanModeChange: setPlanMode,
        },
        thinkingDepth: {
          value: reasoningLevel,
          disabled: isRunActive,
          onChange: (value: ReasoningLevel) => {
            setReasoningLevel(value)
            storeReasoningLevel(value)
          },
        },
        thinkingVisibility: {
          value: showThinkingProcess,
          onChange: setShowThinkingProcess,
        },
        features: {
          // Electron 里没有语音识别服务（与 Desktop 相同）。
          voiceInput: false,
          // 当前文件已经作为引用挂着时只留引用那枚 chip，免得同一个文件出现两次。
          workbenchCurrentFilePath:
            includedCurrentFilePath && !selectedFileReferencePaths.includes(includedCurrentFilePath)
              ? includedCurrentFilePath
              : undefined,
          onDismissWorkbenchCurrentFile: () => setIncludedCurrentFilePath(null),
          mentionables: {
            available: fileReferenceOptions,
            selectedIds: selectedFileReferencePaths.map(workbenchChatFileReferenceId),
            header: t('workbench.chatFileReferencesHeader'),
            deleteLabel: t('workbench.chatFileReferenceForget'),
            onToggleSelected: (id: string, selected: boolean) => {
              const path = readWorkbenchChatFileReferencePath(id)
              if (!path) return
              setSelectedFileReferencePaths((current) =>
                selected
                  ? appendWorkbenchChatFileReferences(current, [path])
                  : current.filter((entry) => entry !== path)
              )
            },
            onDelete: (id: string) => {
              const path = readWorkbenchChatFileReferencePath(id)
              if (!path) return
              setFileReferencePaths((current) => current.filter((entry) => entry !== path))
              setSelectedFileReferencePaths((current) => current.filter((entry) => entry !== path))
            },
          },
          browserElementSelections: browserSelections,
          onRemoveBrowserElementSelection: (id: string) =>
            setBrowserSelections((current) => current.filter((selection) => selection.id !== id)),
        },
        streaming: {
          isStreaming: isRunActive,
          canStop: isRunActive,
          onStop: stop,
        },
      },
      modelSelector,
      slots: {
        // 外部引擎不报上下文用量。
        contextUsageIndicator: engine ? undefined : (
          <WorkbenchContextUsageIndicator usage={chat.contextUsage} />
        ),
      },
    }),
    [
      chat.sessionId,
      chat.status,
      // 每次模型请求后到达一次；漏了它，仪表要等这一轮收尾、status 变了才跟着刷新。
      chat.contextUsage,
      projectRoot,
      accountSignInPending,
      browserSelections,
      composerContext,
      setComposerContext,
      files,
      goalMode,
      hasActiveRun,
      includedCurrentFilePath,
      askedFilePaths,
      fileReferenceOptions,
      selectedFileReferencePaths,
      queuedDrafts.drafts,
      queuedDrafts.drainingId,
      queuedDrafts.errorMessage,
      reasoningLevel,
      modelSelector,
      engine,
      engineLabel,
      engineRunActive,
      onOpenWorkspacePath,
      planMode,
      prompt,
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
      onReviewRound: onReviewRunChanges,
    }),
    [chat.messageRunMarkers, chat.sessionId, onReviewRunChanges, projectRoot]
  )

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
      <WorkbenchConversationEngineContext.Provider value={engine?.id ?? null}>
        <WorkbenchRunChangesScopeContext.Provider value={runChangesScope}>
          <WorkbenchWorkerThreadScopeContext.Provider value={workerThreadScope}>
            <ChatConversationPane
              conversation={conversation}
              conversationRefreshKey={conversationRefreshKey}
              composer={
                <ChatSurfaceComposer
                  key={`${projectRoot}\0${chat.sessionId}`}
                  control={composerControl}
                  variant="side"
                />
              }
              followLocked={followLocked}
              scrollRef={scrollRef}
              scrollNavigatorHidden={scrollNavigatorHidden}
              streamSlot={
                chat.messages.length === 0 ? (
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
                              <span className={styles.workbenchChatStarterTitle}>
                                {suggestion.title}
                              </span>
                              <span className={styles.workbenchChatStarterPrompt}>
                                {suggestion.prompt}
                              </span>
                            </span>
                            <ArrowRightIcon
                              className={styles.workbenchChatStarterArrow}
                              size={13}
                            />
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>
                ) : undefined
              }
              variant="side"
              onAnswerInteraction={answerInteraction}
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
      </WorkbenchConversationEngineContext.Provider>
    </ChatThinkingVisibilityProvider>
  )
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

function createTextMessage(role: ChatMessage['role'], text: string): ChatMessage {
  return {
    id: nextId(`workbench-${role}`),
    role,
    blocks: [{ type: 'text', text }],
    timestamp: Date.now(),
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function isActiveChatRun(status: StandaloneChatState['status']): boolean {
  return (
    status === 'running' ||
    status === 'stopping' ||
    status === 'awaiting-input' ||
    status === 'awaiting-confirmation'
  )
}

/** 上一轮是被打断的（用户停止或执行失败），而不是正常完成。 */
function isInterruptedRunStatus(
  status: StandaloneChatState['status']
): status is 'aborted' | 'failed' {
  return status === 'aborted' || status === 'failed'
}

/**
 * 随消息发出的图片按真实多模态数据交给模型（与 Desktop 相同）；太大或太多的图、别的文件留给附件说明，
 * 由 Agent 按路径自己看。
 */
async function readImageAttachments(files: readonly File[]): Promise<{
  images: WorkbenchConversationImage[]
  describedFiles: File[]
}> {
  const images: WorkbenchConversationImage[] = []
  const describedFiles: File[] = []
  for (const file of files) {
    if (
      !file.type.startsWith('image/') ||
      file.size > MaxImageAttachmentBytes ||
      images.length >= MaxImageAttachments
    ) {
      describedFiles.push(file)
      continue
    }
    try {
      images.push({
        data: encodeBase64(new Uint8Array(await file.arrayBuffer())),
        mediaType: file.type,
        label: file.name,
      })
    } catch {
      describedFiles.push(file)
    }
  }
  return { images, describedFiles }
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunk = 0x8000
  for (let index = 0; index < bytes.length; index += chunk)
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk))
  return btoa(binary)
}

async function buildAttachmentContext(files: readonly File[]): Promise<string> {
  const descriptions = await Promise.all(
    files.map(async (file) => {
      const path = resolveWorkbenchClipboardFilePath(
        file,
        window.velarosWorkbenchProjectHub.getPathForFile
      )
      if (path) return `Attached file: ${path}`
      if (file.size <= 64 * 1_024 && isTextAttachment(file))
        return `Attached file ${file.name}:\n\`\`\`\n${await file.text()}\n\`\`\``
      return `Attached file: ${file.name} (${file.type || 'application/octet-stream'}, ${file.size} bytes)`
    })
  )
  return descriptions.join('\n\n')
}

function isTextAttachment(file: File): boolean {
  return (
    file.type.startsWith('text/') ||
    /\.(?:c|cc|cpp|css|csv|go|h|html|java|js|json|jsx|md|py|rs|sql|toml|ts|tsx|txt|vel|xml|ya?ml)$/iu.test(
      file.name
    )
  )
}

/**
 * 思考力度的本地档位（与 Desktop 同五档）：按**产品**记忆（跨会话保留），换项目、换会话不会把用户刚调好的档
 * 悄悄打回默认。存的不是这五档之一就用默认档。
 */
const WorkbenchReasoningLevels = new Set<ReasoningLevel>(['low', 'medium', 'high', 'xhigh', 'max'])
const DefaultWorkbenchReasoningLevel: ReasoningLevel = 'medium'
const ReasoningLevelStorageKey = 'velaros.workbench.thinking-depth'

function readStoredReasoningLevel(): ReasoningLevel {
  if (typeof window === 'undefined') return DefaultWorkbenchReasoningLevel
  const stored = window.localStorage.getItem(ReasoningLevelStorageKey) ?? ''
  return WorkbenchReasoningLevels.has(stored as ReasoningLevel)
    ? (stored as ReasoningLevel)
    : DefaultWorkbenchReasoningLevel
}

function storeReasoningLevel(level: ReasoningLevel): void {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(ReasoningLevelStorageKey, level)
}

function chatStorageKey(projectRoot: string): string {
  return `velaros.workbench.chat:workbench:${encodeURIComponent(projectRoot)}`
}

/** 已就「历史存不下」提示过的项目根；同一次运行只打扰用户一次。 */
const persistFailureNotified = new Set<string>()

/**
 * 聊天历史落盘是**合并写**（会话权威在 renderer 的 localStorage，主进程数据区镜像一份兜底）。
 *
 * 状态变了只记下「这个项目要写」，一个窗口期内同一项目只写一次；写之前与上次写入比落盘字段，一个都没变
 * （子 Agent 线程、上下文用量、运行阶段这类只在内存里的更新）就不写。一轮结束与新建、切换、归档会话这些
 * 结构性变化立刻写；窗口隐藏或关闭前把没写的补上。
 */
const ChatPersistCoalesceMs = 1_000

const chatPersistence = createCoalescedChatPersistence<{ readonly projectRoot: string }>({
  delayMs: ChatPersistCoalesceMs,
  readSignature: ({ projectRoot }) => [
    getState(projectRoot).sessionId,
    ...readAllStates(projectRoot).flatMap(readPersistedFieldIdentities),
  ],
  write: (_key, { projectRoot }) => writePersistedChatHistory(projectRoot),
})

function persistState(state: StandaloneChatState, options?: { immediate?: boolean }): void {
  if (!state.projectRoot || typeof window === 'undefined') return
  chatPersistence.schedule(stateKey(state.projectRoot), { projectRoot: state.projectRoot }, options)
}

function flushChatPersistence(): void {
  chatPersistence.flush()
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  // 退出、刷新、切到后台前把历史补写掉（localStorage 是同步写，来得及）。
  window.addEventListener('pagehide', flushChatPersistence)
  window.addEventListener('beforeunload', flushChatPersistence)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushChatPersistence()
  })
}

function writePersistedChatHistory(projectRoot: string): void {
  const key = stateKey(projectRoot)
  const activeSessionId = getState(projectRoot).sessionId
  const sessions = readAllStates(projectRoot)
  const payload = JSON.stringify({
    version: 2,
    activeSessionId,
    sessions: sessions.map(serializeStoredState),
  })

  try {
    window.localStorage.setItem(chatStorageKey(projectRoot), payload)
    persistFailureNotified.delete(key)
  } catch (error) {
    // 不中断正在跑的一轮，但绝不静默：日志 + 用户可见提示（每个项目根只提示一次）。
    log.error('聊天历史写入 localStorage 失败', {
      projectRoot,
      messageCount: sessions.reduce((count, session) => count + session.messages.length, 0),
      error,
    })
    if (!persistFailureNotified.has(key)) {
      persistFailureNotified.add(key)
      const locale = readWorkbenchAppLocale()
      workbenchMessage.error({
        title: translateWorkbenchAppMessage(locale, 'chat.historySaveFailedTitle'),
        description: translateWorkbenchAppMessage(locale, 'chat.historySaveFailedDescription'),
      })
    }
  }

  backupChatHistoryToDisk(`workbench\0${key}`, payload)
}

/**
 * 落盘字段的身份：状态按不可变方式更新，字段没换引用就是没变。`revision` 不在里面——它随每次内存更新递增，
 * 只为下次启动接着计数，晚一点写不影响任何东西。
 */
function readPersistedFieldIdentities(state: StandaloneChatState): unknown[] {
  const interrupted = isInterruptedRunStatus(state.status)
  return [
    state.sessionId,
    state.folderId,
    state.messages,
    state.lastRunStartedAt,
    state.lastRunFinishedAt,
    state.status,
    interrupted ? state.lastError : null,
    state.checkpoints,
    state.messageRunMarkers,
    state.contextUsage,
    state.usageTelemetry,
    state.engine,
  ]
}

function serializeStoredState(state: StandaloneChatState): Record<string, unknown> {
  return {
    sessionId: state.sessionId,
    folderId: state.folderId,
    engine: toOptional(state.engine),
    messages: state.messages,
    lastRunStartedAt: state.lastRunStartedAt,
    lastRunFinishedAt: state.lastRunFinishedAt,
    status: state.status,
    lastError: isInterruptedRunStatus(state.status) ? state.lastError : null,
    checkpoints: state.checkpoints,
    messageRunMarkers: state.messageRunMarkers,
    contextUsage: toOptional(state.contextUsage),
    usageTelemetry: optionalWhenLazy(state.usageTelemetry.length > 0, () =>
      serializeStandaloneUsageTelemetry(state.usageTelemetry)
    ),
    revision: state.revision,
  }
}

/**
 * 会话从存储里整个移除：它的检查点与本轮改动记录不再有人看，主进程里它的 Platform 会话数据（上下文、目标、
 * 运行状态）与它起的后台任务一并清掉。
 */
function releaseRemovedSession(session: StandaloneChatState): void {
  forgetStandaloneChatDraft(runKey(session.projectRoot, session.sessionId))
  forgetStandaloneQueuedDrafts(runKey(session.projectRoot, session.sessionId))
  releaseCheckpointRefs(session.projectRoot, session.sessionId, session.checkpoints)
  releaseRunChangeRecords(session.projectRoot, session.sessionId)
  forgetStandaloneChatSession(session.sessionId)
  void window.velarosWorkbenchConversation
    .deleteSession({ sessionId: session.sessionId, projectRoot: session.projectRoot })
    .catch(() => {
      // 释放失败只会在主进程数据区留下一份没人用的会话数据。
    })
}

/** 清掉检查点的影子 ref（超出保留上限的、被删掉的会话的）。 */
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
 * 把本轮改动摘要记到指定会话的运行标记上，同一次更新里撤下这一轮运行中实时采到的那份——面板里同一轮从
 * 「进行中」直接变成已完成，中间不空一拍。null = 标记已不在或不再是已完成。
 */
function attachRunChanges(
  projectRoot: string,
  sessionId: string,
  messageId: string,
  runChanges: WorkbenchChatRunChangesSummary
): ReturnType<typeof attachStandaloneRunChanges> {
  let attached: ReturnType<typeof attachStandaloneRunChanges> = null
  updateSession(projectRoot, sessionId, (state) => {
    attached = attachStandaloneRunChanges(state.messageRunMarkers, messageId, runChanges)
    const settled = withoutLiveRunChanges(state, runChanges.recordId)
    return attached
      ? { ...settled, messageRunMarkers: attached.markers, revision: state.revision + 1 }
      : settled
  })
  return attached
}

/** 撤下这一轮运行中实时采到的改动。 */
function withdrawLiveRunChanges(projectRoot: string, sessionId: string, recordId: string): void {
  updateSession(projectRoot, sessionId, (state) => withoutLiveRunChanges(state, recordId))
}

function withoutLiveRunChanges(state: StandaloneChatState, recordId: string): StandaloneChatState {
  return state.liveRunChanges?.summary.recordId === recordId
    ? { ...state, liveRunChanges: null }
    : state
}

/**
 * 删掉本轮改动的记录文件：被替换掉的记录、被移除的会话（不传 recordIds = 整个会话）。与检查点 ref 一样按
 * 幂等清理，残留文件不影响任何功能。
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
      recordIds: mapDefined(recordIds, (ids) => [...ids]),
    })
    .catch(() => {
      // 同上：清理失败只留下一个没人引用的记录文件。
    })
}

/**
 * 把同一份历史镜像到主进程数据区。
 *
 * localStorage 会被「清除浏览数据」或配额回收整片抹掉，那时这份磁盘副本是唯一残存物。刻意 fire-and-forget：
 * 备份失败只记日志，不弹提示、不影响聊天——它是兜底，不是主路径。分片键按项目根，同一个项目的备份原位
 * 覆盖。
 */
function backupChatHistoryToDisk(key: string, payload: string): void {
  void window.velarosWorkbenchConversation
    .backupHistory({ key, payload })
    .then((result) => {
      if (!result.ok) log.error('聊天历史备份落盘失败', { key, message: result.message })
    })
    .catch((error: unknown) => {
      log.error('聊天历史备份通道不可用', { key, error })
    })
}

function isStoredChatMessage(value: unknown): value is ChatMessage {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return (
    typeof record.id === 'string' &&
    (record.role === 'user' || record.role === 'assistant') &&
    typeof record.timestamp === 'number' &&
    Array.isArray(record.blocks)
  )
}

export const standaloneWorkbenchChatAdapter: WorkbenchChatCompositionAdapter = {
  useProjectRuntime: useStandaloneProjectRuntime,
  SessionSurface: StandaloneWorkbenchChatSessionSurface,
  SessionActions: StandaloneWorkbenchChatSessionActions,
}
