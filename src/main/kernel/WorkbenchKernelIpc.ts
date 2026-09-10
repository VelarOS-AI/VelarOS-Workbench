import { createHash } from 'node:crypto'
import { rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import {
  BrowserWindow,
  ipcMain,
  type IpcMainInvokeEvent,
  type WebContents,
} from 'electron'

import {
  type ActiveContextArtifact,
  type ChatGoalLifecycleAction,
  ChatRuntimeEvents,
} from '@velaros-ai/agent/protocol'
import {
  type AgentCapabilityExecutionDescriptorV1,
  type AgentCapabilityExecutionEventEnvelopeV1,
  AgentCapabilityExecutionEventType,
  AgentCapabilityProtocolVersion,
  createAgentCapabilityExecutionEventEnvelopeV1,
  parseAgentCapabilityExecuteEnvelopeV1,
} from '@velaros-ai/agent/protocol/agent-capability'
import { type TimerLease, TimerScope } from '@velaros-ai/core/utils/TimerScope'
import {
  type ScopeRef,
  UnknownKernelCapabilityOperationError,
} from '@velaros-ai/kernel/contracts/abi'
import {
  type Kernel,
  KernelCapabilityPermissionDeniedError,
  KernelCapabilityUnavailableError,
} from '@velaros-ai/kernel/runtime'

import type { WorkbenchAgentUiResponse } from '../../shared/workbenchAgentUi'
import type {
  WorkbenchChatHistoryBackupResult,
  WorkbenchGoalLifecycleResult,
  WorkbenchKernelCapabilityStatus,
  WorkbenchKernelInvocationError,
  WorkbenchKernelInvokeRequest,
  WorkbenchKernelInvokeResult,
  WorkbenchKernelRuntimeState,
  WorkbenchKernelStatus,
} from '../../shared/workbenchKernel'
import { WorkbenchKernelChannels } from '../../shared/workbenchKernel'
import { type WorkbenchAppStoragePaths } from '../workspace/StoragePaths'

import {
  parseWorkbenchKernelInvokeRequest,
  type WorkbenchKernelCapabilityRoutes,
} from './WorkbenchKernelProtocol'

export type {
  WorkbenchKernelCapabilityAddress,
  WorkbenchKernelCapabilityRoutes,
} from './WorkbenchKernelProtocol'

const DEFAULT_AGENT_ABORT_SETTLEMENT_GRACE_MS = 1_500
const MAX_CLOSED_AGENT_EXECUTION_IDS = 128

interface WorkbenchKernelIpcOptions {
  /** Abort 已受理、但底层执行没有自行收尾时，Host 最多等待多久。 */
  abortSettlementGraceMs?: number
  /** 运行中补发引导；未注入时一律回 false（renderer 会按普通消息处理）。 */
  provideAgentGuidance?: (request: {
    sessionId: string
    inputId: string
    text: string
  }) => boolean
  /** 会话目标的读写（目标卡）；未注入时读到的一律是「没有目标」。 */
  goalLifecycle?: {
    get: (sessionId: string) => Promise<ActiveContextArtifact | null>
    update: (sessionId: string, action: ChatGoalLifecycleAction) => Promise<ActiveContextArtifact>
  }
  /** 会话被移除时释放主进程里它的执行装配与活动上下文。 */
  releaseAgentSession?: (sessionId: string) => Promise<void>
  /** Agent 界面请求（`workbench:*` 工具）的回执；返回是否结算了一条还在等的请求。 */
  resolveAgentUiRequest?: (response: WorkbenchAgentUiResponse) => boolean
}

interface ActiveAgentExecution {
  readonly controller: AbortController
  readonly descriptor: AgentCapabilityExecutionDescriptorV1
  readonly generation: number
  readonly ownerWebContentsId: number
  readonly controlSettlement: Promise<AgentControlSettlement>
  readonly settleFromControl: (settlement: AgentControlSettlement) => void
  abortSettlementLease: TimerLease | null
  abortRequested: boolean
  terminalStatus: AgentControlSettlement['output']['status'] | null
}

interface AgentControlSettlement {
  readonly type: 'control'
  readonly output: { readonly status: 'completed' | 'aborted' | 'error' }
}

interface AgentExecutionOwnerLifecycle {
  readonly sender: WebContents
  readonly handleDestroyed: () => void
}

type SyntheticAgentTerminal = 'stop-settlement-timeout' | null

/**
 * 进程内 Kernel 的 renderer 面。
 *
 * 与 daemon 时代的区别只有传输层：路由表仍由组合根注入（renderer 永远不给裸 capabilityId），
 * 状态仍是可订阅投影，Agent 执行事件仍走 `velaros.agent.execution` 并只回送发起窗口。没有连接/重试语义——
 * 进程内 host 起即在，起不来就是 degraded，重试等于重启应用。
 */
export function registerWorkbenchKernelIpc(
  runtime: Kernel,
  routes: WorkbenchKernelCapabilityRoutes,
  storagePaths: WorkbenchAppStoragePaths,
  resolveAgentInput: (sessionId: string, answer: string) => boolean,
  resolveAgentConfirmation: (
    sessionId: string,
    approved: boolean,
    rejectionMessage?: string
  ) => boolean,
  options: WorkbenchKernelIpcOptions = {}
): () => void {
  const timers = new TimerScope({ name: 'WorkbenchKernelIpc' })
  const abortSettlementGraceMs = Math.max(
    0,
    options.abortSettlementGraceMs ?? DEFAULT_AGENT_ABORT_SETTLEMENT_GRACE_MS
  )
  const activeAgentExecutions = new Map<string, ActiveAgentExecution>()
  const ownerLifecycles = new Map<number, AgentExecutionOwnerLifecycle>()
  const closedAgentExecutionIds = new Map<string, number>()
  let executionGeneration = 0

  const rememberClosedExecution = (execution: ActiveAgentExecution): void => {
    const executionId = execution.descriptor.id
    closedAgentExecutionIds.delete(executionId)
    closedAgentExecutionIds.set(executionId, execution.generation)
    while (closedAgentExecutionIds.size > MAX_CLOSED_AGENT_EXECUTION_IDS) {
      const oldest = closedAgentExecutionIds.keys().next().value
      if (typeof oldest !== 'string') break
      closedAgentExecutionIds.delete(oldest)
    }
  }

  const settleExecutionFromControl = (
    execution: ActiveAgentExecution,
    status: AgentControlSettlement['output']['status'],
    syntheticTerminal: SyntheticAgentTerminal
  ): void => {
    if (activeAgentExecutions.get(execution.descriptor.id) !== execution) return
    activeAgentExecutions.delete(execution.descriptor.id)
    execution.abortSettlementLease?.cancel()
    execution.abortSettlementLease = null
    rememberClosedExecution(execution)
    if (syntheticTerminal) {
      sendToWorkbenchWebContents(
        execution.ownerWebContentsId,
        WorkbenchKernelChannels.agentExecution,
        createAgentCapabilityExecutionEventEnvelopeV1(
          execution.descriptor,
          'agent',
          {
            type: 'runtime',
            payload: ChatRuntimeEvents.error(
              'Stop was requested, but the runtime did not confirm termination.',
              'AGENT_STOP_SETTLEMENT_TIMEOUT',
              { executionId: execution.descriptor.id }
            ),
          }
        )
      )
    }
    execution.settleFromControl({ type: 'control', output: { status } })
  }

  const closeExecutionsForOwner = (ownerWebContentsId: number): void => {
    ownerLifecycles.delete(ownerWebContentsId)
    for (const execution of [...activeAgentExecutions.values()]) {
      if (execution.ownerWebContentsId !== ownerWebContentsId) continue
      if (execution.terminalStatus) {
        settleExecutionFromControl(execution, execution.terminalStatus, null)
        continue
      }
      execution.controller.abort('Workbench renderer was closed.')
      settleExecutionFromControl(execution, 'aborted', null)
    }
  }

  const installOwnerLifecycle = (sender: WebContents): void => {
    if (ownerLifecycles.has(sender.id)) return
    const ownerWebContentsId = sender.id
    const handleDestroyed = (): void => closeExecutionsForOwner(ownerWebContentsId)
    ownerLifecycles.set(ownerWebContentsId, { sender, handleDestroyed })
    sender.once('destroyed', handleDestroyed)
  }

  ipcMain.handle(WorkbenchKernelChannels.getStatus, () => projectStatus(runtime))
  ipcMain.handle(
    WorkbenchKernelChannels.backupChatHistory,
    async (_event, request: unknown): Promise<WorkbenchChatHistoryBackupResult> =>
      writeChatHistoryBackup(storagePaths, request)
  )
  ipcMain.handle(
    WorkbenchKernelChannels.invoke,
    async (event: IpcMainInvokeEvent, request: unknown): Promise<WorkbenchKernelInvokeResult> => {
      const parsed = parseWorkbenchKernelInvokeRequest(request, routes)
      if (!parsed) return {
        ok: false,
        error: {
          code: 'KERNEL_REQUEST_INVALID',
          message: 'Workbench Kernel invocation request is invalid.',
          retryable: false,
          details: null,
        },
      }
      const route = routes[parsed.route]
      let executionDescriptor: AgentCapabilityExecutionDescriptorV1 | null = null
      if (parsed.route === 'agent.execute') {
        try {
          executionDescriptor = parseAgentCapabilityExecuteEnvelopeV1(parsed.input).execution
        } catch {
          return {
            ok: false,
            error: {
              code: 'KERNEL_REQUEST_INVALID',
              message: 'Workbench Agent execution descriptor is invalid.',
              retryable: false,
              details: null,
            },
          }
        }
      }
      if (
        executionDescriptor
        && (
          activeAgentExecutions.has(executionDescriptor.id)
          || closedAgentExecutionIds.has(executionDescriptor.id)
        )
      ) return {
        ok: false,
        error: {
          code: 'AGENT_EXECUTION_ID_CONFLICT',
          message: 'This Agent execution id is active or was recently closed.',
          retryable: false,
          details: { executionId: executionDescriptor.id },
        },
      }
      const controller = new AbortController()
      const activeExecution = executionDescriptor
        ? createActiveAgentExecution(
            controller,
            executionDescriptor,
            ++executionGeneration,
            event.sender.id
          )
        : null
      if (activeExecution) {
        activeAgentExecutions.set(activeExecution.descriptor.id, activeExecution)
        installOwnerLifecycle(event.sender)
      }
      const invocation = Promise.resolve()
        .then(() => runtime.invokeCapability({
          capabilityId: route.capabilityId,
          operation: route.operation,
          scope: toKernelScope(parsed.scope),
          input: parsed.input,
          signal: controller.signal,
          permissionContext: {
            details: {
              productId: 'velaros.workbench',
              route: parsed.route,
            },
          },
        }))
        .then(
          (output) => ({ type: 'output' as const, output }),
          (error: unknown) => ({ type: 'error' as const, error })
        )
      try {
        const settlement = activeExecution
          ? await Promise.race([invocation, activeExecution.controlSettlement])
          : await invocation
        if (settlement.type === 'error') return { ok: false, error: toInvocationError(settlement.error) }
        return { ok: true, output: settlement.output }
      } finally {
        if (
          activeExecution
          && activeAgentExecutions.get(activeExecution.descriptor.id) === activeExecution
        ) {
          activeAgentExecutions.delete(activeExecution.descriptor.id)
          activeExecution.abortSettlementLease?.cancel()
          activeExecution.abortSettlementLease = null
          rememberClosedExecution(activeExecution)
        }
      }
    }
  )
  /** 用户要停下一次执行：返回是否受理（已到终态的不再受理）。 */
  const requestExecutionAbort = (execution: ActiveAgentExecution): boolean => {
    if (execution.terminalStatus) {
      settleExecutionFromControl(execution, execution.terminalStatus, null)
      return false
    }
    if (!execution.abortRequested) {
      execution.abortRequested = true
      execution.controller.abort('Stopped by the user.')
      // controller 是执行级取消权威，并已贯穿内置 stack 与外部 engine。全局 dispose/close 会误杀
      // 其他窗口的运行；若提供方忽略 signal，只能隔离其晚到事件并报告未确认，不能声称已终止。
      execution.abortSettlementLease = timers.after(
        abortSettlementGraceMs,
        () => settleExecutionFromControl(execution, 'error', 'stop-settlement-timeout'),
        { label: 'agent.abort-settlement' }
      )
    }
    return true
  }

  ipcMain.handle(WorkbenchKernelChannels.abortAgentExecution, (event: IpcMainInvokeEvent, request: unknown) => {
    const executionId = readAbortExecutionId(request)
    if (!executionId) return false
    const execution = activeAgentExecutions.get(executionId)
    if (!execution || execution.ownerWebContentsId !== event.sender.id) return false
    return requestExecutionAbort(execution)
  })
  ipcMain.handle(
    WorkbenchKernelChannels.getGoalLifecycle,
    async (_event, request: unknown): Promise<WorkbenchGoalLifecycleResult> => {
      const sessionId = readSessionId(request)
      if (!sessionId) return { ok: false, message: 'Workbench goal request is invalid.' }
      if (!options.goalLifecycle) return { ok: true, goal: null }
      return settleGoalLifecycle(() => options.goalLifecycle!.get(sessionId))
    }
  )
  ipcMain.handle(
    WorkbenchKernelChannels.updateGoalLifecycle,
    async (event: IpcMainInvokeEvent, request: unknown): Promise<WorkbenchGoalLifecycleResult> => {
      const parsed = readGoalLifecycleUpdate(request)
      if (!parsed || !options.goalLifecycle)
        return { ok: false, message: 'Workbench goal request is invalid.' }
      const result = await settleGoalLifecycle(() =>
        options.goalLifecycle!.update(parsed.sessionId, parsed.action)
      )
      // 暂停、移除等动作要停下这个会话正在跑的这一轮（Desktop 同一规则）；「继续」不停。
      if (result.ok && parsed.action !== 'resume') {
        for (const execution of [...activeAgentExecutions.values()]) {
          if (
            execution.descriptor.source.sessionId === parsed.sessionId
            && execution.ownerWebContentsId === event.sender.id
          )
            requestExecutionAbort(execution)
        }
      }
      return result
    }
  )
  ipcMain.handle(WorkbenchKernelChannels.releaseAgentSession, async (_event, request: unknown) => {
    const sessionId = readSessionId(request)
    if (sessionId) await options.releaseAgentSession?.(sessionId)
  })
  ipcMain.handle(
    WorkbenchKernelChannels.respondAgentUiRequest,
    (event: IpcMainInvokeEvent, request: unknown) => {
      const response = readAgentUiResponse(request)
      if (!response) return false
      // 只认发起这一轮的窗口：请求只送到了它那里，别的窗口回执一律不收。
      const execution = activeAgentExecutions.get(response.executionId)
      if (!execution || execution.ownerWebContentsId !== event.sender.id) return false
      return options.resolveAgentUiRequest?.(response) ?? false
    }
  )
  ipcMain.handle(WorkbenchKernelChannels.resolveAgentInput, (_event, request: unknown) => {
    const parsed = readResolveAgentInput(request)
    return parsed ? resolveAgentInput(parsed.sessionId, parsed.answer) : false
  })
  ipcMain.handle(WorkbenchKernelChannels.provideAgentGuidance, (_event, request: unknown) => {
    const parsed = readProvideAgentGuidance(request)
    return parsed ? (options.provideAgentGuidance?.(parsed) ?? false) : false
  })
  ipcMain.handle(WorkbenchKernelChannels.resolveAgentConfirmation, (_event, request: unknown) => {
    const parsed = readResolveAgentConfirmation(request)
    return parsed
      ? resolveAgentConfirmation(parsed.sessionId, parsed.approved, parsed.rejectionMessage)
      : false
  })

  const unsubscribeAgentExecution = runtime.subscribeEvent(
    AgentCapabilityExecutionEventType,
    (event) => {
      const envelope = readAgentExecutionEventEnvelope(event.payload)
      if (!envelope) return
      if (closedAgentExecutionIds.has(envelope.executionId)) return
      const activeExecution = activeAgentExecutions.get(envelope.executionId)
      if (!activeExecution) return
      const identity = agentExecutionEventIdentity(envelope)
      if (
        agentExecutionIdentity(activeExecution.descriptor) !== identity
      ) return

      sendToWorkbenchWebContents(
        activeExecution.ownerWebContentsId,
        WorkbenchKernelChannels.agentExecution,
        envelope
      )
      const terminalStatus = readAgentTerminalStatus(envelope)
      if (terminalStatus) activeExecution.terminalStatus = terminalStatus
      if (activeExecution.abortRequested && terminalStatus) {
        // 终态已经到达就立刻回收 IPC；底层 Promise 即使不 settle，也不能继续占住 UI。
        settleExecutionFromControl(activeExecution, terminalStatus, null)
      }
    }
  )

  return () => {
    unsubscribeAgentExecution()
    for (const lifecycle of ownerLifecycles.values()) {
      lifecycle.sender.removeListener('destroyed', lifecycle.handleDestroyed)
    }
    ownerLifecycles.clear()
    for (const execution of activeAgentExecutions.values()) {
      execution.controller.abort('Workbench Kernel IPC disposed.')
      execution.abortSettlementLease?.cancel()
      execution.settleFromControl({ type: 'control', output: { status: 'aborted' } })
    }
    activeAgentExecutions.clear()
    closedAgentExecutionIds.clear()
    timers.dispose()
    ipcMain.removeHandler(WorkbenchKernelChannels.getStatus)
    ipcMain.removeHandler(WorkbenchKernelChannels.invoke)
    ipcMain.removeHandler(WorkbenchKernelChannels.abortAgentExecution)
    ipcMain.removeHandler(WorkbenchKernelChannels.resolveAgentInput)
    ipcMain.removeHandler(WorkbenchKernelChannels.resolveAgentConfirmation)
    ipcMain.removeHandler(WorkbenchKernelChannels.provideAgentGuidance)
    ipcMain.removeHandler(WorkbenchKernelChannels.getGoalLifecycle)
    ipcMain.removeHandler(WorkbenchKernelChannels.updateGoalLifecycle)
    ipcMain.removeHandler(WorkbenchKernelChannels.releaseAgentSession)
    ipcMain.removeHandler(WorkbenchKernelChannels.respondAgentUiRequest)
    ipcMain.removeHandler(WorkbenchKernelChannels.backupChatHistory)
  }
}

function createActiveAgentExecution(
  controller: AbortController,
  descriptor: AgentCapabilityExecutionDescriptorV1,
  generation: number,
  ownerWebContentsId: number
): ActiveAgentExecution {
  let settleFromControl!: (settlement: AgentControlSettlement) => void
  const controlSettlement = new Promise<AgentControlSettlement>((resolve) => {
    settleFromControl = resolve
  })
  return {
    controller,
    descriptor,
    generation,
    ownerWebContentsId,
    controlSettlement,
    settleFromControl,
    abortSettlementLease: null,
    abortRequested: false,
    terminalStatus: null,
  }
}

function readAgentExecutionEventEnvelope(
  value: unknown
): AgentCapabilityExecutionEventEnvelopeV1 | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const envelope = value as Record<string, unknown>
  if (
    envelope.protocolVersion !== AgentCapabilityProtocolVersion
    || typeof envelope.executionId !== 'string'
    || typeof envelope.sourceProductId !== 'string'
    || typeof envelope.sourceSessionId !== 'string'
    || (envelope.sessionCorrelationId !== undefined
      && typeof envelope.sessionCorrelationId !== 'string')
    || (envelope.channel !== 'agent'
      && envelope.channel !== 'state'
      && envelope.channel !== 'debug')
  ) return null
  return value as AgentCapabilityExecutionEventEnvelopeV1
}

