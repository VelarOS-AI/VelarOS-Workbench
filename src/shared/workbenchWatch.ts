import { type SystemWorkspaceFilesChangedEvent } from '@shared/contracts/system'

import type { WorkbenchFsCallResult } from './workbenchFs'

export const WorkbenchWatchChannels = {
  start: 'workbench-app:watch:start',
  stop: 'workbench-app:watch:stop',
  changed: 'workbench-app:watch:changed',
  status: 'workbench-app:watch:status',
} as const

/**
 * 变更事件里代表「整个根目录都可能变了」的路径：监听报了说不清是哪个文件的事件，或者停过一阵又恢复
 * （停着的时候漏了事件）。收到它的一方按整个工程刷新。
 */
export const WorkbenchWatchWholeRootPath = '.'

/**
 * 监听眼下能不能跑。`unavailable`：起不来或出错后还没恢复，改动收不到；主进程在后台按退避间隔重试，
 * 恢复时报 `watching`，并补发一次整个根目录的变更。
 */
export interface WorkbenchWatchStatus {
  state: 'watching' | 'unavailable'
  /** `unavailable` 的原因。 */
  message?: string
}

export interface WorkbenchWatchStartRequest {
  workspaceRoot: string
}

export interface WorkbenchWatchStartResult {
  subscriptionId: string
  workspaceRoot: string
  status: WorkbenchWatchStatus
}

export interface WorkbenchWatchStopRequest {
  subscriptionId: string
}

export interface WorkbenchWatchChangedPayload {
  subscriptionId: string
  event: SystemWorkspaceFilesChangedEvent
}

export interface WorkbenchWatchStatusPayload {
  subscriptionId: string
  status: WorkbenchWatchStatus
}

export interface WorkbenchWatchBridge {
  start: (
    request: WorkbenchWatchStartRequest
  ) => Promise<WorkbenchFsCallResult<WorkbenchWatchStartResult>>
  stop: (request: WorkbenchWatchStopRequest) => Promise<WorkbenchFsCallResult<void>>
  onChanged: (listener: (payload: WorkbenchWatchChangedPayload) => void) => () => void
  onStatus: (listener: (payload: WorkbenchWatchStatusPayload) => void) => () => void
}
