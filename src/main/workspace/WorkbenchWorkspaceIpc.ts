import { ipcMain } from 'electron'

import {
  WorkbenchWorkspaceChannels,
  type WorkbenchWorkspaceInvokeRequest,
  type WorkbenchWorkspaceInvokeResult,
  type WorkbenchWorkspaceOperation,
} from '../../shared/workbenchWorkspace'

import {
  readReportedChangedFiles,
  type WorkbenchUserWriteSink,
} from './git/WorkbenchChatRunAttribution'
import type { WorkbenchProjectCapabilityProvider } from './ProjectCapabilityProvider'

/** 这条通道上会写文件的操作：都是用户在界面上点的（应用改动、撤销一处改动），不是模型动作。 */
const UserWritingOperations: ReadonlySet<WorkbenchWorkspaceOperation> = new Set([
  'project:apply-edit',
  'project:rollback',
])

export function registerWorkbenchWorkspaceIpc(
  provider: WorkbenchProjectCapabilityProvider,
  userWrites?: WorkbenchUserWriteSink
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
        const output = await provider.invoke(request)
        // 用户亲手改的文件：正在跑的那一轮不能把它们算成 Agent 的改动。
        if (UserWritingOperations.has(request.operation))
          userWrites?.recordUserWrites({
            workspaceRoot: request.projectRoot,
            paths: readReportedChangedFiles(output),
          })
        return { ok: true, output }
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
  'resource:codegraph-status',
  'project:status',
  'project:read',
  'project:stat',
  'project:list',
  'project:search',
  'project:symbols',
  'project:resolve-target',
  'project:build-evidence',
  'project:diff',
  'project:prepare-edit',
  'project:amend-edit',
  'project:apply-edit',
  'project:validate',
  'project:rollback',
  'project:run-batch',
  'project:codegraph-index',
  'project:codegraph-graph',
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
