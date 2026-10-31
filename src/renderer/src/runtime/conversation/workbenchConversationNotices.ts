import {
  isArray,
  isBoolean,
  isFiniteNumber,
  isPlainObject,
  isPresent,
  isString,
  isUndefined,
} from '@velaros-ai/core'
import type { ConversationWorkerThread } from '@velaros-ai/ui/conversation'
import type {
  ChatMessage,
  ContentBlock,
  InteractionBlock,
  ScriptExecutionBlock,
  TextBlock,
  ThinkingBlock,
  ToolCallBlock,
  WidgetBlock,
} from '@velaros-ai/ui/conversation/contracts'

import {
  ConversationAgentNotice,
  type ConversationAgentProjection,
  ConversationAgentTextMaxChars,
  ConversationInteractionLimits,
  ConversationInteractionNotice,
  type ConversationInteractionProjection,
  ConversationScriptNotice,
  ConversationScriptPreviewLimits,
  type ConversationScriptProjection,
  ConversationScriptSourceMaxChars,
  ConversationTextNotice,
  type ConversationTextProjection,
  ConversationThinkingMaxChars,
  ConversationThinkingNotice,
  type ConversationThinkingProjection,
  ConversationToolCallLimits,
  ConversationToolCallNotice,
  type ConversationToolCallProjection,
  ConversationWidgetLimits,
  ConversationWidgetNotice,
  type ConversationWidgetProjection,
} from '@shared/workbenchConversation'

import { workbenchWorkerTaskTitle } from './workbenchWorkerPresentation'

/**
 * 会话里的正文块：除了 UI 合同的字段，还记着它是哪一回合的哪段正文、是不是还没被协议接纳的预览
 * （与 Desktop 同一套：收尾与重启恢复时预览一律去掉）。
 */
export type WorkbenchConversationTextBlock = TextBlock & {
  segmentId?: string
  turnId?: string
  preview?: boolean
}

/** 一次运行的通知落到会话上的两处：消息（运行消息里的块）与子 Agent 线程。 */
export interface WorkbenchConversationTranscript {
  readonly messages: readonly ChatMessage[]
  readonly workerThreads: readonly ConversationWorkerThread[]
}

/** 新建运行消息时记在它上面的这一轮的界面身份（与用户消息同一组）。 */
export interface WorkbenchConversationRunScope {
  readonly runId?: string
  readonly turnId?: string
  readonly emittedAt?: number
}

type Block = ContentBlock

const ScriptStatuses = [
  'writing',
  'queued',
  'running',
  'succeeded',
  'failed',
  'cancelled',
  'discarded',
]
const ScriptKinds = ['execute', 'observe', 'blobs']
const CallStatuses = ['pending', 'succeeded', 'failed', 'cancelled']
const CallEffects = ['none', 'committed', 'partial', 'unknown']
const AgentStatuses = ['running', 'awaiting_input', 'completed', 'failed', 'aborted']
const InteractionKinds = ['choice', 'form', 'input', 'confirm', 'danger', 'login', 'capability']
const InteractionStatuses = ['pending', 'answered', 'declined', 'expired']
const InteractionFieldKinds = ['text', 'number', 'boolean', 'choice']
/** 脚本卡上每次调用的参数与返回值最多这么长（与 Desktop 相同）。 */
const CallInputMaxChars = ConversationScriptPreviewLimits.inputChars
const CallOutputMaxChars = ConversationScriptPreviewLimits.outputChars

/** 一次运行的全部回合思考、正文、脚本卡与小部件都在这一条助手消息里（与 Desktop 相同）。 */
export function conversationRunMessageId(runId: string): string {
  return `conversation:run:${runId}`
}

/**
 * 运行中的一条通知写进会话：脚本卡、交互卡、小部件、子 Agent 线程、回合思考与正文。别的种类（命令输出、
 * 项目动静）不进会话，由调用方另行处理；形状不对的通知一律忽略。
 */
