import type { ModelMessage } from 'ai'

import {
  type AgentCapabilityExecutionContext,
  type AgentCapabilityRuntime,
  type AgentExecutionConfig,
  ExecutionEventBus,
} from '@velaros-ai/agent-runtime'
import { Log } from '@velaros-ai/core'

import type { WorkbenchAgentExecutionStack } from '../agent/WorkbenchAgentExecutionStack'

/** renderer 订阅的 Agent 执行事件类型（与 Desktop 同名，信封形状逐字一致）。 */
const WorkbenchAgentExecutionEventType = 'velaros.agent.execution'
/** 只认自家产品身份的执行请求。 */
const WorkbenchAgentProductId = 'velaros.workbench'

type KernelEventPublish = (type: string, payload: unknown) => Promise<void>

/**
 * 保持 Agent 同步事件总线不受异步订阅者背压，同时给 Kernel 能力一个真实的结束边界。
 *
 * 所有通道共用一条 Promise 尾链，跨通道顺序因此不会漂移。单个订阅者失败被记录后就地截止，
 * 已入队事件继续排空且不产生未处理拒绝；关闭后拒绝迟到生产者并等待已接收队列排完。
 */
class OrderedKernelEventPublisher {
  private tail: Promise<void> = Promise.resolve()
  private accepting = true
  private drainPromise?: Promise<void>

  public constructor(
    private readonly publish: KernelEventPublish,
    private readonly onDeliveryError: (error: unknown) => void
  ) {}

  public enqueue(type: string, payload: unknown): void {
    if (!this.accepting) return

    this.tail = this.tail
      .then(() => this.publish(type, payload))
      .catch((error: unknown) => {
        try {
          this.onDeliveryError(error)
        } catch {
          // 事件诊断本身不得破坏能力结束边界。
        }
      })
  }

  public closeAndDrain(): Promise<void> {
    this.accepting = false
    this.drainPromise ??= this.tail
    return this.drainPromise
  }
}

interface WorkbenchAgentExecuteInput {
  executionId: string
  source: { productId: string; sessionId: string; correlationId?: string }
  scopeMetadata: Record<string, unknown>
  messages: ModelMessage[]
  config: AgentExecutionConfig
}

function requireBoundedIdentifier(value: unknown, label: string, maxLength = 512): string {
  if (
    typeof value !== 'string'
    || value.trim().length === 0
    || value !== value.trim()
    || value.length > maxLength
  ) {
    throw new Error(`${label} is invalid`)
  }
  return value
}

function readRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} is invalid`)
  }
  return value as Record<string, unknown>
}

/**
 * 稳定、产品无关的 Agent 传输信封（v1）。
 *
 * 与 Desktop 的 `parseAgentExecuteEnvelopeV1` 同形：产品身份、执行关联与不透明作用域元数据
 * 留在信封里，Agent 配置仍由注入的运行时解释。信封形状是两宿主的共同契约，不许单边漂。
 */
function parseWorkbenchAgentExecuteInput(input: unknown): WorkbenchAgentExecuteInput {
  const record = readRecord(input, 'Workbench Agent execution input')
  const allowedKeys = new Set(['protocolVersion', 'execution', 'messages', 'config'])
  if (
    record.protocolVersion !== 1
    || Object.keys(record).some((key) => !allowedKeys.has(key))
    || !Array.isArray(record.messages)
    || record.messages.length > 10_000
  ) {
    throw new Error('Workbench Agent execution input is invalid')
  }
  const execution = readRecord(record.execution, 'Workbench Agent execution')
  const source = readRecord(execution.source, 'Workbench Agent execution source')
  const correlationId =
    source.correlationId === undefined
      ? undefined
      : requireBoundedIdentifier(source.correlationId, 'Agent source correlation id')
  const scopeMetadata =
    execution.scopeMetadata === undefined
      ? {}
      : readRecord(execution.scopeMetadata, 'Workbench Agent execution scope metadata')

  return {
    executionId: requireBoundedIdentifier(execution.id, 'Agent execution id'),
    source: {
      productId: requireBoundedIdentifier(source.productId, 'Agent source product id', 128),
      sessionId: requireBoundedIdentifier(source.sessionId, 'Agent source session id'),
      ...(correlationId === undefined ? {} : { correlationId }),
    },
    scopeMetadata,
    messages: record.messages as ModelMessage[],
    config: readRecord(record.config, 'Workbench Agent config') as AgentExecutionConfig,
  }
}

/**
 * 注入进 Kernel `velaros.agent` 能力的 Workbench Agent 运行时。
 *
 * 它是**进程内**执行栈的 Kernel 面适配层：解析 v1 信封 → 把 loop 的事件总线接到 Kernel 事件
 * 桥 → 委托 {@link WorkbenchAgentExecutionStack}。Kernel 侧只看到不透明的 execute 入出参，
 * Agent 会话 / 提示词 / 工具语义仍归 agent-runtime 与本宿主装配。
 */
class WorkbenchAgentCapabilityRuntime implements AgentCapabilityRuntime {
  private readonly log = Log.tag('WorkbenchAgentCapabilityRuntime')

  public constructor(private readonly stack: WorkbenchAgentExecutionStack) {}

  public async execute(
    _scope: unknown,
    rawInput: unknown,
    context: AgentCapabilityExecutionContext
  ): Promise<unknown> {
    const input = parseWorkbenchAgentExecuteInput(rawInput)
    if (input.source.productId !== WorkbenchAgentProductId) {
      throw new Error(`Workbench Agent 不接受来源产品「${input.source.productId}」的执行请求。`)
    }
    const publisher = new OrderedKernelEventPublisher(
      (type, payload) => context.publish(type, payload),
      (error) => {
        this.log.debug('Kernel Agent event delivery failed', { error })
      }
    )
    const publish = (channel: 'agent' | 'state' | 'debug', payload: unknown): void => {
      publisher.enqueue(WorkbenchAgentExecutionEventType, {
        protocolVersion: 1,
        executionId: input.executionId,
        sourceProductId: input.source.productId,
        sourceSessionId: input.source.sessionId,
        ...(input.source.correlationId === undefined
          ? {}
          : { sessionCorrelationId: input.source.correlationId }),
        channel,
        payload,
      })
    }
    const events = new ExecutionEventBus({
      agent: (payload) => publish('agent', payload),
      state: (payload) => publish('state', payload),
      debug: (payload) => publish('debug', payload),
    })

    try {
      return await this.stack.run({
        sessionId: input.source.sessionId,
        projectRoot:
          typeof input.scopeMetadata.resourceId === 'string'
            ? input.scopeMetadata.resourceId
            : null,
        messages: input.messages,
        config: input.config,
        events,
        abortSignal: context.signal,
      })
    } finally {
      await publisher.closeAndDrain()
    }
  }

  public dispose(): Promise<void> {
    return this.stack.dispose()
  }
}

export {
  OrderedKernelEventPublisher,
  parseWorkbenchAgentExecuteInput,
  WorkbenchAgentCapabilityRuntime,
  WorkbenchAgentExecutionEventType,
  WorkbenchAgentProductId,
}
