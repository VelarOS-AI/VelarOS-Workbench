export const WorkbenchHistoryWindowQuery = 'file-history'

export const WorkbenchHistoryWindowChannels = {
  open: 'workbench-app:history-window:open',
  state: 'workbench-app:history-window:state',
  changed: 'workbench-app:history-window:changed',
  opened: 'workbench-app:history-window:opened',
  synchronize: 'workbench-app:history-window:synchronize',
  close: 'workbench-app:history-window:close',
  restore: 'workbench-app:history-window:restore',
  restoreRequested: 'workbench-app:history-window:restore-requested',
  restoreResolved: 'workbench-app:history-window:restore-resolved',
} as const

export interface WorkbenchHistoryWindowFile {
  projectRoot: string
  path: string
  mode: 'local' | 'git'
  currentContent: string
  editable: boolean
}

export interface WorkbenchHistoryWindowState extends WorkbenchHistoryWindowFile {
  id: string
  available: boolean
}

export type WorkbenchHistoryRestoreFailure = 'stale' | 'closed' | 'read-only' | 'unavailable'
export type WorkbenchHistoryRestoreResult =
  { ok: true } | { ok: false; reason: WorkbenchHistoryRestoreFailure }

export interface WorkbenchHistoryRestoreRequest {
  requestId: string
  projectRoot: string
  path: string
  expectedContent: string
  content: string
}

export interface WorkbenchHistoryWindowSync {
  id: string
  currentContent: string | null
  editable: boolean
}

export interface WorkbenchHistoryWindowBridge {
  open: (file: WorkbenchHistoryWindowFile) => Promise<void>
  getState: () => Promise<WorkbenchHistoryWindowState>
  onChanged: (listener: (state: WorkbenchHistoryWindowState) => void) => () => void
  onOpened: (listener: (state: WorkbenchHistoryWindowState | null) => void) => () => void
  synchronize: (state: WorkbenchHistoryWindowSync | null) => Promise<void>
  close: () => Promise<void>
  restore: (request: {
    id: string
    expectedContent: string
    content: string
  }) => Promise<WorkbenchHistoryRestoreResult>
  onRestoreRequested: (listener: (request: WorkbenchHistoryRestoreRequest) => void) => () => void
  resolveRestore: (response: {
    requestId: string
    result: WorkbenchHistoryRestoreResult
  }) => Promise<void>
}