export function applyWorkbenchConversationNotice(
  transcript: WorkbenchConversationTranscript,
  kind: string,
  payload: unknown,
  scope: WorkbenchConversationRunScope = {}
): WorkbenchConversationTranscript {
  switch (kind) {
    case ConversationTextNotice:
      return isTextProjection(payload) ? applyText(transcript, payload, scope) : transcript
    case ConversationThinkingNotice:
      return isThinkingProjection(payload) ? applyThinking(transcript, payload, scope) : transcript
    case ConversationScriptNotice:
      return isScriptProjection(payload) ? applyScript(transcript, payload, scope) : transcript
    case ConversationWidgetNotice:
      return isWidgetProjection(payload) ? applyWidget(transcript, payload, scope) : transcript
    case ConversationInteractionNotice:
      return isInteractionProjection(payload)
        ? applyInteraction(transcript, payload, scope)
        : transcript
    case ConversationAgentNotice:
      return isAgentProjection(payload) ? applyAgent(transcript, payload) : transcript
    case ConversationToolCallNotice:
      return isToolCallProjection(payload) ? applyToolCall(transcript, payload, scope) : transcript
    default:
      return transcript
  }
}

/** 预览与思考只会变长：比块里现有的字短、又是它前缀的快照已经过时，不回退。 */
function isStaleSnapshot(current: string, incoming: string): boolean {
  return incoming.length < current.length && current.startsWith(incoming)
}

/** 回合正文：preview 原位更新，accepted 转为正式正文，rejected 撤回还没接纳的预览。 */
function applyText(
  transcript: WorkbenchConversationTranscript,
  payload: ConversationTextProjection,
  scope: WorkbenchConversationRunScope
): WorkbenchConversationTranscript {
  return updateRunMessage(transcript, payload.runId, scope, (blocks) => {
    const index = blocks.findIndex(
      (block) =>
        block.type === 'text' && (block as WorkbenchConversationTextBlock).segmentId === payload.id
    )
    const current = index >= 0 ? (blocks[index] as WorkbenchConversationTextBlock) : undefined
    if (payload.phase === 'preview' && current && !current.preview) return blocks
    if (payload.phase === 'preview' && current && isStaleSnapshot(current.text, payload.text))
      return blocks
    if (payload.phase === 'rejected' || !payload.text)
      return current?.preview ? blocks.filter((_, position) => position !== index) : blocks
    const next: WorkbenchConversationTextBlock = {
      type: 'text',
      text: payload.text,
      segmentId: payload.id,
      turnId: payload.turnId,
    }
    if (payload.phase === 'preview') next.preview = true
    return current ? replaceAt(blocks, index, next) : [...blocks, next]
  })
}

/** 回合思考：同一回合的思考整段原位替换；这一回合的响应作废时撤掉。 */
function applyThinking(
  transcript: WorkbenchConversationTranscript,
  payload: ConversationThinkingProjection,
  scope: WorkbenchConversationRunScope
): WorkbenchConversationTranscript {
  return updateRunMessage(transcript, payload.runId, scope, (blocks) => {
    const index = blocks.findIndex(
      (block) => block.type === 'thinking' && block.streamId === payload.id
    )
    if (payload.phase === 'rejected' || !payload.text)
      return index < 0 ? blocks : blocks.filter((_, position) => position !== index)
    const current = index >= 0 ? (blocks[index] as ThinkingBlock).text : undefined
    if (current === payload.text || (current && isStaleSnapshot(current, payload.text)))
      return blocks
    const next: ThinkingBlock = { type: 'thinking', text: payload.text, streamId: payload.id }
    return index >= 0 ? replaceAt(blocks, index, next) : [...blocks, next]
  })
}