function agentExecutionIdentity(descriptor: AgentCapabilityExecutionDescriptorV1): string {
  return [
    descriptor.id,
    descriptor.source.productId,
    descriptor.source.sessionId,
    descriptor.source.correlationId ?? '',
  ].join('\0')
}

function agentExecutionEventIdentity(envelope: AgentCapabilityExecutionEventEnvelopeV1): string {
  return [
    envelope.executionId,
    envelope.sourceProductId,
    envelope.sourceSessionId,
    envelope.sessionCorrelationId ?? '',
  ].join('\0')
}

function readAgentTerminalStatus(
  envelope: AgentCapabilityExecutionEventEnvelopeV1
): AgentControlSettlement['output']['status'] | null {
  if (envelope.channel !== 'agent') return null
  const event = asUnknownRecord(envelope.payload)
  const runtime = event.type === 'runtime' ? asUnknownRecord(event.payload) : event
  return runtime.kind === 'done'
    ? 'completed'
    : runtime.kind === 'aborted'
      ? 'aborted'
      : runtime.kind === 'error'
        ? 'error'
        : null
}

function asUnknownRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function readAbortExecutionId(request: unknown): string | null {
  if (!request || typeof request !== 'object' || Array.isArray(request)) return null
  const id = (request as { executionId?: unknown }).executionId
  return typeof id === 'string' && id.trim() ? id : null
}

