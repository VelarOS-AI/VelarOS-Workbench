import type { ConversationWorkerThread } from '@velaros-ai/ui/conversation'
import type { ChatMessage, ContentBlock } from '@velaros-ai/ui/conversation/contracts'

import { asRecord } from './standaloneWorkbenchChatRuntime'

type ToolCallBlock = Extract<ContentBlock, { type: 'tool-call' }>
type ThinkingBlock = Extract<ContentBlock, { type: 'thinking' }>

/**
 * 子 Agent 线程的**渲染投影**。
 *
 * main 侧派发器把每个 worker 的生命周期与输出打成 `worker-thread` 事件流出来。这里按激活
 * （activationId；同一线程被续跑时每次单独成卡，与 Desktop 相同）把事件折成一条线程记录：
 * 状态、阶段、结论照派发器给的收，渲染层不再判断一遍；输出按到达顺序拼成一条对话时间线
 * （文字、思考、工具调用），卡片展开后交给聊天页同一套消息渲染。
 *
 * 事件是经 Kernel 事件桥过来的不透明载荷，因此逐字段按类型收：形状不对的字段当没有，
 * 而不是把 `undefined` 塞进投影里让下游各自兜底。
 */
export interface StandaloneWorkerThreadProjection {
  readonly threads: readonly ConversationWorkerThread[]
}

const EmptyThreads: readonly ConversationWorkerThread[] = Object.freeze([])
/** 累计输出与工具进度共用的上限（与 Desktop 同一口径），超出只留开头。 */
const WorkerThreadTextMaxChars = 8_000
const WorkerThreadTextTruncatedSuffix = '\n...'

export function createEmptyWorkerThreadProjection(): StandaloneWorkerThreadProjection {
  return { threads: EmptyThreads }
}

/** 收敛一条 `worker-thread` 事件；返回新投影，无变化时原样返回以便调用方跳过重渲染。 */
export function applyStandaloneWorkerThreadEvent(
  projection: StandaloneWorkerThreadProjection,
  payload: unknown
): StandaloneWorkerThreadProjection {
  const event = asRecord(payload)
  if (event.kind !== 'worker-thread') return projection
  const threadId = readString(event.threadId)
  if (!threadId) return projection

  const timestamp = readFiniteNumber(event.timestamp) ?? Date.now()
  const activationId = readString(event.activationId)
  const existing = findWorkerThreadActivation(projection.threads, threadId, activationId)
  const resolvedActivationId = activationId ?? existing?.activationId
  // 增量按原样收：单独一个换行或空格也是正文的一部分。
  const text = readRawText(event.text)
  const next: ConversationWorkerThread = {
    threadId,
    taskId: readString(event.taskId) ?? existing?.taskId ?? null,
    nodeId: readString(event.nodeId) ?? existing?.nodeId ?? null,
    title: readString(event.title) ?? existing?.title ?? threadId,
    agentName: readString(event.agentName) ?? existing?.agentName ?? null,
    roleId: readWorkerRoleId(event.roleId) ?? existing?.roleId ?? null,
    phase: readWorkerPhase(event.phase) ?? existing?.phase ?? null,
    status: readWorkerStatus(event.status) ?? existing?.status ?? null,
    workspaceTarget: existing?.workspaceTarget ?? null,
    dag: existing?.dag ?? null,
    subagentType: readString(event.subagentType) ?? existing?.subagentType ?? null,
    customAgentName: readString(event.customAgentName) ?? existing?.customAgentName ?? null,
    mode: readMode(event.mode) ?? existing?.mode ?? null,
    model: readString(event.model) ?? existing?.model ?? null,
    startedAt: existing?.startedAt ?? timestamp,
    updatedAt: timestamp,
    input: readString(event.input) ?? existing?.input ?? null,
    // 文字增量累加成完整输出；结论只增不减：状态事件不带正文，不能把已有输出抹掉。
    output: event.event === 'delta' && text
      ? appendLimitedText(existing?.output ?? null, text)
      : readString(event.text) ?? existing?.output ?? null,
    summary: readString(event.summary)
      ?? readString(asRecord(event.result).summary)
      ?? existing?.summary
      ?? null,
    error: readString(event.error) ?? existing?.error ?? null,
    messages: applyWorkerThreadEventToMessages(
      existing?.messages ?? [],
      event,
      resolvedActivationId ?? threadId,
      timestamp
    ),
  }
  // 可选字段缺值时不写键：投影里不塞 undefined（见文件头）。下面几处块字段同理。
  if (resolvedActivationId) next.activationId = resolvedActivationId

  if (existing && isSameWorkerThread(existing, next)) return projection
  return {
    threads: existing
      ? projection.threads.map((thread) => (thread === existing ? next : thread))
      : [...projection.threads, next],
  }
}