/** 脚本卡：同一张卡的编写、执行与结果按 id 原位替换；被撤回的卡移除。标题取脚本第一行注释。 */
function applyScript(
  transcript: WorkbenchConversationTranscript,
  payload: ConversationScriptProjection,
  scope: WorkbenchConversationRunScope
): WorkbenchConversationTranscript {
  const processOutput = payload.processOutput?.slice(0, CallOutputMaxChars)
  const processOutputTruncated =
    !!payload.processOutputTruncated || (payload.processOutput?.length ?? 0) > CallOutputMaxChars
  if (payload.status === 'discarded')
    return updateRunMessage(transcript, payload.runId, scope, (blocks) => {
      const index = blocks.findIndex(
        (item) => item.type === 'script-execution' && item.id === payload.id
      )
      return index < 0 ? blocks : blocks.filter((_, position) => position !== index)
    })
  const block: ScriptExecutionBlock &
    Pick<ConversationScriptProjection, 'language' | 'processOutput' | 'processOutputTruncated'> = {
    type: 'script-execution',
    id: payload.id,
    kind: payload.kind,
    language: payload.language,
    processOutput,
    processOutputTruncated,
    title: readLeadingComment(payload.source) ?? '',
    status: payload.status,
    startedAt: payload.startedAt,
    source: payload.source,
    sourceTruncated: payload.sourceTruncated,
    calls: [
      ...(processOutput
        ? [
            {
              module: payload.language === 'shell' ? 'shell' : 'node',
              operation: 'execute',
              status:
                payload.status === 'writing' ||
                payload.status === 'queued' ||
                payload.status === 'running'
                  ? ('pending' as const)
                  : payload.status,
              effect: 'unknown' as const,
              input: '',
              inputTruncated: false,
              output: processOutput,
              outputTruncated: processOutputTruncated,
            },
          ]
        : []),
      ...payload.calls.map((call) => ({
        module: call.moduleId,
        operation: call.operation,
        status: call.status,
        effect: call.effect,
        input: call.input.slice(0, CallInputMaxChars),
        output: call.output.slice(0, CallOutputMaxChars),
        inputTruncated: call.inputTruncated || call.input.length > CallInputMaxChars,
        outputTruncated: call.outputTruncated || call.output.length > CallOutputMaxChars,
      })),
    ],
    durationMs: payload.durationMs ?? null,
  }
  if (payload.error) block.error = payload.error
  return updateRunMessage(transcript, payload.runId, scope, (blocks) => {
    const index = blocks.findIndex(
      (item) => item.type === 'script-execution' && item.id === payload.id
    )
    return index >= 0 ? replaceAt(blocks, index, block) : [...blocks, block]
  })
}

/** 小部件：按交来的先后接在运行消息后面，同一个小部件原位替换。 */
function applyWidget(
  transcript: WorkbenchConversationTranscript,
  payload: ConversationWidgetProjection,
  scope: WorkbenchConversationRunScope
): WorkbenchConversationTranscript {
  const block: WidgetBlock = {
    type: 'widget',
    id: payload.id,
    title: payload.title,
    code: payload.code,
    height: payload.height,
  }
  return updateRunMessage(transcript, payload.runId, scope, (blocks) => {
    const index = blocks.findIndex((item) => item.type === 'widget' && item.id === payload.id)
    return index >= 0 ? replaceAt(blocks, index, block) : [...blocks, block]
  })
}

/** 外部引擎的工具卡：调用开始时接在运行消息后面，进度与结果按调用身份原位替换。 */
function applyToolCall(
  transcript: WorkbenchConversationTranscript,
  payload: ConversationToolCallProjection,
  scope: WorkbenchConversationRunScope
): WorkbenchConversationTranscript {
  const block: ToolCallBlock = {
    type: 'tool-call',
    toolCallId: payload.id,
    toolName: payload.toolName,
    title: payload.title,
    args: payload.args,
    isRunning: payload.isRunning,
    startedAt: payload.startedAt,
  }
  if (payload.progress) block.progress = payload.progress
  if (payload.result !== undefined) block.result = payload.result
  if (payload.error) block.error = payload.error
  if (payload.finishedAt !== undefined) block.finishedAt = payload.finishedAt
  return updateRunMessage(transcript, payload.runId, scope, (blocks) => {
    const index = blocks.findIndex(
      (item) => item.type === 'tool-call' && item.toolCallId === payload.id
    )
    return index >= 0 ? replaceAt(blocks, index, block) : [...blocks, block]
  })
}

/** 交互卡：请求到达时接在运行消息后面；回答、跳过或失效时按请求身份原位替换。 */
function applyInteraction(
  transcript: WorkbenchConversationTranscript,
  payload: ConversationInteractionProjection,
  scope: WorkbenchConversationRunScope
): WorkbenchConversationTranscript {
  const { runId, ...card } = payload
  const block: InteractionBlock = { type: 'interaction', ...card }
  return updateRunMessage(transcript, runId, scope, (blocks) => {
    const index = blocks.findIndex((item) => item.type === 'interaction' && item.id === card.id)
    return index >= 0 ? replaceAt(blocks, index, block) : [...blocks, block]
  })
}

