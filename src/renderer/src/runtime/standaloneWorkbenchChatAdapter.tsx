import {
  type ReactElement,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import { ArrowRightIcon } from '@phosphor-icons/react'
import type {
  WorkbenchChatCompositionAdapter,
  WorkbenchChatProjectRuntime,
  WorkbenchChatSessionSnapshot,
} from '@renderer/composition'
import { useWorkbenchI18n } from '@renderer/i18n'

import { AgentCapabilityProtocolVersion } from '@velaros-ai/agent/protocol/agent-capability'
import { Log } from '@velaros-ai/core'
import {
  ChatConversationPane,
  ChatThinkingVisibilityProvider,
  type ConversationView,
} from '@velaros-ai/ui/conversation'
import {
  type ChatComposerControl,
  ChatSurfaceComposer,
} from '@velaros-ai/ui/conversation/composer'

import type { ChatMessage, ContentBlock, ToolCallBlock } from '@shared/contracts'
import type { WorkbenchAgentEngineModelCatalog } from '@shared/workbenchAgentMods'

import workbenchAppIconUrl from '../../../../build/icon.svg?url'
import type { WorkbenchChatProviderId } from '../../../plugins/agent-engines/identity'
import styles from '../styles/workbenchPageStyles'

import { createStandaloneWorkbenchConfiguredModelSelectorProviders } from './standaloneWorkbenchModelCatalog'
import {
  selectStandaloneWorkbenchAgentModel,
  useStandaloneWorkbenchModelConfig,
} from './standaloneWorkbenchModelConfig'
import { resolveWorkbenchClipboardFilePath } from './workbenchClipboardFile'
import { workbenchMessage } from './workbenchMessageHost'

const log = Log.tag('workbench-chat-adapter')

interface StandaloneChatState {
  readonly providerId: WorkbenchChatProviderId
  readonly projectRoot: string
  readonly sessionId: string
  readonly folderId: string
  readonly messages: readonly ChatMessage[]
  readonly status: WorkbenchChatSessionSnapshot['runtime']['status']
  readonly awaitingInputQuestion: string | null
  readonly awaitingConfirmationMessage: string | null
  readonly awaitingConfirmationDetail: ConversationView['runtime']['awaitingConfirmationDetail']
  readonly lastRunStartedAt: number | null
  readonly lastRunFinishedAt: number | null
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
}

const states = new Map<string, StandaloneChatState>()
const inactiveStates = new Map<string, StandaloneChatState[]>()
const stateUpdateTargets = new Map<string, string>()
const listeners = new Set<() => void>()
const activeAgentExecutions = new Map<string, ActiveAgentExecution>()
const engineCatalogCache = new Map<string, WorkbenchAgentEngineModelCatalog>()
const engineCatalogRequests = new Map<string, Promise<WorkbenchAgentEngineModelCatalog>>()
let idSequence = 0

function nextId(prefix: string): string {
  idSequence += 1
  return `${prefix}-${Date.now().toString(36)}-${idSequence.toString(36)}`
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
    awaitingInputQuestion: null,
    awaitingConfirmationMessage: null,
    awaitingConfirmationDetail: null,
    lastRunStartedAt: null,
    lastRunFinishedAt: null,
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
  return {
    ...empty,
    sessionId: typeof stored.sessionId === 'string' ? stored.sessionId : empty.sessionId,
    folderId: typeof stored.folderId === 'string' ? stored.folderId : empty.folderId,
    messages: stored.messages.filter(isStoredChatMessage),
    revision: typeof stored.revision === 'number' ? stored.revision : 0,
    lastRunStartedAt: typeof stored.lastRunStartedAt === 'number'
      ? stored.lastRunStartedAt
      : null,
    lastRunFinishedAt: typeof stored.lastRunFinishedAt === 'number'
      ? stored.lastRunFinishedAt
      : null,
  }
}

function useAgentEngineCatalog(
  providerId: WorkbenchChatProviderId
): WorkbenchAgentEngineModelCatalog | null {
  const [catalogRevision, setCatalogRevision] = useState(0)
  const [catalog, setCatalog] = useState<WorkbenchAgentEngineModelCatalog | null>(() =>
    providerId === 'workbench' ? null : engineCatalogCache.get(providerId) ?? null
  )
  useEffect(() => window.velarosWorkbenchAgentMods.onChanged(() => {
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
      ?? window.velarosWorkbenchAgentMods.listAgentEngineModels(providerId).catch((error) => ({
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
  persistState(next)
  for (const listener of listeners) listener()
  return true
}

function useStandaloneChatState(
  projectRoot: string,
  providerId: WorkbenchChatProviderId
): StandaloneChatState {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => getState(projectRoot, providerId),
    () => getState(projectRoot, providerId)
  )
}

function toSnapshot(state: StandaloneChatState): WorkbenchChatSessionSnapshot {
  return {
    id: state.sessionId,
    folderId: state.folderId,
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
    messageRunMarkers: [],
    workerThreads: [],
  }
}

function useStandaloneProjectRuntime(
  projectRoot: Nullable<string>,
  providerId: WorkbenchChatProviderId = 'workbench'
): WorkbenchChatProjectRuntime {
  const normalizedRoot = projectRoot?.trim() ?? ''
  const state = useStandaloneChatState(normalizedRoot, providerId)
  const allStates = readAllStates(normalizedRoot, providerId)
  const snapshots = allStates.map(toSnapshot)
  const groups = allStates.map((candidate) => {
    const member = {
      itemId: candidate.sessionId,
      memberSessionId: candidate.sessionId,
      title: readStandaloneChatTitle(candidate),
      workspaceTitle: '',
      workspaceRoot: candidate.projectRoot,
      updatedAt: candidate.lastRunFinishedAt ?? candidate.lastRunStartedAt ?? 0,
      isEmpty: candidate.messages.length === 0,
      isStreaming: isActiveChatRun(candidate.status),
    }
    return {
      folderId: candidate.folderId,
      title: readStandaloneChatTitle(candidate),
      kind: 'chat' as const,
      surfaceScope: {
        surface: 'workbench' as const,
        projectRoot: candidate.projectRoot,
      },
      archivedAt: null,
      updatedAt: member.updatedAt,
      memberSessionIds: [candidate.sessionId],
      activeMemberItemId: candidate.sessionId,
      members: [member],
    }
  })

  return {
    projectRoot,
    currentSession: toSnapshot(state),
    sessions: snapshots,
    conversationVersion: state.revision,
    browserActivationToken: null,
    sessionList: {
      activeMemberSessionId: state.sessionId,
      activeSessionId: state.folderId,
      deletingSessionId: null,
      diskSessionHydrated: true,
      groups: normalizedRoot ? groups : [],
      archiveGroups: [],
    },
    actions: {
      addProjectSession: async () => {
        const key = stateKey(normalizedRoot, providerId)
        const active = getState(normalizedRoot, providerId)
        const next = createState(normalizedRoot, providerId, false)
        inactiveStates.set(key, [active, ...(inactiveStates.get(key) ?? [])])
        states.set(key, next)
        persistState(next)
        for (const listener of listeners) listener()
        return true
      },
      archiveSession: async (folderId) => {
        const key = stateKey(normalizedRoot, providerId)
        const active = getState(normalizedRoot, providerId)
        const inactive = inactiveStates.get(key) ?? []
        const target = [active, ...inactive].find((candidate) => candidate.folderId === folderId)
        if (!target || isActiveChatRun(target.status)) return
        if (target.sessionId === active.sessionId) {
          const [replacement, ...remaining] = inactive
          const next = replacement ?? createState(normalizedRoot, providerId, false)
          states.set(key, next)
          inactiveStates.set(key, remaining)
          persistState(next)
        } else {
          inactiveStates.set(
            key,
            inactive.filter((candidate) => candidate.sessionId !== target.sessionId)
          )
          persistState(active)
        }
        for (const listener of listeners) listener()
      },
      selectSession: (_folderId, memberSessionId) => {
        activateState(normalizedRoot, providerId, memberSessionId)
      },
      startProjectChat: () => getState(normalizedRoot, providerId).folderId,
    },
  }
}

function StandaloneWorkbenchChatSessionSurface({
  providerId,
  projectRoot,
  currentFilePath,
}: {
  providerId: WorkbenchChatProviderId
  projectRoot: string
  currentFilePath: Nullable<string>
}): ReactElement {
  const chat = useStandaloneChatState(projectRoot, providerId)
  const { t } = useWorkbenchI18n()
  const modelConfig = useStandaloneWorkbenchModelConfig()
  const engineCatalog = useAgentEngineCatalog(providerId)
  const [engineModel, setEngineModel] = useState(() => readStoredEngineModel(providerId))
  const [prompt, setPrompt] = useState('')
  const [files, setFiles] = useState<File[]>([])
  const [includedCurrentFilePath, setIncludedCurrentFilePath] =
    useState<Nullable<string>>(currentFilePath)
  const [goalMode, setGoalMode] = useState(false)
  const [planMode, setPlanMode] = useState(false)
  const [followLocked, setFollowLocked] = useState(true)
  const [showThinkingProcess, setShowThinkingProcess] = useState(true)
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    setIncludedCurrentFilePath(currentFilePath)
  }, [currentFilePath])

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
      withStateUpdateTarget(
        activeExecution.projectRoot,
        activeExecution.providerId,
        activeExecution.sessionId,
        () => {
          applyAgentStreamEvent(
            activeExecution.projectRoot,
            activeExecution.providerId,
            envelope
          )
          applyAgentRuntimeEvent(
            activeExecution.projectRoot,
            activeExecution.providerId,
            envelope
          )
          const terminal = readAgentTerminalEvent(envelope)
          if (terminal?.status === 'completed') {
            finishRun(activeExecution.projectRoot, activeExecution.providerId, 'completed')
            activeAgentExecutions.delete(activeExecution.executionId)
          } else if (terminal?.status === 'aborted') {
            finishRun(activeExecution.projectRoot, activeExecution.providerId, 'aborted')
            activeAgentExecutions.delete(activeExecution.executionId)
          } else if (terminal?.status === 'failed') {
            finishWithError(
              activeExecution.projectRoot,
              activeExecution.providerId,
              terminal.message ?? 'Agent execution failed.'
            )
            activeAgentExecutions.delete(activeExecution.executionId)
          }
        }
      )
    }), [])

  async function stop(): Promise<void> {
    const activeExecution = findActiveExecution(projectRoot, providerId, chat.sessionId)
    if (!activeExecution) return
    await window.velarosWorkbenchKernel.abortAgentExecution({
      executionId: activeExecution.executionId,
    })
  }

  async function submit(draftValue = prompt, draftFiles = files): Promise<void> {
    const text = draftValue.trim()
    if ((!text && draftFiles.length === 0) || isActiveChatRun(chat.status)) return
    if (
      providerId === 'workbench'
      && (!modelConfig.provider.trim() || !modelConfig.model.trim())
    ) {
      workbenchMessage.warning({
        title: t('workbench.chatModelMissingTitle'),
        description: t('workbench.chatModelMissingDescription'),
      })
      return
    }
    if (providerId !== 'workbench' && !engineCatalog) {
      workbenchMessage.warning({
        title: t('workbench.chatEngineLoadingTitle', {
          engine: providerId === 'claude-code' ? 'Claude Code' : 'ChatGPT / Codex',
        }),
        description: t('workbench.chatEngineLoadingDescription'),
      })
      return
    }
    if (providerId !== 'workbench' && engineCatalog && !engineCatalog.available) {
      workbenchMessage.warning({
        title: t('workbench.chatEngineUnavailableTitle', {
          engine: providerId === 'claude-code' ? 'Claude Code' : 'ChatGPT / Codex',
        }),
        description: engineCatalog.reason ?? t('workbench.chatEngineUnavailableDescription'),
      })
      return
    }
    const attachmentContext = await buildAttachmentContext(draftFiles)
    const currentFileContext = includedCurrentFilePath
      ? `Current Workbench file: ${includedCurrentFilePath}`
      : ''
    setPrompt('')
    setFiles([])
    const userMessage = createTextMessage('user', text || draftFiles.map((file) => file.name).join(', '))
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
    updateState(projectRoot, providerId, (state) => ({
      ...state,
      messages: [...state.messages, submittedMessage],
      status: 'running',
      awaitingInputQuestion: null,
      awaitingConfirmationMessage: null,
      awaitingConfirmationDetail: null,
      lastRunStartedAt: Date.now(),
      lastRunFinishedAt: null,
      revision: state.revision + 1,
    }))

    // P6：模型运行时已在本进程（BYOK 选择直接进 Agent 执行栈），不再有
    // `model.supports-provider` 这种远端预检——provider 不认识时由执行本身报错。
    const latest = getState(projectRoot, providerId)
    const executionId = nextId('workbench-execution')
    const sessionCorrelationId = nextId('workbench-correlation')
    const activeExecution: ActiveAgentExecution = {
      executionId,
      sessionCorrelationId,
      sessionId: latest.sessionId,
      projectRoot,
      providerId,
    }
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
        messages: latest.messages.map((message) => ({
          role: message.role,
          content: [
            message.blocks
            .filter((block) => block.type === 'text')
            .map((block) => block.text)
            .join('\n'),
            ...(message.attachments?.length
              ? [message.attachments
                  .map((attachment) => `Attachment: ${attachment.name} (${attachment.mediaType})`)
                  .join('\n')]
              : []),
            ...(message.id === submittedMessage.id
              ? [currentFileContext, attachmentContext].filter(Boolean)
              : []),
          ].filter(Boolean).join('\n\n'),
        })),
        config: {
          ...(providerId === 'workbench'
            ? {
              modelSelection: {
                provider: modelConfig.provider.trim(),
                model: modelConfig.model.trim(),
                apiKey: modelConfig.apiKey,
                baseURL: modelConfig.baseURL.trim(),
              },
            }
            : {
                engineId: providerId,
                ...(engineModel ? { model: engineModel } : {}),
              }),
          executionModes: [
            ...(goalMode ? ['goal' as const] : []),
            ...(planMode ? ['plan' as const] : []),
          ],
        },
      },
    })
    if (!result.ok) {
      const executionStillActive = activeAgentExecutions.delete(executionId)
      if (executionStillActive) {
        withStateUpdateTarget(projectRoot, providerId, activeExecution.sessionId, () => {
          finishWithError(projectRoot, providerId, result.error.message)
        })
      }
      return
    }

    const executionStillActive = activeAgentExecutions.delete(executionId)
    if (!executionStillActive) return
    if (readFinalAgentStatus(result.output) === 'aborted') {
      withStateUpdateTarget(projectRoot, providerId, activeExecution.sessionId, () => {
        finishRun(projectRoot, providerId, 'aborted')
      })
      return
    }
    withStateUpdateTarget(projectRoot, providerId, activeExecution.sessionId, () => {
      updateState(projectRoot, providerId, (state) => ({
        ...state,
        messages: hasAssistantReply(state.messages)
          ? state.messages
          : [...state.messages, createTextMessage(
              'assistant',
              readFinalAgentText(result.output) ?? 'Run completed without a text response.'
            )],
        status: 'completed',
        awaitingInputQuestion: null,
        awaitingConfirmationMessage: null,
        awaitingConfirmationDetail: null,
        lastRunFinishedAt: Date.now(),
        revision: state.revision + 1,
      }))
    })
  }

  const lastMessage = chat.messages.at(-1)
  const lastError = chat.status === 'failed' && lastMessage?.role === 'assistant'
    ? lastMessage.blocks
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('\n')
    : null
  const activeAssistantMessage = isActiveChatRun(chat.status) && lastMessage?.role === 'assistant'
    ? lastMessage
    : null
  const completedTurns = chat.messages.filter((message) => message.role === 'user').length
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
  const conversation = useMemo<ConversationView>(
    () => ({
      sessionId: chat.sessionId,
      activeMemberSessionId: chat.sessionId,
      supportsProjectFiles: true,
      messages: [...chat.messages] as ConversationView['messages'],
      messageRunMarkers: [],
      workerThreads: [],
      runtime: {
        status: chat.status,
        teamPhase: null,
        activeTurn: isActiveChatRun(chat.status) ? completedTurns : null,
        completedTurns,
        lastError,
        connectionRetryAttempt: null,
        connectionRetryMaxAttempts: null,
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
      hasStreamingThinkingBlock: false,
      runningLabel: t('chat.running'),
      activeProjectRoot: projectRoot,
      workspaceSourceRoot: projectRoot,
    }),
    [
      activeAssistantMessage?.id,
      chat.lastRunFinishedAt,
      chat.lastRunStartedAt,
      chat.awaitingInputQuestion,
      chat.awaitingConfirmationDetail,
      chat.awaitingConfirmationMessage,
      chat.messages,
      chat.sessionId,
      chat.status,
      completedTurns,
      lastError,
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
          placeholder: currentFilePath
            ? t('workbench.chatAskAboutFile', { path: currentFilePath })
            : t('workbench.chatPlaceholder'),
          disabled: isActiveChatRun(chat.status),
          onValueChange: setPrompt,
          onSend: (draft) => submit(draft?.value ?? prompt, draft?.files ?? files),
        },
        attachments: {
          files,
          onFilesChange: setFiles,
        },
        execution: {
          goalMode,
          onGoalModeChange: setGoalMode,
          planMode,
          onPlanModeChange: setPlanMode,
        },
        thinkingVisibility: {
          value: showThinkingProcess,
          onChange: setShowThinkingProcess,
        },
        features: {
          workbenchCurrentFilePath: includedCurrentFilePath ?? undefined,
          onDismissWorkbenchCurrentFile: () => setIncludedCurrentFilePath(null),
        },
        streaming: {
          isStreaming: isActiveChatRun(chat.status),
          canStop: true,
          onStop: stop,
        },
      },
      modelSelector: providerId === 'workbench'
        ? {
            label: t('chat.composerModelSection'),
            provider: modelConfig.provider,
            model: modelConfig.model,
            providers: createStandaloneWorkbenchConfiguredModelSelectorProviders(
              modelConfig.provider,
              modelConfig.model
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
      files,
      goalMode,
      includedCurrentFilePath,
      engineCatalog,
      engineModel,
      modelConfig.model,
      modelConfig.provider,
      planMode,
      prompt,
      providerId,
      showThinkingProcess,
      t,
    ]
  )

  return (
    <ChatThinkingVisibilityProvider visible={showThinkingProcess}>
      <ChatConversationPane
        conversation={conversation}
        conversationRefreshKey={chat.revision}
        composer={<ChatSurfaceComposer control={composerControl} variant="side" />}
        followLocked={followLocked}
        scrollRef={scrollRef}
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
            awaitingConfirmationMessage: null,
            awaitingConfirmationDetail: null,
            revision: state.revision + 1,
          }))
        }}
        onFollowLockedChange={setFollowLocked}
      />
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