function readResolveAgentInput(
  request: unknown
): { sessionId: string; answer: string } | null {
  if (!request || typeof request !== 'object' || Array.isArray(request)) return null
  const record = request as Record<string, unknown>
  const sessionId = record.sessionId
  const answer = record.answer
  return typeof sessionId === 'string' && sessionId.trim() && typeof answer === 'string'
    ? { sessionId, answer }
    : null
}

function readProvideAgentGuidance(
  request: unknown
): { sessionId: string; inputId: string; text: string } | null {
  if (!request || typeof request !== 'object' || Array.isArray(request)) return null
  const record = request as Record<string, unknown>
  const { sessionId, inputId, text } = record
  return typeof sessionId === 'string' && sessionId.trim()
    && typeof inputId === 'string' && inputId.trim()
    && typeof text === 'string' && text.trim()
    ? { sessionId, inputId, text }
    : null
}

/** 回执是 renderer 送来的外来数据：形状不对当没收到，数据只接普通对象。 */
function readAgentUiResponse(request: unknown): WorkbenchAgentUiResponse | null {
  if (!request || typeof request !== 'object' || Array.isArray(request)) return null
  const record = request as Record<string, unknown>
  const { requestId, executionId, ok } = record
  if (
    typeof requestId !== 'string' || !requestId.trim()
    || typeof executionId !== 'string' || !executionId.trim()
  ) return null
  if (ok === true) {
    const data = record.data
    return data && typeof data === 'object' && !Array.isArray(data)
      ? { requestId, executionId, ok: true, data: data as Record<string, unknown> }
      : { requestId, executionId, ok: true, data: {} }
  }
  if (ok === false) {
    const message = typeof record.message === 'string' && record.message.trim()
      ? record.message
      : 'Workbench could not complete the UI action.'
    return { requestId, executionId, ok: false, message }
  }
  return null
}