/**
 * 子 Agent 线程：每次派发或续跑一个，按身份原位替换。线程挂在派发它的脚本卡后面，卡上的标题是任务第一行，
 * 点开看任务与回答。
 */
function applyAgent(
  transcript: WorkbenchConversationTranscript,
  payload: ConversationAgentProjection
): WorkbenchConversationTranscript {
  const previous = transcript.workerThreads.find((item) => item.threadId === payload.id)
  const identity = payload.agentId ?? previous?.taskId ?? payload.id
  const history = transcript.workerThreads.filter((item) => item.taskId === identity)
  // 续跑会回放旧 run；消息时刻属于原 run，不随新的执行卡或刷新时间移动。
  const timestamps = new Map<string, number>()
  let prior: ConversationWorkerThread | undefined
  for (const item of history) {
    for (const message of item.messages)
      timestamps.set(
        message.id,
        Math.min(timestamps.get(message.id) ?? Infinity, message.timestamp)
      )
    if (
      item.threadId !== payload.id &&
      item.startedAt < payload.startedAt &&
      (!prior || item.startedAt > prior.startedAt)
    )
      prior = item
  }
  // 同一 run 可跨激活续答；本次摘要只看激活后的回合，历史详情仍完整保留。
  const groups: Array<NonNullable<ConversationAgentProjection['activity']>> = [[], []]
  for (const item of payload.activity ?? []) {
    const timestamp =
      item.timestamp ??
      timestamps.get(`conversation:run:${item.payload.runId}`) ??
      payload.startedAt
    groups[timestamp < payload.startedAt ? 0 : 1]!.push({ ...item, timestamp })
  }
  const messages: ChatMessage[] = []
  const historicalIds = new Set<string>()
  for (const [index, items] of groups.entries()) {
    let segment: WorkbenchConversationTranscript = { messages: [], workerThreads: [] }
    const times = new Map<string, number>()
    for (const item of items) {
      const id = `conversation:run:${item.payload.runId}`
      times.set(id, Math.min(times.get(id) ?? Infinity, item.timestamp!))
      segment = applyWorkbenchConversationNotice(segment, item.kind, item.payload, {
        emittedAt: item.timestamp!,
      })
    }
    for (const message of segment.messages) {
      if (index === 0) historicalIds.add(message.id)
      messages.push({
        ...message,
        id:
          index === 1 && historicalIds.has(message.id)
            ? `${message.id}:activation:${payload.id}`
            : message.id,
        timestamp: times.get(message.id) ?? 0,
      })
    }
  }
  // 中断任务续上旧历史才沿用标题；完成后复用同一 Agent 的新任务保留新标题。
  const resumesInterrupted =
    prior &&
    (prior.status === 'aborted' || prior.status === 'failed') &&
    prior.messages.some((message) => messages.some((item) => item.id === message.id))
  const thread: ConversationWorkerThread = {
    threadId: payload.id,
    activationId: payload.id,
    taskId: identity,
    nodeId: null,
    title:
      (resumesInterrupted && prior?.title) ||
      previous?.title ||
      workbenchWorkerTaskTitle(payload.task),
    agentName: workerName(transcript.workerThreads, identity),
    roleId: null,
    phase: null,
    status: payload.status,
    workspaceTarget: null,
    dag: null,
    subagentType: payload.profile,
    customAgentName: null,
    mode: null,
    model: payload.model ?? previous?.model ?? null,
    startedAt: payload.startedAt,
    updatedAt: payload.updatedAt,
    input: payload.task,
    output: payload.answer || null,
    summary: null,
    error: payload.error,
    messages,
  }
  if (payload.anchorId) thread.anchorId = payload.anchorId
  const index = transcript.workerThreads.findIndex((item) => item.threadId === payload.id)
  return {
    ...transcript,
    workerThreads:
      index >= 0
        ? transcript.workerThreads.map((item, position) => (position === index ? thread : item))
        : [...transcript.workerThreads, thread],
  }
}

