import { ipcMain } from 'electron'

import {
  WorkbenchWorkspaceChannels,
  type WorkbenchWorkspaceInvokeRequest,
  type WorkbenchWorkspaceInvokeResult,
  type WorkbenchWorkspaceOperation,
} from '../../shared/workbenchWorkspace'
import type { WorkbenchWindowManager } from '../projects/WorkbenchWindowManager'

import { callWithEnvelopeSync } from './ipcBoundary'
import type { WorkbenchProjectCapabilityProvider } from './ProjectCapabilityProvider'

export function registerWorkbenchWorkspaceIpc(
  provider: WorkbenchProjectCapabilityProvider,
  projectOwner: Pick<WorkbenchWindowManager, 'assertProjectForWebContents'>
): () => void {
  ipcMain.handle(
    WorkbenchWorkspaceChannels.invoke,
    async (event, request: unknown):
    Promise<WorkbenchWorkspaceInvokeResult> => {
      if (!isWorkspaceInvokeRequest(request)) return {
          ok: false,
          error: {
            code: 'WORKSPACE_REQUEST_INVALID',
            message: 'Workbench Workspace invocation request is invalid.',
            retryable: false,
          },
        }
      const admission = callWithEnvelopeSync(() => {
        projectOwner.assertProjectForWebContents(event.sender, request.projectRoot)
      })
      if (!admission.ok) return {
        ok: false,
        error: {
          code: admission.code ?? 'WORKSPACE_INVOCATION_FAILED',
          message: admission.message,
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
  'project:list',
  'project:read',
  'project:rules',
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