function readSessionId(request: unknown): string | null {
  if (!request || typeof request !== 'object' || Array.isArray(request)) return null
  const sessionId = (request as { sessionId?: unknown }).sessionId
  return typeof sessionId === 'string' && sessionId.trim() ? sessionId : null
}

const GoalLifecycleActions = new Set<unknown>([
  'resume',
  'pause',
  'block',
  'complete',
  'cancel',
  'remove',
] satisfies ChatGoalLifecycleAction[])

function readGoalLifecycleUpdate(
  request: unknown
): { sessionId: string; action: ChatGoalLifecycleAction } | null {
  const sessionId = readSessionId(request)
  const action = (request as { action?: unknown } | null)?.action
  return sessionId && GoalLifecycleActions.has(action)
    ? { sessionId, action: action as ChatGoalLifecycleAction }
    : null
}

/** 目标读写失败是软失败：卡片保留当前状态，原因交给 renderer 记日志。 */
async function settleGoalLifecycle(
  read: () => Promise<ActiveContextArtifact | null>
): Promise<WorkbenchGoalLifecycleResult> {
  try {
    return { ok: true, goal: await read() }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
}

function readResolveAgentConfirmation(
  request: unknown
): { sessionId: string; approved: boolean; rejectionMessage?: string } | null {
  if (!request || typeof request !== 'object' || Array.isArray(request)) return null
  const record = request as Record<string, unknown>
  const sessionId = record.sessionId
  const approved = record.approved
  const rejectionMessage = record.rejectionMessage
  if (typeof sessionId !== 'string' || !sessionId.trim() || typeof approved !== 'boolean') return null
  return {
    sessionId,
    approved,
    ...(typeof rejectionMessage === 'string' && rejectionMessage.trim()
      ? { rejectionMessage }
      : {}),
  }
}

/** host 起完后广播一次状态：renderer 的可用性门（浏览器面等）据此翻牌。 */
export function broadcastWorkbenchKernelStatus(runtime: Kernel): void {
  broadcast(WorkbenchKernelChannels.statusChanged, projectStatus(runtime))
}

function broadcast(channel: string, payload: unknown): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send(channel, payload)
  }
}