function applyAgentStreamEvent(
  projectRoot: string,
  providerId: WorkbenchChatProviderId,
  record: AgentExecutionEnvelope
): void {
  if (record.channel !== 'agent') return
  const event = readAgentEventPayload(record)
  if (!event) return
  if (event.type === 'text-delta' && typeof event.text === 'string') {
    appendAssistantText(projectRoot, providerId, event.text)
    return
  }
  if (event.type === 'reasoning-delta' && typeof event.text === 'string') {
    const streamId = typeof event.id === 'string' ? event.id : 'reasoning'
    updateAssistantBlocks(projectRoot, providerId, (blocks) => {
      const index = blocks.findLastIndex(
        (block) => block.type === 'thinking' && block.streamId === streamId
      )
      if (index < 0) return [...blocks, { type: 'thinking', streamId, text: event.text as string }]
      return blocks.map((block, blockIndex) =>
        blockIndex === index && block.type === 'thinking'
          ? { ...block, text: block.text + event.text }
          : block
      )
    })
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
): void {
  const runtime = readAgentRuntimePayload(record)
  if (!runtime) return
  if (runtime.kind === 'awaiting-input' && typeof runtime.question === 'string') {
    const question = runtime.question
    updateState(projectRoot, providerId, (state) => ({
      ...state,
      status: 'awaiting-input',
      awaitingInputQuestion: question,
      awaitingConfirmationMessage: null,
      awaitingConfirmationDetail: null,
      revision: state.revision + 1,
    }))
    return
  }
  if (
    runtime.kind === 'awaiting-confirmation'
    && typeof runtime.confirmationMessage === 'string'
  ) {
    updateState(projectRoot, providerId, (state) => ({
      ...state,
      status: 'awaiting-confirmation',
      awaitingInputQuestion: null,
      awaitingConfirmationMessage: runtime.confirmationMessage as string,
      awaitingConfirmationDetail: readConfirmationDetail(runtime.confirmationDetail),
      revision: state.revision + 1,
    }))
  }
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
    ...state,
    messages: [...state.messages, {
      ...createTextMessage('assistant', message),
      blocks: [{ type: 'text', text: message, tone: 'error' }],
    }],
    status: 'failed',
    awaitingInputQuestion: null,
    awaitingConfirmationMessage: null,
    awaitingConfirmationDetail: null,
    lastRunFinishedAt: Date.now(),
    revision: state.revision + 1,
  }))
}

