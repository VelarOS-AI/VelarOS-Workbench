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
  VelarSailMark,
} from '@velaros-ai/ui/conversation'
import {
  type ChatComposerControl,
  ChatSurfaceComposer,
} from '@velaros-ai/ui/conversation/composer'

import type { ChatMessage } from '@shared/contracts'

import styles from '../styles/workbenchPageStyles'

import {
  updateStandaloneWorkbenchModelConfig,
  useStandaloneWorkbenchModelConfig,
} from './standaloneWorkbenchModelConfig'
import { workbenchMessage } from './workbenchMessageHost'

const log = Log.tag('workbench-chat-adapter')

interface StandaloneChatState {
  readonly projectRoot: string
  readonly sessionId: string
  readonly folderId: string
  readonly messages: readonly ChatMessage[]
  readonly status: WorkbenchChatSessionSnapshot['runtime']['status']
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

const states = new Map<string, StandaloneChatState>()
const listeners = new Set<() => void>()
let idSequence = 0

function nextId(prefix: string): string {
  idSequence += 1
  return `${prefix}-${Date.now().toString(36)}-${idSequence.toString(36)}`
}

function resolveCurrentFileLabel(path: string): string {
  const segments = path.replace(/\\/gu, '/').split('/').filter(Boolean)
  return segments.at(-1) ?? path
}

function createState(projectRoot: string): StandaloneChatState {
  const empty: StandaloneChatState = {
    projectRoot,
    sessionId: `workbench-chat:${encodeURIComponent(projectRoot)}`,
    folderId: `workbench-folder:${encodeURIComponent(projectRoot)}`,
    messages: [],
    status: 'idle',
    lastRunStartedAt: null,
    lastRunFinishedAt: null,
    revision: 0,
  }
  if (!projectRoot || typeof window === 'undefined') return empty
  try {
    const raw = window.localStorage.getItem(chatStorageKey(projectRoot))
    if (!raw) return empty
    const stored = JSON.parse(raw) as Partial<StandaloneChatState>
    if (!Array.isArray(stored.messages)) return empty
    return {
      ...empty,
      messages: stored.messages.filter(isStoredChatMessage),
      revision: typeof stored.revision === 'number' ? stored.revision : 0,
      lastRunStartedAt: typeof stored.lastRunStartedAt === 'number'
        ? stored.lastRunStartedAt
        : null,
      lastRunFinishedAt: typeof stored.lastRunFinishedAt === 'number'
        ? stored.lastRunFinishedAt
        : null,
    }
  } catch {
    return empty
  }
}

function getState(projectRoot: string): StandaloneChatState {
  const normalized = projectRoot.trim()
  const existing = states.get(normalized)
  if (existing) return existing
  const created = createState(normalized)
  states.set(normalized, created)
  return created
}

function updateState(
  projectRoot: string,
  updater: (state: StandaloneChatState) => StandaloneChatState
): void {
  const next = updater(getState(projectRoot))
  states.set(projectRoot, next)
  persistState(next)
  for (const listener of listeners) listener()
}

function useStandaloneChatState(projectRoot: string): StandaloneChatState {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => getState(projectRoot),
    () => getState(projectRoot)
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

function useStandaloneProjectRuntime(projectRoot: Nullable<string>): WorkbenchChatProjectRuntime {
  const normalizedRoot = projectRoot?.trim() ?? ''
  const state = useStandaloneChatState(normalizedRoot)
  const snapshot = toSnapshot(state)
  const member = {
    itemId: state.sessionId,
    memberSessionId: state.sessionId,
    title: readStandaloneChatTitle(state),
    workspaceTitle: '',
    workspaceRoot: state.projectRoot,
    updatedAt: state.lastRunFinishedAt ?? state.lastRunStartedAt ?? 0,
    isEmpty: state.messages.length === 0,
    isStreaming: state.status === 'running',
  }
  const group = {
    folderId: state.folderId,
    title: readStandaloneChatTitle(state),
    kind: 'chat' as const,
    surfaceScope: {
      surface: 'workbench' as const,
      projectRoot: state.projectRoot,
    },
    archivedAt: null,
    updatedAt: member.updatedAt,
    memberSessionIds: [state.sessionId],
    activeMemberItemId: state.sessionId,
    members: [member],
  }

  return {
    projectRoot,
    currentSession: snapshot,
    sessions: [snapshot],
    conversationVersion: state.revision,
    browserActivationToken: null,
    sessionList: {
      activeMemberSessionId: state.sessionId,
      activeSessionId: state.folderId,
      deletingSessionId: null,
      diskSessionHydrated: true,
      groups: normalizedRoot ? [group] : [],
      archiveGroups: [],
    },
    actions: {
      addProjectSession: async () => {
        updateState(normalizedRoot, () => createState(normalizedRoot))
        return true
      },
      archiveSession: async () => {
        updateState(normalizedRoot, () => createState(normalizedRoot))
      },
      selectSession: () => undefined,
      startProjectChat: () => state.folderId,
    },
  }
}

function StandaloneWorkbenchChatSessionSurface({
  projectRoot,
  currentFilePath,
}: {
  projectRoot: string
  currentFilePath: Nullable<string>
}): ReactElement {
  const chat = useStandaloneChatState(projectRoot)
  const { t } = useWorkbenchI18n()
  const modelConfig = useStandaloneWorkbenchModelConfig()
  const [prompt, setPrompt] = useState('')
  const [files, setFiles] = useState<File[]>([])
  const [includedCurrentFilePath, setIncludedCurrentFilePath] =
    useState<Nullable<string>>(currentFilePath)
  const [goalMode, setGoalMode] = useState(false)
  const [planMode, setPlanMode] = useState(false)
  const [followLocked, setFollowLocked] = useState(true)
  const [showThinkingProcess, setShowThinkingProcess] = useState(true)
  const scrollRef = useRef<HTMLDivElement>(null)
  const activeExecutionRef = useRef<{
    executionId: string
    sessionCorrelationId: string
  } | null>(null)

  useEffect(() => {
    setIncludedCurrentFilePath(currentFilePath)
  }, [currentFilePath])

  useEffect(() =>
    window.velarosWorkbenchKernel.onAgentExecution((rawEnvelope) => {
      const envelope = rawEnvelope as AgentExecutionEnvelope
      if (
        envelope.protocolVersion !== AgentCapabilityProtocolVersion
        || envelope.sourceProductId !== 'velaros.workbench'
        || envelope.sourceSessionId !== chat.sessionId
      ) return
      const activeExecution = activeExecutionRef.current
      if (
        !activeExecution
        || envelope.executionId !== activeExecution.executionId
        || envelope.sessionCorrelationId !== activeExecution.sessionCorrelationId
      ) return
      const text = readAgentTextDelta(envelope)
      if (text) appendAssistantText(projectRoot, text)
      const terminal = readAgentTerminalEvent(envelope)
      if (terminal?.status === 'completed') {
        finishRun(projectRoot, 'completed')
        activeExecutionRef.current = null
      } else if (terminal?.status === 'aborted') {
        finishRun(projectRoot, 'aborted')
        activeExecutionRef.current = null
      } else if (terminal?.status === 'failed') {
        finishWithError(
          projectRoot,
          terminal.message ?? 'Agent execution failed.'
        )
        activeExecutionRef.current = null
      }
    }), [chat.sessionId, projectRoot])

  async function submit(draftValue = prompt, draftFiles = files): Promise<void> {
    const text = draftValue.trim()
    if ((!text && draftFiles.length === 0) || chat.status === 'running') return
    if (!modelConfig.provider.trim() || !modelConfig.model.trim() || !modelConfig.apiKey.trim()) return
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
    updateState(projectRoot, (state) => ({
      ...state,
      messages: [...state.messages, submittedMessage],
      status: 'running',
      lastRunStartedAt: Date.now(),
      lastRunFinishedAt: null,
      revision: state.revision + 1,
    }))

    // P6：模型运行时已在本进程（BYOK 选择直接进 Agent 执行栈），不再有
    // `model.supports-provider` 这种远端预检——provider 不认识时由执行本身报错。
    const latest = getState(projectRoot)
    const executionId = nextId('workbench-execution')
    const sessionCorrelationId = nextId('workbench-correlation')
    activeExecutionRef.current = { executionId, sessionCorrelationId }
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
          ].filter(Boolean).join('\n\n'),
        })),
        config: {
          modelSelection: {
            provider: modelConfig.provider.trim(),
            model: modelConfig.model.trim(),
            apiKey: modelConfig.apiKey,
            baseURL: modelConfig.baseURL.trim(),
          },
          executionModes: [
            ...(goalMode ? ['goal' as const] : []),
            ...(planMode ? ['plan' as const] : []),
          ],
        },
      },
    })
    if (!result.ok) {
      const executionStillActive =
        activeExecutionRef.current?.executionId === executionId
      activeExecutionRef.current = null
      if (executionStillActive) finishWithError(projectRoot, result.error.message)
      return
    }

    const executionStillActive =
      activeExecutionRef.current?.executionId === executionId
    activeExecutionRef.current = null
    if (!executionStillActive) return
    if (readFinalAgentStatus(result.output) === 'aborted') {
      finishRun(projectRoot, 'aborted')
      return
    }
    updateState(projectRoot, (state) => ({
      ...state,
      messages: hasAssistantReply(state.messages)
        ? state.messages
        : [...state.messages, createTextMessage(
            'assistant',
            readFinalAgentText(result.output) ?? 'Run completed without a text response.'
          )],
      status: 'completed',
      lastRunFinishedAt: Date.now(),
      revision: state.revision + 1,
    }))
  }

  const lastMessage = chat.messages.at(-1)
  const lastError = chat.status === 'failed' && lastMessage?.role === 'assistant'
    ? lastMessage.blocks
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('\n')
    : null
  const activeAssistantMessage = chat.status === 'running' && lastMessage?.role === 'assistant'
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
        activeTurn: chat.status === 'running' ? completedTurns : null,
        completedTurns,
        lastError,
        connectionRetryAttempt: null,
        connectionRetryMaxAttempts: null,
        lastRunStartedAt: chat.lastRunStartedAt,
        awaitingConfirmationMessage: null,
        awaitingInputQuestion: null,
        stickyDockItems: [],
        awaitingConfirmationUserActionCards: [],
        awaitingConfirmationExecutionId: null,
        awaitingConfirmationDetail: null,
        lastRunFinishedAt: chat.lastRunFinishedAt,
        usageTelemetry: [],
      },
      isStreaming: chat.status === 'running',
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
          disabled: chat.status === 'running',
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
          isStreaming: chat.status === 'running',
          canStop: false,
        },
      },
      modelSelector: {
        label: t('chat.composerModelSection'),
        provider: modelConfig.provider,
        model: modelConfig.model,
        providers: [
          {
            value: modelConfig.provider,
            label: modelConfig.provider,
            defaultModel: modelConfig.model,
            models: [{ value: modelConfig.model, label: modelConfig.model }],
          },
        ],
        onChange: (provider, model) =>
          updateStandaloneWorkbenchModelConfig({ provider, model }),
      },
    }),
    [
      chat.sessionId,
      chat.status,
      files,
      goalMode,
      includedCurrentFilePath,
      modelConfig.model,
      modelConfig.provider,
      planMode,
      prompt,
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
              <VelarSailMark
                className={styles.workbenchChatEmptySail}
                decorative
                motion="steady"
                showWindLines={false}
                size="small"
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
        onFollowLockedChange={setFollowLocked}
      />
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

function appendAssistantText(projectRoot: string, text: string): void {
  updateState(projectRoot, (state) => {
    const last = state.messages.at(-1)
    if (last?.role === 'assistant') {
      const previous = last.blocks
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('')
      return {
        ...state,
        messages: [
          ...state.messages.slice(0, -1),
          { ...last, blocks: [{ type: 'text', text: previous + text }] },
        ],
        revision: state.revision + 1,
      }
    }
    return {
      ...state,
      messages: [...state.messages, createTextMessage('assistant', text)],
      revision: state.revision + 1,
    }
  })
}

function finishWithError(projectRoot: string, message: string): void {
  updateState(projectRoot, (state) => ({
    ...state,
    messages: [...state.messages, {
      ...createTextMessage('assistant', message),
      blocks: [{ type: 'text', text: message, tone: 'error' }],
    }],
    status: 'failed',
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

function readAgentTextDelta(record: AgentExecutionEnvelope): string | null {
  if (record.channel !== 'agent') return null
  const payload = readAgentEventPayload(record)
  if (
    payload?.type === 'text-delta'
    && typeof payload.text === 'string'
  ) return payload.text
  return null
}

function readAgentTerminalEvent(
  record: AgentExecutionEnvelope
): { status: 'completed' | 'aborted' | 'failed'; message?: string } | null {
  const payload = readAgentEventPayload(record)
  const kind = payload?.kind ?? payload?.type
  if (kind === 'done') return { status: 'completed' }
  if (kind === 'aborted') return { status: 'aborted' }
  return kind === 'error'
    ? {
        status: 'failed',
        ...(typeof payload?.message === 'string'
          ? { message: payload.message }
          : {}),
      }
    : null
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
  status: Extract<StandaloneChatState['status'], 'completed' | 'aborted'>
): void {
  updateState(projectRoot, (state) => ({
    ...state,
    status,
    lastRunFinishedAt: Date.now(),
    revision: state.revision + 1,
  }))
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

function hasAssistantReply(messages: readonly ChatMessage[]): boolean {
  return messages.at(-1)?.role === 'assistant'
}

function chatStorageKey(projectRoot: string): string {
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
    messages: state.messages,
    lastRunStartedAt: state.lastRunStartedAt,
    lastRunFinishedAt: state.lastRunFinishedAt,
    revision: state.revision,
  })

  try {
    window.localStorage.setItem(chatStorageKey(state.projectRoot), payload)
    persistFailureNotified.delete(state.projectRoot)
  } catch (error) {
    // 不中断正在跑的 Kernel run,但绝不静默:日志 + 用户可见提示(每个项目根只提示一次)。
    log.error('聊天历史写入 localStorage 失败', {
      projectRoot: state.projectRoot,
      messageCount: state.messages.length,
      error,
    })
    if (!persistFailureNotified.has(state.projectRoot)) {
      persistFailureNotified.add(state.projectRoot)
      workbenchMessage.error({
        title: '聊天历史未能保存',
        description:
          '浏览器存储写入失败(可能已满)。当前对话仍可继续,但重启后可能丢失;已尝试写入本地备份。',
      })
    }
  }

  backupChatHistoryToDisk(state.projectRoot, payload)
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
