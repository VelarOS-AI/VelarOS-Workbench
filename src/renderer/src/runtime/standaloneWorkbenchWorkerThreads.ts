import type { ConversationWorkerThread } from '@velaros-ai/ui/conversation'

import { asRecord } from './standaloneWorkbenchChatRuntime'

/**
 * 子 Agent 线程的**渲染投影**。
 *
 * main 侧派发器把每个 worker 的生命周期打成 `worker-thread` 事件流出来；这里把同一个 threadId
 * 的多条事件折成一行可渲染的线程记录。只做折叠，不做判断——状态、阶段、结论都由派发器给定，
 * 渲染层再解释一遍只会多出一份会漂移的真相。
 *
 * 事件是经 Kernel 事件桥过来的不透明载荷，因此逐字段按类型收：形状不对的字段当没有，
 * 而不是把 `undefined` 塞进投影里让下游各自兜底。
 */
export interface StandaloneWorkerThreadProjection {
  readonly threads: readonly ConversationWorkerThread[]
}

const EmptyThreads: readonly ConversationWorkerThread[] = Object.freeze([])

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
  const existing = projection.threads.find((thread) => thread.threadId === threadId)
  const next: ConversationWorkerThread = {
    threadId,
    ...(readString(event.activationId) ? { activationId: readString(event.activationId)! } : {}),
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
    // 结论只增不减：worker 的最后一条 text 事件之后还会来状态事件，用 ?? 会让结论被后来的
    // 空值抹掉，卡片就变成「跑完了但什么都没说」。
    output: readString(event.text) ?? existing?.output ?? null,
    summary: readString(event.summary) ?? existing?.summary ?? null,
    error: readString(event.error) ?? existing?.error ?? null,
    messages: existing?.messages ?? [],
  }

  if (existing && isSameWorkerThread(existing, next)) return projection
  return {
    threads: existing
      ? projection.threads.map((thread) => (thread.threadId === threadId ? next : thread))
      : [...projection.threads, next],
  }
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
}

function readString(value: unknown): Nullable<string> {
  return typeof value === 'string' && value.trim() ? value : null
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
