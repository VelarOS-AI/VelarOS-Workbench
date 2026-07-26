export const WorkbenchKernelChannels = {
  getStatus: 'workbench-app:kernel:get-status',
  retry: 'workbench-app:kernel:retry',
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
 * composition root maps these stable product intentions to independently
 * injected Kernel capabilities.
 */
export type WorkbenchKernelCapabilityRoute =
  | 'agent.execute'
  | 'agent.health'
  | 'model.supports-provider'
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

export type WorkbenchKernelConnectionState =
  | 'connecting'
  | 'ready'
  | 'degraded'
  | 'disposed'

export type WorkbenchKernelHealthStatus = 'healthy' | 'degraded' | 'stopped'

export interface WorkbenchKernelCapabilityStatus {
  id: string
  version: string
  moduleId: string
  moduleVersion: string
  catalogRevision: string
}

export interface WorkbenchKernelModuleHealthStatus {
  id: string
  version: string
  generation: number
  lifecycleStatus: string
  healthStatus: string
  error?: string
}

export interface WorkbenchKernelHandshakeStatus {
  protocolVersion: number
  kernelVersion: string
  moduleCount: number
}

export interface WorkbenchKernelDaemonStatus {
  instanceId: string
  pid: number
  startedAt: number
}

export interface WorkbenchKernelHealthSnapshot {
  status: WorkbenchKernelHealthStatus
  modules: readonly WorkbenchKernelModuleHealthStatus[]
}

export interface WorkbenchKernelConnectionError {
  code: string
  message: string
  retryable: boolean
}

/**
 * Renderer-safe projection of Kernel connection state.
 *
 * The daemon descriptor's authentication token and endpoint never cross IPC.
 */
export interface WorkbenchKernelStatus {
  state: WorkbenchKernelConnectionState
  connected: boolean
  checkedAt: number | null
  daemon: WorkbenchKernelDaemonStatus | null
  handshake: WorkbenchKernelHandshakeStatus | null
  health: WorkbenchKernelHealthSnapshot | null
  capabilities: readonly WorkbenchKernelCapabilityStatus[]
  error: WorkbenchKernelConnectionError | null
}

export interface WorkbenchKernelBridge {
  getStatus: () => Promise<WorkbenchKernelStatus>
  retry: () => Promise<WorkbenchKernelStatus>
  invoke: (request: WorkbenchKernelInvokeRequest) => Promise<WorkbenchKernelInvokeResult>
  onStatusChanged: (
    listener: (status: WorkbenchKernelStatus) => void
  ) => () => void
  onAgentExecution: (listener: (payload: unknown) => void) => () => void
}
