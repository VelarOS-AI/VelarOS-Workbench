import { createContext, useContext } from 'react'

import type { WorkbenchAgentEngineId } from '@shared/workbenchConversation'

/** 当前会话由哪个外部引擎执行；VelarOS 自己的 Agent 时为 null。运行状态行的执行体标记据此换图标。 */
export const WorkbenchConversationEngineContext = createContext<Nullable<WorkbenchAgentEngineId>>(null)

export function useWorkbenchConversationEngine(): Nullable<WorkbenchAgentEngineId> {
  return useContext(WorkbenchConversationEngineContext)
}
