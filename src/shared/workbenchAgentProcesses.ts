import type {
  ShellBackgroundTaskRecord,
  ShellConsoleControlResult,
  ShellTaskTerminateReport,
} from '@velaros-ai/velaros/execution/contracts'

import type { WorkbenchConversationSessionRequest } from './workbenchConversation'
import type { WorkbenchFsCallResult } from './workbenchFs'

/** 项目 Agent 的后台命令与交互控制台，身份同时包含项目和会话。 */
export const WorkbenchAgentProcessesChannels = {
  list: 'workbench-app:agent-processes:list',
  stop: 'workbench-app:agent-processes:stop',
  input: 'workbench-app:agent-processes:input',
  interrupt: 'workbench-app:agent-processes:interrupt',
  changed: 'workbench-app:agent-processes:changed',
} as const

export interface WorkbenchAgentProcessRequest extends WorkbenchConversationSessionRequest {
  taskId: string
}

export interface WorkbenchAgentProcessesBridge {
  list(
    request: WorkbenchConversationSessionRequest
  ): Promise<WorkbenchFsCallResult<ShellBackgroundTaskRecord[]>>
  stop(
    request: WorkbenchAgentProcessRequest & { force: boolean }
  ): Promise<WorkbenchFsCallResult<ShellTaskTerminateReport>>
  input(
    request: WorkbenchAgentProcessRequest & { text: string }
  ): Promise<WorkbenchFsCallResult<ShellConsoleControlResult>>
  interrupt(
    request: WorkbenchAgentProcessRequest
  ): Promise<WorkbenchFsCallResult<ShellConsoleControlResult>>
  onChanged(listener: (ref: WorkbenchConversationSessionRequest) => void): () => void
}