function sendToWorkbenchWebContents(
  webContentsId: number,
  channel: string,
  payload: unknown
): void {
  const target = BrowserWindow.getAllWindows().find((window) =>
    !window.isDestroyed() && window.webContents.id === webContentsId
  )
  target?.webContents.send(channel, payload)
}

function projectStatus(runtime: Kernel): WorkbenchKernelStatus {
  const modules = runtime.listModules()
  const runtimeStatus = runtime.getStatus()
  const capabilities: WorkbenchKernelCapabilityStatus[] = modules.flatMap((module) =>
    module.status === 'ready'
      ? module.manifest.provides.map((capability) => ({
          id: capability.id,
          version: module.manifest.version,
          moduleId: module.manifest.id,
          moduleVersion: module.manifest.version,
        }))
      : []
  )
  const unhealthy = modules.filter((module) => module.health.status !== 'healthy')
  const state = projectRuntimeState(runtimeStatus, capabilities.length, unhealthy.length)
  return {
    state,
    connected: capabilities.length > 0,
    checkedAt: Date.now(),
    kernelVersion: runtime.version,
    modules: modules.map((module) => ({
      id: module.manifest.id,
      version: module.manifest.version,
      generation: module.generation,
      lifecycleStatus: module.status,
      healthStatus: module.health.status,
      ...(module.error ? { error: module.error } : {}),
    })),
    capabilities,
    error: buildRuntimeError(runtimeStatus, modules.length, unhealthy),
  }
}

