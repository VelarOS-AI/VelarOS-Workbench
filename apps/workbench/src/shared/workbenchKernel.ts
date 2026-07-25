export const WorkbenchKernelChannels = {
  getStatus: 'workbench-app:kernel:get-status',
  retry: 'workbench-app:kernel:retry',
  statusChanged: 'workbench-app:kernel:status-changed',
} as const

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
  onStatusChanged: (
    listener: (status: WorkbenchKernelStatus) => void
  ) => () => void
}
