export const WorkbenchWorkspaceChannels = {
  invoke: 'workbench-app:workspace:invoke',
} as const

/** Workbench IPC operations backed by the Project domain. */
export type WorkbenchWorkspaceOperation =
  | 'project:status'
  | 'project:read'
  | 'project:stat'
  | 'project:list'
  | 'project:search'
  | 'project:symbols'
  | 'project:resolve-target'
  | 'project:build-evidence'
  | 'project:diff'
  | 'project:prepare-edit'
  | 'project:amend-edit'
  | 'project:apply-edit'
  | 'project:validate'
  | 'project:rollback'
  | 'project:run-batch'

export interface WorkbenchWorkspaceInvokeRequest {
  projectRoot: string
  operation: WorkbenchWorkspaceOperation
  input: unknown
}

export type WorkbenchWorkspaceInvokeResult =
  | { ok: true; output: unknown }
  | {
      ok: false
      error: {
        code: string
        message: string
        retryable: boolean
      }
    }

export interface WorkbenchWorkspaceBridge {
  invoke(request: WorkbenchWorkspaceInvokeRequest): Promise<WorkbenchWorkspaceInvokeResult>
}