function projectRuntimeState(
  status: ReturnType<Kernel['getStatus']>,
  capabilityCount: number,
  unhealthyCount: number
): WorkbenchKernelRuntimeState {
  if (status === 'idle' || status === 'starting') return 'starting'
  if (status === 'disposed' || status === 'disposing') return 'disposed'
  if (status === 'degraded' || capabilityCount === 0 || unhealthyCount > 0) return 'degraded'
  return 'ready'
}

function buildRuntimeError(
  status: ReturnType<Kernel['getStatus']>,
  moduleCount: number,
  unhealthy: ReadonlyArray<{ manifest: { id: string } }>
): WorkbenchKernelStatus['error'] {
  if (status === 'idle' || status === 'starting') return null
  if (status === 'disposed' || status === 'disposing') return {
    code: 'KERNEL_DISPOSED',
    message: '进程内 Kernel 已停止。',
    retryable: false,
  }
  if (moduleCount === 0) return {
    code: 'KERNEL_HOST_NOT_STARTED',
    message: '进程内 Kernel 尚未启动或启动失败。',
    retryable: false,
  }
  if (unhealthy.length === 0) return null
  return {
    code: 'KERNEL_HEALTH_DEGRADED',
    message: `Kernel 模块不健康：${unhealthy.map((module) => module.manifest.id).join(', ')}`,
    retryable: false,
  }
}

