import type { ModelMessage } from 'ai'

import {
  AgentCapabilityEventPublisher,
  type AgentCapabilityExecutionContext,
  type AgentCapabilityRuntime,
  type AgentExecutionConfig,
  ExecutionEventBus,
  normalizeExecutionModes,
} from '@velaros-ai/agent'
import type {
  PermissionConfirmationMode,
  RunProfileSelectionId,
} from '@velaros-ai/agent/protocol'
import {
  ChatRuntimeEvents,
  TERMINAL_STREAM_RUNTIME_STATE_KINDS,
} from '@velaros-ai/agent/protocol'
import { parseAgentCapabilityExecuteEnvelopeV1 } from '@velaros-ai/agent/protocol/agent-capability'
import { Log } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import {
  isWorkbenchAgentEngineId,
  type WorkbenchAgentEngineId,
} from '../../plugins/agent-engines/identity'
import type { WorkbenchAgentPluginRuntime } from '../../plugins/agent-engines/main/WorkbenchAgentPluginRuntime'
import type { WorkbenchAgentExecutionStack } from '../agent/WorkbenchAgentExecutionStack'
import type { WorkbenchProductAnalyticsReporter } from '../analytics/WorkbenchProductAnalyticsReporter'

/** 只认自家产品身份的执行请求。 */
const WorkbenchAgentProductId = 'velaros.workbench'
const WorkbenchTerminalRuntimeKinds = new Set<string>(TERMINAL_STREAM_RUNTIME_STATE_KINDS)

interface WorkbenchAgentExecuteInput {
  executionId: string
  source: { productId: string; sessionId: string; correlationId?: string }
  scopeMetadata: Record<string, unknown>
  messages: ModelMessage[]
  config: WorkbenchAgentConfig
}

type WorkbenchAgentConfig =
  | AgentExecutionConfig
  | {
      engineId: WorkbenchAgentEngineId
      executionModes: ReturnType<typeof normalizeExecutionModes>
      model?: string
    }

/** Workbench v1 只接受 BYOK 模型选择与封闭的目标/计划执行模式轴。 */
function parseWorkbenchAgentConfig(
  config: Readonly<Record<string, unknown>>
): WorkbenchAgentConfig {
  const rawExecutionModes = config.executionModes
  const executionModes = normalizeExecutionModes(
    Array.isArray(rawExecutionModes) ? rawExecutionModes : []
  )
  const engineId = config.engineId
  const externalEngine = isWorkbenchAgentEngineId(engineId)
  const permissionConfirmationMode = config.permissionConfirmationMode
  const runProfile = config.runProfile
  if (
    (!externalEngine && config.modelSelection === undefined) ||
    (engineId !== undefined && !externalEngine) ||
    Object.keys(config).some((key) =>
      externalEngine
        ? key !== 'engineId' && key !== 'executionModes' && key !== 'model'
        : key !== 'modelSelection'
          && key !== 'executionModes'
          && key !== 'permissionConfirmationMode'
          && key !== 'runProfile'
    ) ||
    (externalEngine
      && (permissionConfirmationMode !== undefined || runProfile !== undefined)) ||
    (permissionConfirmationMode !== undefined
      && !isPermissionConfirmationMode(permissionConfirmationMode)) ||
    (runProfile !== undefined && !isRunProfileSelectionId(runProfile)) ||
    (rawExecutionModes !== undefined && !Array.isArray(rawExecutionModes)) ||
    (externalEngine &&
      config.model !== undefined &&
      (typeof config.model !== 'string' || !config.model.trim())) ||
    (Array.isArray(rawExecutionModes) &&
      (executionModes.length !== rawExecutionModes.length ||
        executionModes.some((mode, index) => mode !== rawExecutionModes[index])))
  ) {
    throw new AppError('VALIDATION', 'Workbench Agent config is invalid')
  }
  if (externalEngine)
    return {
      engineId,
      executionModes,
      ...(typeof config.model === 'string' ? { model: config.model.trim() } : {}),
    }
  return {
    modelSelection: config.modelSelection,
    executionModes,
    // 缺席时不写字段：执行栈自己回落默认档，避免在协议层再钉一份默认值。
    ...(permissionConfirmationMode === undefined ? {} : { permissionConfirmationMode }),
    ...(runProfile === undefined ? {} : { runProfile }),
  }
}

/** 运行模式的封闭集；`auto` 表示交给运行时按会话体量自选。 */
function isRunProfileSelectionId(value: unknown): value is RunProfileSelectionId {
  return value === 'auto'
    || value === 'compact'
    || value === 'balanced'
    || value === 'expanded'
}