function createTextMessage(role: ChatMessage['role'], text: string): ChatMessage {
  return {
    id: nextId(`workbench-${role}`),
    role,
    blocks: [{ type: 'text', text }],
    timestamp: Date.now(),
  }
}

function readAgentTerminalEvent(
  record: AgentExecutionEnvelope
): { status: 'completed' | 'aborted' | 'failed'; message?: string } | null {
  const runtimePayload = readAgentRuntimePayload(record) ?? {}
  const kind = runtimePayload.kind ?? runtimePayload.type
  if (kind === 'done') return { status: 'completed' }
  if (kind === 'aborted') return { status: 'aborted' }
  return kind === 'error'
    ? {
        status: 'failed',
        ...(typeof runtimePayload.message === 'string'
          ? { message: runtimePayload.message }
          : {}),
      }
    : null
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
    ...state,
    status,
    awaitingInputQuestion: null,
    awaitingConfirmationMessage: null,
    awaitingConfirmationDetail: null,
    lastRunFinishedAt: Date.now(),
    revision: state.revision + 1,
  }))
}

function isActiveChatRun(status: StandaloneChatState['status']): boolean {
  return status === 'running'
    || status === 'awaiting-input'
    || status === 'awaiting-confirmation'
}

function readFinalAgentText(output: unknown): string | null {
  if (typeof output === 'string' && output.trim()) return output
  if (typeof output !== 'object' || output === null) return null
  const record = output as Record<string, unknown>
  for (const key of ['text', 'outputText', 'response']) {
    if (typeof record[key] === 'string' && record[key].trim()) return record[key]
  }
  return null
}