/** 同一子任务续跑复用名字，名称随线程一起持久化。 */
function workerName(threads: readonly ConversationWorkerThread[], identity: string): string {
  const existing = threads.find((thread) => thread.taskId === identity)?.agentName
  if (existing) return existing
  const names = ['Atlas', 'Beacon', 'Cipher', 'Forge', 'Harbor', 'Lumen', 'Nova', 'Orion']
  const used = new Set(threads.map((thread) => thread.agentName))
  for (let index = 0; ; index++) {
    const name =
      names[index % names.length] +
      (index < names.length ? '' : ` ${Math.floor(index / names.length) + 1}`)
    if (!used.has(name)) return name
  }
}

/**
 * 去掉还没被协议接纳的预览：运行消息里标了 preview 的正文块；块清空的消息整条去掉。运行收尾与重启恢复
 * 都经这里。
 */
export function withoutConversationPreviews(messages: readonly ChatMessage[]): ChatMessage[] {
  return messages.flatMap((message) => {
    if (!message.blocks.some(isPreviewBlock)) return [message]
    const blocks = message.blocks.filter((block) => !isPreviewBlock(block))
    return blocks.length === 0 ? [] : [{ ...message, blocks }]
  })
}

/** 运行收尾（或上次停在运行中的会话恢复）时，编写中或执行中的脚本卡不会再有消息，按取消收掉。 */
export function withSettledScripts(messages: readonly ChatMessage[]): ChatMessage[] {
  return messages.map((message) =>
    message.blocks.some(isUnsettledScript)
      ? {
          ...message,
          blocks: message.blocks.map((block): Block =>
            isUnsettledScript(block) ? { ...block, status: 'cancelled' } : block
          ),
        }
      : message
  )
}

/**
 * 运行收尾（或上次停在运行中的会话恢复）时，还在跑的工具卡不会再有结果，按中断收掉；`stoppedText` 是卡上
 * 写的那句「运行已停止。」（按界面语言给）。
 */
export function withSettledToolCalls(
  messages: readonly ChatMessage[],
  stoppedText: string
): ChatMessage[] {
  return messages.map((message) =>
    message.blocks.some(isRunningToolCall)
      ? {
          ...message,
          blocks: message.blocks.map((block): Block =>
            isRunningToolCall(block)
              ? { ...block, isRunning: false, error: block.error ?? stoppedText }
              : block
          ),
        }
      : message
  )
}

/** 还在等回答的交互卡在运行结束后不会再被回答，按失效收掉（main 收尾时也会发，这里兜底）。 */
export function withExpiredInteractions(messages: readonly ChatMessage[]): ChatMessage[] {
  return messages.map((message) =>
    message.blocks.some(isPendingInteraction)
      ? {
          ...message,
          blocks: message.blocks.map((block): Block =>
            isPendingInteraction(block) ? { ...block, status: 'expired' } : block
          ),
        }
      : message
  )
}

/** 同样的收尾：还在跑或等回答的子 Agent 线程不会再有消息，按中断收掉。 */
export function withSettledWorkerThreads(
  threads: readonly ConversationWorkerThread[]
): ConversationWorkerThread[] {
  return threads.map((thread) =>
    thread.status === 'running' || thread.status === 'awaiting_input'
      ? { ...thread, status: 'aborted' as const }
      : thread
  )
}

/** 交互卡上的回答原位写上（输入框答了一句话的提问、卡片自己答的都走这里）。 */
export function withAnsweredInteraction(
  messages: readonly ChatMessage[],
  requestId: string,
  update: (block: InteractionBlock) => InteractionBlock
): ChatMessage[] {
  return messages.map((message) =>
    message.blocks.some((block) => block.type === 'interaction' && block.id === requestId)
      ? {
          ...message,
          blocks: message.blocks.map((block) =>
            block.type === 'interaction' && block.id === requestId ? update(block) : block
          ),
        }
      : message
  )
}