function toKernelScope(
  value: WorkbenchKernelInvokeRequest['scope']
): ScopeRef | undefined {
  if (!value) return undefined
  return {
    id: value.id,
    ownerModuleId: value.ownerModuleId,
    ...(value.kind === null ? {} : { kind: value.kind }),
  }
}

function toInvocationError(error: unknown): WorkbenchKernelInvocationError {
  if (error instanceof KernelCapabilityUnavailableError) return {
    code: 'KERNEL_CAPABILITY_UNAVAILABLE',
    message: error.message,
    retryable: false,
    details: { capabilityId: error.capabilityId },
  }
  if (error instanceof UnknownKernelCapabilityOperationError) return {
    code: 'KERNEL_OPERATION_UNAVAILABLE',
    message: error.message,
    retryable: false,
    details: null,
  }
  if (error instanceof KernelCapabilityPermissionDeniedError) return {
    code: 'KERNEL_PERMISSION_DENIED',
    message: error.message,
    retryable: false,
    details: {
      capabilityId: error.capabilityId,
      operation: error.operation,
      permission: error.permission,
    },
  }
  return {
    code: 'KERNEL_INVOCATION_FAILED',
    message: error instanceof Error ? error.message : 'Kernel capability invocation failed',
    retryable: true,
    details: null,
  }
}

