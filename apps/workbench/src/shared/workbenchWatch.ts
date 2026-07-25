import type { SystemWorkspaceFilesChangedEvent } from '@velaros-ai/core/types'

import type { WorkbenchFsCallResult } from './workbenchFs'

export const WorkbenchWatchChannels = {
  start: 'workbench-app:watch:start',
  stop: 'workbench-app:watch:stop',
  changed: 'workbench-app:watch:changed',
} as const

export interface WorkbenchWatchStartRequest {
  workspaceRoot: string
}

export interface WorkbenchWatchStartResult {
  subscriptionId: string
  workspaceRoot: string
}

export interface WorkbenchWatchStopRequest {
  subscriptionId: string
}

export interface WorkbenchWatchChangedPayload {
  subscriptionId: string
  event: SystemWorkspaceFilesChangedEvent
}

export interface WorkbenchWatchBridge {
  start: (
    request: WorkbenchWatchStartRequest
  ) => Promise<WorkbenchFsCallResult<WorkbenchWatchStartResult>>
  stop: (request: WorkbenchWatchStopRequest) => Promise<WorkbenchFsCallResult<void>>
  onChanged: (listener: (payload: WorkbenchWatchChangedPayload) => void) => () => void
}
