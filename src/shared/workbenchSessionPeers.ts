import type { WorkbenchConversationSessionRequest } from './workbenchConversation'
import type { WorkbenchFsCallResult } from './workbenchFs'

export const WorkbenchSessionPeersChannels = {
  catalog: 'workbench-app:session-peers:catalog',
  acknowledge: 'workbench-app:session-peers:acknowledge',
  event: 'workbench-app:session-peers:event',
} as const

/** 同一项目的 VelarOS 会话目录；由界面持久化的会话生成。 */
export interface WorkbenchPeerMember {
  sessionId: string
  title: Nullable<string>
}

export interface WorkbenchPeerTask extends WorkbenchConversationSessionRequest {
  sourceSessionId: string
  inputId: string
  text: string
}

export type WorkbenchPeerEvent =
  | { type: 'prepare'; task: WorkbenchPeerTask }
  | { type: 'prepare-guidance'; task: WorkbenchPeerTask }
  | { type: 'guidance-accepted'; task: WorkbenchPeerTask }
  | { type: 'cancel'; task: WorkbenchPeerTask; message: string }

export interface WorkbenchSessionPeersBridge {
  catalog(request: {
    projectRoot: string
    members: WorkbenchPeerMember[]
  }): Promise<WorkbenchFsCallResult<void>>
  acknowledge(
    request: WorkbenchConversationSessionRequest & { inputId: string; error?: string }
  ): Promise<WorkbenchFsCallResult<void>>
  onEvent(listener: (event: WorkbenchPeerEvent) => void): () => void
}
