import type { ModelMessage } from 'ai'

import {
  AgentCapabilityEventPublisher,
  type AgentCapabilityExecutionContext,
  type AgentCapabilityRuntime,
  type AgentExecutionConfig,
  ExecutionEventBus,
} from '@velaros-ai/agent'
import {
  parseAgentCapabilityExecuteEnvelopeV1,
} from '@velaros-ai/agent/protocol/agent-capability'
import { Log } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import type { WorkbenchAgentExecutionStack } from '../agent/WorkbenchAgentExecutionStack'

/** 只认自家产品身份的执行请求。 */
const WorkbenchAgentProductId = 'velaros.workbench'

interface WorkbenchAgentExecuteInput {
  executionId: string
  source: { productId: string; sessionId: string; correlationId?: string }
  scopeMetadata: Record<string, unknown>
  messages: ModelMessage[]
  config: AgentExecutionConfig
}

/** Workbench v1 只接受 BYOK 模型选择；权限、工具面和运行状态均由 Host 装配。 */
function parseWorkbenchAgentConfig(
  config: Readonly<Record<string, unknown>>,
): AgentExecutionConfig {
  if (
    config.modelSelection === undefined
    || Object.keys(config).some((key) => key !== 'modelSelection')
  ) {
    throw new AppError('VALIDATION', 'Workbench Agent config is invalid')
  }
  return { modelSelection: config.modelSelection }
}

/**
 * Workbench 对 Agent domain 已验证信封的产品解释。
 *
 * 版本、身份、上限、字段白名单和 runtime-state 防注入由 `@velaros-ai/agent` 唯一拥有；
 * 本层只补 Workbench 的空 scope 语义和本地执行配置类型。
 */
function parseWorkbenchAgentExecuteInput(input: unknown): WorkbenchAgentExecuteInput {
  const envelope = parseAgentCapabilityExecuteEnvelopeV1(input)

  return {
    executionId: envelope.execution.id,
    source: envelope.execution.source,
    scopeMetadata: envelope.execution.scopeMetadata ?? {},
    messages: [...envelope.messages],
    config: parseWorkbenchAgentConfig(envelope.config),
  }
}

/**
 * 注入进 Kernel `velaros.agent` 能力的 Workbench Agent 运行时。
 *
 * 它是**进程内**执行栈的 Kernel 面适配层：解析 v1 信封 → 把 loop 的事件总线接到 Kernel 事件
 * 桥 → 委托 {@link WorkbenchAgentExecutionStack}。Kernel 侧只看到不透明的 execute 入出参，
 * Agent 会话 / 提示词 / 工具语义仍归 Agent 与本宿主装配。
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
    const publisher = new AgentCapabilityEventPublisher(
      (type, payload) => context.publish(type, payload),
      {
        id: input.executionId,
        source: input.source,
        scopeMetadata: input.scopeMetadata,
      },
      (error) => {
        this.log.debug('Kernel Agent event delivery failed', { error })
      }
    )
    const publish = (channel: 'agent' | 'state' | 'debug', payload: unknown): void => {
      publisher.enqueue(channel, payload)
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
  parseWorkbenchAgentExecuteInput,
  WorkbenchAgentCapabilityRuntime,
  WorkbenchAgentProductId,
}
