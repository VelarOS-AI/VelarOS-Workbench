export const WorkbenchWorkspaceChannels = {
  invoke: 'workbench-app:workspace:invoke',
} as const

/** IDE 面的项目读取（列文件、读文件、读项目 AI 规则），由 Platform 项目内核承载。 */
export type WorkbenchWorkspaceOperation = 'project:list' | 'project:read' | 'project:rules'

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
