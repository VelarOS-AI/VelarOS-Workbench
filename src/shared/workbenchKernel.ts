export const WorkbenchKernelChannels = {
  getStatus: 'workbench-app:kernel:get-status',
  invoke: 'workbench-app:kernel:invoke',
  abortAgentExecution: 'workbench-app:kernel:abort-agent-execution',
  resolveAgentInput: 'workbench-app:kernel:resolve-agent-input',
  resolveAgentConfirmation: 'workbench-app:kernel:resolve-agent-confirmation',
  statusChanged: 'workbench-app:kernel:status-changed',
  agentExecution: 'workbench-app:kernel:agent-execution',
  backupChatHistory: 'workbench-app:kernel:backup-chat-history',
} as const

/**
 * 聊天历史的落盘备份请求。
 *
 * **这不是会话权威**——权威仍在 renderer（见 `standaloneWorkbenchChatAdapter`），本通道只是
 * 防「localStorage 被清空或撞配额即全丢」的兜底出口。主进程把 `payload` 当**不透明字符串**
 * 原样落盘，不解释也不校验内容形状；将来会话权威上收到主进程时，这条通道可以整条删掉，
 * 不会留下需要迁移的 schema。
 */
export interface WorkbenchChatHistoryBackupRequest {
  /** 备份分片键：一个项目根一份。 */
  projectRoot: string
  /** 已序列化的会话 JSON。 */
  payload: string
}

export type WorkbenchChatHistoryBackupResult =
  | { ok: true; path: string }
  | { ok: false; message: string }

export interface WorkbenchKernelScopeRef {
  id: string
  ownerModuleId: string
  kind: string | null
}

/**
 * Renderer-visible semantic route names.
 *
 * The renderer never supplies raw capability ids or operation names. The main
 * composition root maps these stable product intentions to capabilities the
 * in-process Kernel host actually registered.
 *
 * `browser.*` 保留但 Workbench 没有浏览器能力本体：调用一律回
 * `KERNEL_CAPABILITY_UNAVAILABLE`，消费面按既有降级路径处理（能力不在
 * {@link WorkbenchKernelStatus.capabilities} 里时界面本来就不激活）。
 */
export type WorkbenchKernelCapabilityRoute =
  | 'agent.execute'
  | 'agent.health'
  | 'browser.close-session'
  | 'browser.close-all-sessions'

export interface WorkbenchKernelInvokeRequest {
  route: WorkbenchKernelCapabilityRoute
  scope?: WorkbenchKernelScopeRef | null
  input: unknown
}

export interface WorkbenchAbortAgentExecutionRequest {
  executionId: string
}

export interface WorkbenchResolveAgentInputRequest {
  sessionId: string
  answer: string
}

export interface WorkbenchResolveAgentConfirmationRequest {
  sessionId: string
  approved: boolean
  rejectionMessage?: string
}

export interface WorkbenchKernelInvocationError {
  code: string
  message: string
  retryable: boolean
  details: Readonly<Record<string, unknown>> | null
}

export type WorkbenchKernelInvokeResult =
  | { ok: true; output: unknown }
  | { ok: false; error: WorkbenchKernelInvocationError }

/** 进程内 Kernel host 的生命周期态（无「连接」语义，宿主起即在）。 */
export type WorkbenchKernelRuntimeState = 'starting' | 'ready' | 'degraded' | 'disposed'

export interface WorkbenchKernelCapabilityStatus {
  id: string
  version: string
  moduleId: string
  moduleVersion: string
}

export interface WorkbenchKernelModuleStatus {
  id: string
  version: string
  generation: number
  lifecycleStatus: string
  healthStatus: string
  error?: string
}

export interface WorkbenchKernelRuntimeError {
  code: string
  message: string
  retryable: boolean
}

/**
 * Renderer 侧的进程内 Kernel 投影。
 *
 * `connected` 保留为「能力面可用」的语义位（不再表示跨进程连接），让既有消费面
 * 无需改判即可继续用它做可用性门。
 */
export interface WorkbenchKernelStatus {
  state: WorkbenchKernelRuntimeState
  connected: boolean
  checkedAt: number | null
  kernelVersion: string
  modules: readonly WorkbenchKernelModuleStatus[]
  capabilities: readonly WorkbenchKernelCapabilityStatus[]
  error: WorkbenchKernelRuntimeError | null
}

export interface WorkbenchKernelBridge {
  getStatus: () => Promise<WorkbenchKernelStatus>
  invoke: (request: WorkbenchKernelInvokeRequest) => Promise<WorkbenchKernelInvokeResult>
  abortAgentExecution: (request: WorkbenchAbortAgentExecutionRequest) => Promise<boolean>
  resolveAgentInput: (request: WorkbenchResolveAgentInputRequest) => Promise<boolean>
  resolveAgentConfirmation: (
    request: WorkbenchResolveAgentConfirmationRequest
  ) => Promise<boolean>
  onStatusChanged: (
    listener: (status: WorkbenchKernelStatus) => void
  ) => () => void
  onAgentExecution: (listener: (payload: unknown) => void) => () => void
  backupChatHistory: (
    request: WorkbenchChatHistoryBackupRequest
  ) => Promise<WorkbenchChatHistoryBackupResult>
}