/** 权限确认策略的封闭集；越界值一律判非法，不做「最接近档位」的猜测。 */
function isPermissionConfirmationMode(value: unknown): value is PermissionConfirmationMode {
  return value === 'standard-open' || value === 'ask-every-time' || value === 'never-ask'
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

  public constructor(
    private readonly stack: WorkbenchAgentExecutionStack,
    private readonly agentEngines?: WorkbenchAgentPluginRuntime,
    private readonly productAnalytics?: WorkbenchProductAnalyticsReporter
  ) {}

  public async execute(
    _scope: unknown,
    rawInput: unknown,
    context: AgentCapabilityExecutionContext
  ): Promise<unknown> {
    const input = parseWorkbenchAgentExecuteInput(rawInput)
    if (input.source.productId !== WorkbenchAgentProductId) {
      throw new Error(`Workbench Agent 不接受来源产品「${input.source.productId}」的执行请求。`)
    }
    const projectRoot =
      typeof input.scopeMetadata.resourceId === 'string' ? input.scopeMetadata.resourceId : null
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
    let terminalEventObserved = false
    const publish = (channel: 'agent' | 'state' | 'debug', payload: unknown): void => {
      if (channel === 'agent') {
        if (isTerminalAgentEvent(payload)) terminalEventObserved = true
        this.productAnalytics?.recordAgentEvent(payload, projectRoot)
      }
      publisher.enqueue(channel, payload)
    }
    const events = new ExecutionEventBus({
      agent: (payload) => publish('agent', payload),
      state: (payload) => publish('state', payload),
      debug: (payload) => publish('debug', payload),
    })
    const ensureTerminalEvent = (
      terminalOutcome: 'completed' | 'aborted' | 'error',
      failure?: unknown
    ): void => {
      if (terminalEventObserved) return
      if (terminalOutcome === 'completed') {
        events.emitRuntime(ChatRuntimeEvents.done())
        return
      }
      if (terminalOutcome === 'aborted') {
        events.emitRuntime(
          ChatRuntimeEvents.aborted(
            readAbortMessage(context.signal),
            input.executionId,
            'EXECUTION_ABORTED'
          )
        )
        return
      }
      const appError = failure === undefined
        ? new AppError('RUNTIME', 'Agent execution failed.')
        : AppError.from(failure, 'RUNTIME')
      events.emitRuntime(
        ChatRuntimeEvents.error(appError.message, appError.code, appError.context)
      )
    }

    this.productAnalytics?.recordRunStarted({
      executionId: input.executionId,
      sessionId: input.source.sessionId,
      projectRoot,
      modelSelection:
        'engineId' in input.config
          ? {
              provider: input.config.engineId,
              model: input.config.model ?? input.config.engineId,
            }
          : input.config.modelSelection,
    })
    let outcome: 'completed' | 'aborted' | 'error' = 'error'
    try {
      if ('engineId' in input.config) {
        if (!this.agentEngines) throw new Error('Workbench Agent 插件运行时未装配。')
        if (!projectRoot?.trim()) throw new Error('外部 Agent 执行需要一个项目根。')
        const result = await this.agentEngines.run({
          executionId: input.executionId,
          engineId: input.config.engineId,
          sessionId: input.source.sessionId,
          projectRoot,
          messages: input.messages,
          executionModes: input.config.executionModes,
          model: input.config.model,
          events,
          abortSignal: context.signal,
        })
        outcome = readRunOutcome(result, context.signal)
        ensureTerminalEvent(outcome)
        return result
      }
      const result = await this.stack.run({
        sessionId: input.source.sessionId,
        executionId: input.executionId,
        projectRoot,
        messages: input.messages,
        config: input.config,
        events,
        abortSignal: context.signal,
      })
      outcome = result.status
      ensureTerminalEvent(outcome)
      return result
    } catch (error) {
      if (context.signal.aborted) {
        outcome = 'aborted'
        ensureTerminalEvent('aborted')
        return { status: 'aborted' }
      }
      outcome = 'error'
      ensureTerminalEvent('error', error)
      throw error
    } finally {
      this.productAnalytics?.recordRunFinished(input.executionId, outcome)
      await publisher.closeAndDrain()
    }
  }

  public dispose(): Promise<void> {
    return Promise.all([
      this.stack.dispose(),
      this.agentEngines?.dispose() ?? Promise.resolve(),
    ]).then(() => undefined)
  }
}

function isTerminalAgentEvent(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const event = value as { readonly type?: unknown; readonly payload?: unknown }
  if (
    event.type !== 'runtime' ||
    typeof event.payload !== 'object' ||
    event.payload === null ||
    Array.isArray(event.payload)
  ) return false
  const kind = (event.payload as { readonly kind?: unknown }).kind
  return typeof kind === 'string' && WorkbenchTerminalRuntimeKinds.has(kind)
}

function readAbortMessage(signal: AbortSignal): string {
  return typeof signal.reason === 'string' && signal.reason.trim()
    ? signal.reason
    : 'Agent execution was aborted.'
}

function readRunOutcome(value: unknown, signal: AbortSignal): 'completed' | 'aborted' | 'error' {
  if (signal.aborted) return 'aborted'
  if (typeof value !== 'object' || value === null) return 'completed'
  const status = (value as { readonly status?: unknown }).status
  return status === 'aborted' ? 'aborted' : status === 'error' ? 'error' : 'completed'
}

export { parseWorkbenchAgentExecuteInput, WorkbenchAgentCapabilityRuntime, WorkbenchAgentProductId }
