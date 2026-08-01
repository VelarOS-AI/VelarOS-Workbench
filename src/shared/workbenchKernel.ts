export const WorkbenchKernelChannels = {
  getStatus: 'workbench-app:kernel:get-status',
  invoke: 'workbench-app:kernel:invoke',
  statusChanged: 'workbench-app:kernel:status-changed',
  agentExecution: 'workbench-app:kernel:agent-execution',
} as const

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
  onStatusChanged: (
    listener: (status: WorkbenchKernelStatus) => void
  ) => () => void
  onAgentExecution: (listener: (payload: unknown) => void) => () => void
}
