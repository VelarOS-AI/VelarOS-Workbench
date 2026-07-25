export const WorkbenchWorkspaceChannels = {
  invoke: 'workbench-app:workspace:invoke',
} as const

/** Published @velaros-ai/workspace operations installed by this product. */
export type WorkbenchWorkspaceOperation =
  | 'ws_status'
  | 'ws_read'
  | 'ws_file_stat'
  | 'ws_list_files'
  | 'ws_search'
  | 'ws_symbols'
  | 'ws_resolve_target'
  | 'ws_build_evidence'
  | 'ws_diff'
  | 'ws_prepare_edit'
  | 'ws_amend_edit'
  | 'ws_commit_edit'
  | 'ws_apply_edit'
  | 'ws_validate'
  | 'ws_rollback'
  | 'ws_run_batch'

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