/** 脚本第一行 `//` 注释：模型按宿主说明写的这一步要做什么，界面拿它当脚本卡的标题。 */
export function readLeadingComment(source: string): Nullable<string> {
  for (const line of source.split('\n')) {
    if (!line.trim()) continue
    const match = /^\s*(?:\/\/|#)\s*(.+)$/u.exec(line)
    return match?.[1]?.trim() || null
  }
  return null
}

function isPreviewBlock(block: Block): boolean {
  return block.type === 'text' && !!(block as WorkbenchConversationTextBlock).preview
}

function isUnsettledScript(block: Block): block is ScriptExecutionBlock {
  return (
    block.type === 'script-execution' &&
    (block.status === 'writing' || block.status === 'queued' || block.status === 'running')
  )
}

function isRunningToolCall(block: Block): block is ToolCallBlock {
  return block.type === 'tool-call' && !!block.isRunning
}

function isPendingInteraction(block: Block): block is InteractionBlock {
  return block.type === 'interaction' && block.status === 'pending'
}

function updateRunMessage(
  transcript: WorkbenchConversationTranscript,
  runId: string,
  scope: WorkbenchConversationRunScope,
  update: (blocks: Block[]) => Block[]
): WorkbenchConversationTranscript {
  const id = conversationRunMessageId(runId)
  const existing = transcript.messages.find((message) => message.id === id)
  const current = existing?.blocks ?? []
  const blocks = update(current)
  if (blocks === current) return transcript
  if (existing && blocks.length === 0)
    return {
      ...transcript,
      messages: transcript.messages.filter((message) => message.id !== id),
    }
  if (existing)
    return {
      ...transcript,
      messages: transcript.messages.map((message) =>
        message.id === id ? { ...message, blocks } : message
      ),
    }
  if (blocks.length === 0) return transcript
  const message: ChatMessage = {
    id,
    role: 'assistant',
    conversationKind: 'assistant-output',
    blocks,
    timestamp: scope.emittedAt ?? Date.now(),
  }
  if (scope.runId) message.runId = scope.runId
  if (scope.turnId) message.turnId = scope.turnId
  return { ...transcript, messages: [...transcript.messages, message] }
}

function replaceAt(blocks: Block[], index: number, block: Block): Block[] {
  return blocks.map((item, position) => (position === index ? block : item))
}

// ---------------------------------------------------------------------------------------------
// 通知是进程边界外来的数据：只收形状完整、正文有界的
// ---------------------------------------------------------------------------------------------

function isTextProjection(value: unknown): value is ConversationTextProjection {
  return (
    isPlainObject(value) &&
    isString(value.id) &&
    isString(value.runId) &&
    isString(value.turnId) &&
    (value.phase === 'preview' || value.phase === 'accepted' || value.phase === 'rejected') &&
    isString(value.text)
  )
}

function isThinkingProjection(value: unknown): value is ConversationThinkingProjection {
  return (
    isPlainObject(value) &&
    isString(value.id) &&
    isString(value.runId) &&
    isString(value.turnId) &&
    (value.phase === 'update' || value.phase === 'rejected') &&
    isString(value.text) &&
    value.text.length <= ConversationThinkingMaxChars
  )
}

function isScriptProjection(value: unknown): value is ConversationScriptProjection {
  if (
    !isPlainObject(value) ||
    !isString(value.id) ||
    !value.id.startsWith('conversation:script:') ||
    !ScriptKinds.includes(String(value.kind)) ||
    !(
      !isPresent(value.durationMs) ||
      (isFiniteNumber(value.durationMs) && value.durationMs >= 0)
    ) ||
    !(value.startedAt === undefined || (isFiniteNumber(value.startedAt) && value.startedAt >= 0)) ||
    !isString(value.runId) ||
    !isString(value.turnId) ||
    !ScriptStatuses.includes(String(value.status)) ||
    !isString(value.source) ||
    value.source.length > ConversationScriptSourceMaxChars ||
    !isBoolean(value.sourceTruncated) ||
    !(value.language === undefined || value.language === 'node' || value.language === 'shell') ||
    !(value.processOutput === undefined || isString(value.processOutput)) ||
    !(value.processOutputTruncated === undefined || isBoolean(value.processOutputTruncated)) ||
    !(value.error === null || isString(value.error)) ||
    !isArray(value.calls)
  )
    return false
  return value.calls.every(
    (call) =>
      isPlainObject(call) &&
      isString(call.moduleId) &&
      isString(call.operation) &&
      CallStatuses.includes(String(call.status)) &&
      CallEffects.includes(String(call.effect)) &&
      isString(call.input) &&
      isString(call.output) &&
      isBoolean(call.inputTruncated) &&
      isBoolean(call.outputTruncated)
  )
}

function isAgentProjection(value: unknown): value is ConversationAgentProjection {
  return (
    isPlainObject(value) &&
    isString(value.id) &&
    value.id.startsWith('conversation:agent:') &&
    (value.anchorId === null || isString(value.anchorId)) &&
    isString(value.task) &&
    value.task.length <= ConversationAgentTextMaxChars &&
    isString(value.profile) &&
    (value.agentId === undefined || isString(value.agentId)) &&
    (value.model === undefined || isString(value.model)) &&
    (value.activity === undefined ||
      (isArray(value.activity) &&
        value.activity.every(
          (item) =>
            isPlainObject(item) &&
            (item.timestamp === undefined ||
              (isFiniteNumber(item.timestamp) && item.timestamp >= 0)) &&
            ((item.kind === 'conversation-script' && isScriptProjection(item.payload)) ||
              (item.kind === 'conversation-text' && isTextProjection(item.payload)))
        ))) &&
    AgentStatuses.includes(String(value.status)) &&
    isString(value.answer) &&
    value.answer.length <= ConversationAgentTextMaxChars &&
    (value.error === null || isString(value.error)) &&
    isFiniteNumber(value.startedAt) &&
    isFiniteNumber(value.updatedAt)
  )
}

function isToolCallProjection(value: unknown): value is ConversationToolCallProjection {
  return (
    isPlainObject(value) &&
    isString(value.id) &&
    value.id.startsWith('conversation:tool:') &&
    isString(value.runId) &&
    isString(value.toolName) &&
    isString(value.title) &&
    value.title.length <= ConversationToolCallLimits.titleChars &&
    isPlainObject(value.args) &&
    isBoolean(value.isRunning) &&
    (isUndefined(value.progress) ||
      (isString(value.progress) &&
        value.progress.length <= ConversationToolCallLimits.progressChars)) &&
    (isUndefined(value.error) ||
      (isString(value.error) && value.error.length <= ConversationToolCallLimits.payloadChars)) &&
    isFiniteNumber(value.startedAt) &&
    (isUndefined(value.finishedAt) || isFiniteNumber(value.finishedAt))
  )
}

function isWidgetProjection(value: unknown): value is ConversationWidgetProjection {
  return (
    isPlainObject(value) &&
    isString(value.id) &&
    isString(value.runId) &&
    isString(value.title) &&
    value.title.length <= ConversationWidgetLimits.titleChars &&
    isString(value.code) &&
    value.code.length <= ConversationWidgetLimits.codeChars &&
    isFiniteNumber(value.height) &&
    value.height >= ConversationWidgetLimits.minHeight &&
    value.height <= ConversationWidgetLimits.maxHeight
  )
}

function isInteractionProjection(value: unknown): value is ConversationInteractionProjection {
  return (
    isPlainObject(value) &&
    isString(value.id) &&
    isString(value.runId) &&
    InteractionKinds.includes(String(value.kind)) &&
    InteractionStatuses.includes(String(value.status)) &&
    isString(value.message) &&
    value.message.length <= ConversationInteractionLimits.messageChars &&
    (isUndefined(value.options) || isInteractionOptions(value.options)) &&
    (isUndefined(value.fields) ||
      (isArray(value.fields) &&
        value.fields.every(
          (field) =>
            isPlainObject(field) &&
            isString(field.id) &&
            isString(field.label) &&
            InteractionFieldKinds.includes(String(field.kind)) &&
            (isUndefined(field.options) || isInteractionOptions(field.options))
        ))) &&
    (isUndefined(value.operation) ||
      (isPlainObject(value.operation) && isString(value.operation.label))) &&
    (isUndefined(value.answer) || isPlainObject(value.answer))
  )
}

function isInteractionOptions(value: unknown): boolean {
  return (
    isArray(value) &&
    value.every((option) => isPlainObject(option) && isString(option.id) && isString(option.label))
  )
}