/**
 * 事件归到哪次激活：带 activationId 的按它找（还没登记过的，认领同一线程里尚无 activationId 的那条）；
 * 不带的归到这个线程最近的一次激活，免得一条线程被拆成两张卡。
 */
function findWorkerThreadActivation(
  threads: readonly ConversationWorkerThread[],
  threadId: string,
  activationId: Nullable<string>
): ConversationWorkerThread | undefined {
  if (!activationId) return threads.findLast((thread) => thread.threadId === threadId)
  return threads.find((thread) => thread.activationId === activationId)
    ?? threads.find((thread) => thread.threadId === threadId && !thread.activationId)
}

function isSameWorkerThread(
  left: ConversationWorkerThread,
  right: ConversationWorkerThread
): boolean {
  return left.status === right.status
    && left.phase === right.phase
    && left.title === right.title
    && left.output === right.output
    && left.summary === right.summary
    && left.error === right.error
    && left.model === right.model
    && left.subagentType === right.subagentType
    && left.messages === right.messages
}

/**
 * 时间线：一条助手消息，按事件到达顺序排块。文字增量接在紧邻的文字块后面，思考增量接在紧邻的
 * 思考块后面（中间夹了工具就另起一块，与主链路一致）；工具调用按 toolCallId 就地更新。
 * 通知类事件（自动批准、确认卡）不进时间线：Workbench 主链路也不渲染它们，确认走会话里的确认卡。
 */
function applyWorkerThreadEventToMessages(
  messages: ChatMessage[],
  event: Record<string, unknown>,
  scopeId: string,
  timestamp: number
): ChatMessage[] {
  const chatEvent = asRecord(event.chatEvent)
  const text = readRawText(event.text)
  const error = readString(event.error)
  if (typeof chatEvent.type === 'string')
    return applyWorkerThreadChatEvent(messages, chatEvent, scopeId, timestamp)
  if (event.event === 'delta')
    return text ? appendTextDelta(messages, scopeId, text, timestamp) : messages
  if (text && event.event !== 'status')
    return replaceAssistantText(messages, scopeId, text, timestamp)
  return error ? appendErrorText(messages, scopeId, error, timestamp) : messages
}

