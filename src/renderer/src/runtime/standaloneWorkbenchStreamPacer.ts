import { TimerScope } from '@velaros-ai/core/utils/TimerScope'
import {
  ChatStreamPacer,
  type ChatStreamPacerEventClass,
  classifyChatStreamStateKind,
} from '@velaros-ai/ui/conversation'

/**
 * Workbench 会话流的**屏显节奏**：与 Desktop 同一个起搏器（`ChatStreamPacer`）、同一套节奏参数。
 *
 * 执行事件到达即入队，正文与思考按字符预算逐帧吐字，工具与结构事件按到达顺序逐帧应用，
 * 干净收尾（done）等积压吐完才落地——输出不再一阵一阵地跳。Workbench 直接消费执行事件
 * （不经 Desktop 的会话流协议），这里只负责把执行事件归到起搏器的几类处置里；状态怎么改
 * 仍由会话 adapter 的应用函数决定。
 *
 * 起搏器的会话键用执行 id：一轮执行一条队列。
 */
export type StandalonePacedStreamEvent =
  /** 一条原样的执行事件（除正文增量外都走这里）。 */
  | { readonly kind: 'envelope'; readonly channel: unknown; readonly payload: Record<string, unknown> }
  /** 起搏器逐帧吐出的一段思考。 */
  | { readonly kind: 'reasoning'; readonly id: string; readonly text: string }

export interface StandaloneStreamPacerPorts {
  applyText: (executionId: string, text: string) => void
  applyEvent: (executionId: string, event: StandalonePacedStreamEvent) => void
  isStreaming: (executionId: string) => boolean
  /** 起搏暂停：窗口在后台时动画帧不走，事件改为按序立即应用，一轮照常收尾。 */
  isSuspended: () => boolean
}

/** 执行事件归到起搏器的哪一类（与 Desktop 会话流事件共用同一张运行状态归类表）。 */
export function classifyStandalonePacedStreamEvent(
  event: StandalonePacedStreamEvent
): ChatStreamPacerEventClass {
  if (event.kind === 'reasoning') return { kind: 'reasoning', id: event.id, text: event.text }

  const runtimeKind = readRuntimeKind(event)
  if (runtimeKind) return { kind: classifyChatStreamStateKind(runtimeKind) }

  const { payload } = event
  switch (payload.type) {
    case 'reasoning-delta':
      return typeof payload.text === 'string'
        ? {
            kind: 'reasoning',
            id: typeof payload.id === 'string' ? payload.id : 'reasoning',
            text: payload.text,
          }
        : { kind: 'structural' }
    case 'tool-start':
    case 'tool-progress':
    case 'tool-metadata':
    case 'tool-done':
      return typeof payload.toolCallId === 'string'
        ? { kind: 'tool', toolCallId: payload.toolCallId }
        : { kind: 'structural' }
    case 'worker-thread':
      return { kind: 'structural', batchKey: 'worker-thread' }
    case 'notice':
      return payload.kind === 'user-action-card' ? { kind: 'immediate' } : { kind: 'structural' }
    default:
      return { kind: 'structural' }
  }
}

/**
 * 运行状态事件的种类：agent 通道上是 `runtime` 事件包着的 payload，其它通道（执行阶段等）
 * 整个载荷就是状态——与会话 adapter 读运行事件的口径一致。
 */
function readRuntimeKind(
  event: Extract<StandalonePacedStreamEvent, { kind: 'envelope' }>
): Nullable<string> {
  const { payload } = event
  if (payload.type === 'runtime') {
    const runtime = payload.payload
    const kind = typeof runtime === 'object' && runtime !== null
      ? (runtime as Record<string, unknown>).kind
      : null
    return typeof kind === 'string' ? kind : null
  }
  if (event.channel === 'agent') return null
  const kind = payload.kind ?? payload.type
  return typeof kind === 'string' ? kind : null
}

export function createStandaloneStreamPacer(
  ports: StandaloneStreamPacerPorts
): ChatStreamPacer<StandalonePacedStreamEvent> {
  return new ChatStreamPacer<StandalonePacedStreamEvent>({
    timers: new TimerScope({ name: 'standaloneStreamPacer' }),
    classifyEvent: classifyStandalonePacedStreamEvent,
    createReasoningEvent: (id, text) => ({ kind: 'reasoning', id, text }),
    applyTextChunk: ports.applyText,
    appendImmediateText: ports.applyText,
    applyDeferredLiveEvent: ports.applyEvent,
    applyImmediateLiveEvent: ports.applyEvent,
    applyCachedEvent: ports.applyEvent,
    isSessionStreaming: ports.isStreaming,
    // 执行事件里的思考本来就是增量，不需要按累计原文去重。
    getReasoningAppendText: (_previous, incoming) => incoming,
    isPacingSuspended: ports.isSuspended,
  })
}
