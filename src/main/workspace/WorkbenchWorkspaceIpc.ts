import { ipcMain } from 'electron'

import {
  WorkbenchWorkspaceChannels,
  type WorkbenchWorkspaceInvokeRequest,
  type WorkbenchWorkspaceInvokeResult,
  type WorkbenchWorkspaceOperation,
} from '../../shared/workbenchWorkspace'

import type { WorkbenchWorkspaceCapabilityProvider } from './PublishedWorkspaceCapabilityProvider'

export function registerWorkbenchWorkspaceIpc(
  provider: WorkbenchWorkspaceCapabilityProvider
): () => void {
  ipcMain.handle(
    WorkbenchWorkspaceChannels.invoke,
    async (_event, request: unknown):
    Promise<WorkbenchWorkspaceInvokeResult> => {
      if (!isWorkspaceInvokeRequest(request)) return {
          ok: false,
          error: {
            code: 'WORKSPACE_REQUEST_INVALID',
            message: 'Workbench Workspace invocation request is invalid.',
            retryable: false,
          },
        }
      try {
        return { ok: true, output: await provider.invoke(request) }
      } catch (error) {
        return {
          ok: false,
          error: {
            code: 'WORKSPACE_INVOCATION_FAILED',
            message: error instanceof Error ? error.message : 'Workspace invocation failed',
            retryable: false,
          },
        }
      }
    }
  )

  return () => {
    ipcMain.removeHandler(WorkbenchWorkspaceChannels.invoke)
  }
}

const WorkspaceOperations = new Set<WorkbenchWorkspaceOperation>([
  'ws_status',
  'ws_read',
  'ws_file_stat',
  'ws_list_files',
  'ws_search',
  'ws_symbols',
  'ws_resolve_target',
  'ws_build_evidence',
  'ws_diff',
  'ws_prepare_edit',
  'ws_amend_edit',
  'ws_commit_edit',
  'ws_apply_edit',
  'ws_validate',
  'ws_rollback',
  'ws_run_batch',
])

function isWorkspaceInvokeRequest(value: unknown): value is WorkbenchWorkspaceInvokeRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const request = value as Record<string, unknown>
  return (
    typeof request.projectRoot === 'string'
    && typeof request.operation === 'string'
    && WorkspaceOperations.has(request.operation as WorkbenchWorkspaceOperation)
    && Object.prototype.hasOwnProperty.call(request, 'input')
  )
}