function applyWorkerThreadChatEvent(
  messages: ChatMessage[],
  chatEvent: Record<string, unknown>,
  scopeId: string,
  timestamp: number
): ChatMessage[] {
  switch (chatEvent.type) {
    case 'reasoning-delta': {
      const text = readRawText(chatEvent.text)
      return text
        ? appendReasoningDelta(messages, scopeId, text, readString(chatEvent.id), timestamp)
        : messages
    }
    case 'tool-start': {
      const toolCallId = readString(chatEvent.toolCallId)
      const toolName = readString(chatEvent.toolName)
      if (!toolCallId || !toolName || hasToolCall(messages, toolCallId)) return messages
      const block: ToolCallBlock = {
        type: 'tool-call',
        toolCallId,
        toolName,
        args: asRecord(chatEvent.args),
        isRunning: true,
        startedAt: timestamp,
      }
      if (typeof chatEvent.categoryId === 'string')
        block.categoryId = chatEvent.categoryId as ToolCallBlock['categoryId']
      return appendAssistantBlock(messages, scopeId, block, timestamp)
    }
    case 'tool-progress': {
      const chunk = readRawText(chatEvent.chunk)
      if (!chunk) return messages
      return updateToolCall(messages, chatEvent.toolCallId, (block) => ({
        ...block,
        progress: appendLimitedText(block.progress ?? null, chunk),
      }))
    }
    case 'tool-metadata':
      return updateToolCall(messages, chatEvent.toolCallId, (block) => {
        const next: ToolCallBlock = {
          ...block,
          metadata: { ...block.metadata, ...asRecord(chatEvent.metadata) },
        }
        // 事件没带标题时留着块上原有的。
        const title = readString(chatEvent.title)
        if (title) next.title = title
        return next
      })
    case 'tool-done':
      return updateToolCall(messages, chatEvent.toolCallId, (block) => {
        const next: ToolCallBlock = {
          ...block,
          result: chatEvent.result,
          effects: asRecord(chatEvent.effects) as ToolCallBlock['effects'],
          isRunning: false,
          finishedAt: timestamp,
        }
        const error = readString(chatEvent.error)
        if (error) next.error = error
        return next
      })
    default:
      return messages
  }
}

function appendAssistantBlock(
  messages: ChatMessage[],
  scopeId: string,
  block: ContentBlock,
  timestamp: number
): ChatMessage[] {
  const last = messages.at(-1)
  return last?.role === 'assistant'
    ? [...messages.slice(0, -1), { ...last, blocks: [...last.blocks, block], timestamp }]
    : [
        ...messages,
        { id: `${scopeId}:assistant:${messages.length + 1}`, role: 'assistant', blocks: [block], timestamp },
      ]
}

function replaceLastBlock(
  messages: ChatMessage[],
  block: ContentBlock,
  timestamp: number
): ChatMessage[] {
  const last = messages.at(-1)!
  return [...messages.slice(0, -1), { ...last, blocks: [...last.blocks.slice(0, -1), block], timestamp }]
}

function appendTextDelta(
  messages: ChatMessage[],
  scopeId: string,
  text: string,
  timestamp: number
): ChatMessage[] {
  const lastBlock = readLastAssistantBlock(messages)
  return lastBlock?.type === 'text' && lastBlock.tone !== 'error'
    ? replaceLastBlock(messages, { ...lastBlock, text: lastBlock.text + text }, timestamp)
    : appendAssistantBlock(messages, scopeId, { type: 'text', text }, timestamp)
}

function appendReasoningDelta(
  messages: ChatMessage[],
  scopeId: string,
  text: string,
  streamId: Nullable<string>,
  timestamp: number
): ChatMessage[] {
  const lastBlock = readLastAssistantBlock(messages)
  if (lastBlock?.type === 'thinking')
    return replaceLastBlock(messages, { ...lastBlock, text: lastBlock.text + text }, timestamp)
  const block: ThinkingBlock = { type: 'thinking', text }
  if (streamId) block.streamId = streamId
  return appendAssistantBlock(messages, scopeId, block, timestamp)
}

function readLastAssistantBlock(messages: readonly ChatMessage[]): ContentBlock | undefined {
  const last = messages.at(-1)
  return last?.role === 'assistant' ? last.blocks.at(-1) : undefined
}

/** 非增量的正文（整段给出的结论）替换时间线里的第一段文字。 */
function replaceAssistantText(
  messages: ChatMessage[],
  scopeId: string,
  text: string,
  timestamp: number
): ChatMessage[] {
  const last = messages.at(-1)
  const textBlock: ContentBlock = { type: 'text', text }
  if (last?.role !== 'assistant') return appendAssistantBlock(messages, scopeId, textBlock, timestamp)
  const textIndex = last.blocks.findIndex((block) => block.type === 'text')
  const blocks = textIndex < 0
    ? [textBlock, ...last.blocks]
    : last.blocks.map((block, index) => (index === textIndex ? textBlock : block))
  return [...messages.slice(0, -1), { ...last, blocks, timestamp }]
}

