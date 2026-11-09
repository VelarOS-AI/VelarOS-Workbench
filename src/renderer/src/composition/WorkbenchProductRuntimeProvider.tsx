import { createContext, type ReactNode, useContext } from 'react'

import { type SystemDefaultEditorId, type SystemGitConfig } from '@shared/contracts/system'

/**
 * Workbench 消费的响应式产品配置切片。
 *
 * 由应用入口注入默认编辑器、Git 配置和聊天样式。
 */
export interface WorkbenchProductRuntimeValue {
  config: {
    defaultEditor: SystemDefaultEditorId
    git: SystemGitConfig
  }
  ui: {
    chatPanel: {
      spinIcon: string
      toolWindowPanel: string
      workbenchChatBody: string
      workbenchChatIconButton: string
      workbenchChatLeading: string
      workbenchChatLoading: string
      workbenchChatPanel: string
      workbenchChatSessionCurrentTitle: string
      workbenchChatSessionMenuAnchor: string
      workbenchChatSessionMenuButton: string
      workbenchChatSessionMenuCheck: string
      workbenchChatSessionMenuIcon: string
      workbenchChatSessionMenuItem: string
      workbenchChatSessionMenuList: string
      workbenchChatSessionMenuPanel: string
      workbenchChatSessionMenuText: string
      workbenchChatSessionMenuTitle: string
      workbenchChatTopBar: string
    }
  }
}

const WorkbenchProductRuntimeContext = createContext<Nullable<WorkbenchProductRuntimeValue>>(null)

export function WorkbenchProductRuntimeProvider({
  children,
  value,
}: {
  children: ReactNode
  value: WorkbenchProductRuntimeValue
}) {
  return (
    <WorkbenchProductRuntimeContext.Provider value={value}>
      {children}
    </WorkbenchProductRuntimeContext.Provider>
  )
}

export function useWorkbenchProductRuntime(): WorkbenchProductRuntimeValue {
  const runtime = useContext(WorkbenchProductRuntimeContext)
  if (!runtime) throw new Error('Workbench product runtime is not installed')
  return runtime
}
