import { createContext, type ReactNode, useContext } from 'react'

import type { Result } from '@velaros-ai/core/result'

import type {
  AgentProviderRuntimeConfig,
  AuxiliaryModelConfig,
  AuxiliaryModelConfigs,
  AuxiliaryModelTaskId,
  SystemDefaultEditorId,
  SystemGitConfig,
} from '@shared/contracts'

export interface WorkbenchModelConfigurationPort {
  auxiliaryModels: AuxiliaryModelConfigs
  providerRuntimeConfigs: AgentProviderRuntimeConfig[]
  setAuxiliaryModelConfig: (
    taskId: AuxiliaryModelTaskId,
    patch: Partial<AuxiliaryModelConfig>
  ) => Promise<Result<void>>
}

/**
 * Workbench 消费的响应式产品配置切片。
 *
 * 它不是 Kernel 状态：Desktop 和未来独立应用分别从自己的配置 owner 投影并注入，产品代码不直接
 * import 任一宿主的 Context/store。
 */
export interface WorkbenchProductRuntimeValue {
  config: {
    defaultEditor: SystemDefaultEditorId
    git: SystemGitConfig
    model: WorkbenchModelConfigurationPort
  }
  ui: {
    chatPanel: {
      spinIcon: string
      toolWindowPanel: string
      workbenchChatBody: string
      workbenchChatIconButton: string
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