/**
 * 把 renderer 送来的聊天历史原样落盘。
 *
 * 主进程**不解释 payload 的形状**——它是不透明字符串。这样做是刻意的：会话权威目前仍在
 * renderer（已知欠账），本函数只是防「localStorage 被清空或撞配额即全丢」的兜底出口；
 * 一旦会话权威上收到主进程，这条通道整条删掉即可，不留需要迁移的 schema。
 *
 * 先写 `.tmp` 再 rename，避免写到一半崩溃留下半截 JSON 覆盖掉上一份完好备份。
 */
async function writeChatHistoryBackup(
  storagePaths: WorkbenchAppStoragePaths,
  request: unknown
): Promise<WorkbenchChatHistoryBackupResult> {
  if (typeof request !== 'object' || request === null) return { ok: false, message: 'Chat history backup request is invalid.' }

  const { projectRoot, payload } = request as Record<string, unknown>
  if (typeof projectRoot !== 'string' || !projectRoot.trim() || typeof payload !== 'string') return { ok: false, message: 'Chat history backup request is invalid.' }

  // 项目根不能直接当文件名（含分隔符且可能超长）；取稳定摘要做分片键。
  const shard = createHash('sha256').update(projectRoot).digest('hex').slice(0, 32)
  const targetPath = join(storagePaths.getChatHistoryBackupsDir(), `${shard}.json`)
  const temporaryPath = `${targetPath}.tmp`

  try {
    await writeFile(temporaryPath, payload, 'utf8')
    await rename(temporaryPath, targetPath)
    return { ok: true, path: targetPath }
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : 'Chat history backup failed.',
    }
  }
}