function readFinalAgentStatus(output: unknown): 'completed' | 'aborted' | null {
  if (typeof output !== 'object' || output === null) return null
  const status = (output as Record<string, unknown>).status
  return status === 'completed' || status === 'aborted' ? status : null
}

function readConfirmationDetail(
  value: unknown
): ConversationView['runtime']['awaitingConfirmationDetail'] {
  const detail = asRecord(value)
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
  }
  if (
    detail.kind === 'mcp-tool-call'
    && typeof detail.serverName === 'string'
    && typeof detail.toolName === 'string'
  ) return {
    kind: 'mcp-tool-call',
    serverName: detail.serverName,
    toolName: detail.toolName,
  }
  return null
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

function readStoredEngineModel(providerId: WorkbenchChatProviderId): string {
  if (providerId === 'workbench' || typeof window === 'undefined') return ''
  return window.localStorage.getItem(`velaros.workbench.engine-model:${providerId}`) ?? ''
}

function storeEngineModel(providerId: WorkbenchChatProviderId, model: string): void {
  if (providerId === 'workbench' || typeof window === 'undefined') return
  window.localStorage.setItem(`velaros.workbench.engine-model:${providerId}`, model)
}

function hasAssistantReply(messages: readonly ChatMessage[]): boolean {
  return messages.at(-1)?.role === 'assistant'
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
function persistState(state: StandaloneChatState): void {
  if (!state.projectRoot || typeof window === 'undefined') return

  const payload = JSON.stringify({
    version: 2,
    activeSessionId: getState(state.projectRoot, state.providerId).sessionId,
    sessions: readAllStates(state.projectRoot, state.providerId).map(serializeStoredState),
  })

  try {
    window.localStorage.setItem(chatStorageKey(state.projectRoot, state.providerId), payload)
    persistFailureNotified.delete(stateKey(state.projectRoot, state.providerId))
  } catch (error) {
    // 不中断正在跑的 Kernel run,但绝不静默:日志 + 用户可见提示(每个项目根只提示一次)。
    log.error('聊天历史写入 localStorage 失败', {
      projectRoot: state.projectRoot,
      messageCount: state.messages.length,
      error,
    })
    const key = stateKey(state.projectRoot, state.providerId)
    if (!persistFailureNotified.has(key)) {
      persistFailureNotified.add(key)
      workbenchMessage.error({
        title: '聊天历史未能保存',
        description:
          '浏览器存储写入失败(可能已满)。当前对话仍可继续,但重启后可能丢失;已尝试写入本地备份。',
      })
    }
  }

  backupChatHistoryToDisk(stateKey(state.projectRoot, state.providerId), payload)
}

function serializeStoredState(state: StandaloneChatState): Record<string, unknown> {
  return {
    providerId: state.providerId,
    sessionId: state.sessionId,
    folderId: state.folderId,
    messages: state.messages,
    lastRunStartedAt: state.lastRunStartedAt,
    lastRunFinishedAt: state.lastRunFinishedAt,
    revision: state.revision,
  }
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
