import {
  type FormEvent,
  type ReactElement,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import type {
  WorkbenchChatCompositionAdapter,
  WorkbenchChatProjectRuntime,
  WorkbenchChatSessionSnapshot,
} from '@renderer/composition'

import type { ChatMessage } from '@shared/contracts'

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
    title: 'Workbench Agent',
    workspaceTitle: state.projectRoot.split('/').at(-1) ?? 'Project',
    workspaceRoot: state.projectRoot,
    updatedAt: state.lastRunFinishedAt ?? state.lastRunStartedAt ?? 0,
    isEmpty: state.messages.length === 0,
    isStreaming: state.status === 'running',
  }
  const group = {
    folderId: state.folderId,
    title: 'Workbench Agent',
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
  const [prompt, setPrompt] = useState('')
  const [provider, setProvider] = useState('openai')
  const [model, setModel] = useState('gpt-4.1')
  const [baseURL, setBaseURL] = useState('https://api.openai.com/v1')
  const [apiKey, setApiKey] = useState('')
  const [error, setError] = useState<string | null>(null)
  const activeExecutionRef = useRef<{
    executionId: string
    sessionCorrelationId: string
  } | null>(null)

  useEffect(() =>
    window.velarosWorkbenchKernel.onAgentExecution((rawEnvelope) => {
      const envelope = rawEnvelope as AgentExecutionEnvelope
      if (
        envelope.protocolVersion !== 1
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

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    const text = prompt.trim()
    if (!text || chat.status === 'running') return
    setError(null)
    setPrompt('')
    const userMessage = createTextMessage('user', text)
    updateState(projectRoot, (state) => ({
      ...state,
      messages: [...state.messages, userMessage],
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
        protocolVersion: 1,
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
          content: message.blocks
            .filter((block) => block.type === 'text')
            .map((block) => block.text)
            .join('\n'),
        })),
        config: {
          modelSelection: {
            provider: provider.trim(),
            model: model.trim(),
            apiKey,
            baseURL: baseURL.trim(),
          },
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

  return (
    <div className="wb_standaloneChatSurface">
      <div className="wb_standaloneChatMessages" aria-live="polite">
        {chat.messages.length === 0 ? (
          <p>Ask the injected VelarOS Agent about this project.</p>
        ) : chat.messages.map((message) => (
          <article key={message.id} data-role={message.role}>
            <strong>{message.role === 'user' ? 'You' : 'Agent'}</strong>
            {message.blocks.filter((block) => block.type === 'text').map((block, index) => (
              <p key={`${message.id}-${index}`}>{block.text}</p>
            ))}
          </article>
        ))}
      </div>
      <form className="wb_standaloneChatComposer" onSubmit={(event) => void submit(event)}>
        <div className="wb_standaloneChatModel">
          <input
            aria-label="Provider"
            value={provider}
            onChange={(event) => setProvider(event.target.value)}
          />
          <input
            aria-label="Model"
            value={model}
            onChange={(event) => setModel(event.target.value)}
          />
          <input
            aria-label="Base URL"
            value={baseURL}
            onChange={(event) => setBaseURL(event.target.value)}
          />
          <input
            aria-label="API key"
            type="password"
            autoComplete="off"
            placeholder="API key (memory only)"
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
          />
        </div>
        <textarea
          aria-label="Message"
          placeholder={currentFilePath
            ? `Ask about ${currentFilePath}`
            : 'Ask the Workbench Agent'}
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
        />
        {error && <p role="alert">{error}</p>}
        <button type="submit" disabled={chat.status === 'running' || !prompt.trim()}>
          {chat.status === 'running' ? 'Running…' : 'Send'}
        </button>
      </form>
    </div>
  )
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

function persistState(state: StandaloneChatState): void {
  if (!state.projectRoot || typeof window === 'undefined') return
  try {
    window.localStorage.setItem(chatStorageKey(state.projectRoot), JSON.stringify({
      messages: state.messages,
      lastRunStartedAt: state.lastRunStartedAt,
      lastRunFinishedAt: state.lastRunFinishedAt,
      revision: state.revision,
    }))
  } catch {
    // Storage quota/corruption must not interrupt an active Kernel run.
  }
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
