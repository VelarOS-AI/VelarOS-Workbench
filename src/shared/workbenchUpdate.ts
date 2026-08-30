export const WorkbenchUpdateChannels = {
  getState: 'workbench-app:update:get-state',
  check: 'workbench-app:update:check',
  download: 'workbench-app:update:download',
  pause: 'workbench-app:update:pause',
  resume: 'workbench-app:update:resume',
  cancel: 'workbench-app:update:cancel',
  restart: 'workbench-app:update:restart',
  setAutomaticDownloads: 'workbench-app:update:set-automatic-downloads',
  setChannel: 'workbench-app:update:set-channel',
  changed: 'workbench-app:update:changed',
} as const

export const WorkbenchUpdateChannelValues = ['stable', 'beta', 'canary'] as const
export type WorkbenchUpdateChannel = (typeof WorkbenchUpdateChannelValues)[number]

export function isWorkbenchUpdateChannel(value: unknown): value is WorkbenchUpdateChannel {
  return typeof value === 'string' && WorkbenchUpdateChannelValues.includes(
    value as WorkbenchUpdateChannel
  )
}

export type WorkbenchUpdatePhase =
  | 'idle'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'paused'
  | 'downloaded'
  | 'error'

export interface WorkbenchUpdateState {
  readonly revision: number
  readonly phase: WorkbenchUpdatePhase
  readonly currentVersion: string
  readonly channel: WorkbenchUpdateChannel
  readonly targetVersion?: string
  readonly automaticDownloads: boolean
  readonly percent?: number
  readonly transferredBytes?: number
  readonly totalBytes?: number
  readonly bytesPerSecond?: number
  readonly error?: string
}

export interface WorkbenchUpdateBridge {
  getState: () => Promise<WorkbenchUpdateState>
  check: () => Promise<WorkbenchUpdateState>
  download: () => Promise<WorkbenchUpdateState>
  pause: () => Promise<WorkbenchUpdateState>
  resume: () => Promise<WorkbenchUpdateState>
  cancel: () => Promise<WorkbenchUpdateState>
  restart: () => Promise<void>
  setAutomaticDownloads: (enabled: boolean) => Promise<WorkbenchUpdateState>
  setChannel: (channel: WorkbenchUpdateChannel) => Promise<WorkbenchUpdateState>
  onChanged: (listener: (state: WorkbenchUpdateState) => void) => () => void
}