/** 失败与瞬时重试都带错误说明；同一句连着来只记一次。 */
function appendErrorText(
  messages: ChatMessage[],
  scopeId: string,
  error: string,
  timestamp: number
): ChatMessage[] {
  const lastBlock = messages.at(-1)?.blocks.at(-1)
  if (lastBlock?.type === 'text' && lastBlock.tone === 'error' && lastBlock.text === error) return messages
  return appendAssistantBlock(messages, scopeId, { type: 'text', text: error, tone: 'error' }, timestamp)
}

function hasToolCall(messages: readonly ChatMessage[], toolCallId: string): boolean {
  return messages.some((message) =>
    message.blocks.some((block) => block.type === 'tool-call' && block.toolCallId === toolCallId)
  )
}

function updateToolCall(
  messages: ChatMessage[],
  toolCallIdValue: unknown,
  updater: (block: ToolCallBlock) => ToolCallBlock
): ChatMessage[] {
  const toolCallId = readString(toolCallIdValue)
  if (!toolCallId || !hasToolCall(messages, toolCallId)) return messages
  return messages.map((message) =>
    message.blocks.some((block) => block.type === 'tool-call' && block.toolCallId === toolCallId)
      ? {
          ...message,
          blocks: message.blocks.map((block) =>
            block.type === 'tool-call' && block.toolCallId === toolCallId ? updater(block) : block
          ),
        }
      : message
  )
}

function appendLimitedText(current: Nullable<string>, text: string): string {
  if (current?.endsWith(WorkerThreadTextTruncatedSuffix) && current.length >= WorkerThreadTextMaxChars)
    return current
  const combined = `${current ?? ''}${text}`
  if (combined.length <= WorkerThreadTextMaxChars) return combined
  return `${combined
    .slice(0, WorkerThreadTextMaxChars - WorkerThreadTextTruncatedSuffix.length)
    .trimEnd()}${WorkerThreadTextTruncatedSuffix}`
}

function readString(value: unknown): Nullable<string> {
  return typeof value === 'string' && value.trim() ? value : null
}

function readRawText(value: unknown): Nullable<string> {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function readFiniteNumber(value: unknown): Nullable<number> {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

const WorkerThreadStatuses = new Set([
  'pending',
  'running',
  'awaiting_confirmation',
  'awaiting_input',
  'completed',
  'failed',
  'aborted',
])

function readWorkerStatus(value: unknown): Nullable<ConversationWorkerThread['status']> {
  return typeof value === 'string' && WorkerThreadStatuses.has(value)
    ? value as NonNullable<ConversationWorkerThread['status']>
    : null
}

function readMode(value: unknown): Nullable<ConversationWorkerThread['mode']> {
  return value === 'sync' || value === 'async' ? value : null
}

/**
 * 角色与阶段在渲染契约里是**封闭集**（UI 包不依赖 agent 包，自持一份镜像）。
 * 越界值当缺席：宿主换了角色表而 UI 还没跟上时，卡片少一行标签，好过把生字符串画上去。
 */
const WorkerThreadRoleIds = new Set([
  'chat',
  'operator',
  'architect',
  'coder',
  'browser',
  'primary-agent',
])

function readWorkerRoleId(value: unknown): Nullable<ConversationWorkerThread['roleId']> {
  return typeof value === 'string' && WorkerThreadRoleIds.has(value)
    ? value as NonNullable<ConversationWorkerThread['roleId']>
    : null
}

const WorkerThreadPhases = new Set([
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

function readWorkerPhase(value: unknown): Nullable<ConversationWorkerThread['phase']> {
  return typeof value === 'string' && WorkerThreadPhases.has(value)
    ? value as NonNullable<ConversationWorkerThread['phase']>
    : null
}
