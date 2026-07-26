import { createContext, type ReactNode, useContext } from 'react'

import { workbenchHost, type WorkbenchHostRuntime } from './WorkbenchHost'

const WorkbenchHostRuntimeContext = createContext<Nullable<WorkbenchHostRuntime>>(null)

export interface WorkbenchHostProviderProps {
  children: ReactNode
  runtime: WorkbenchHostRuntime
}

/**
 * 为一棵 React 子树安装独立的 Workbench 宿主运行时。
 *
 * 多窗口、多 React root 或测试场景应显式传入各自的实例，避免共享默认单例。
 */
export function WorkbenchHostProvider({
  children,
  runtime,
}: WorkbenchHostProviderProps): React.JSX.Element {
  return (
    <WorkbenchHostRuntimeContext.Provider value={runtime}>
      {children}
    </WorkbenchHostRuntimeContext.Provider>
  )
}

/**
 * 返回当前 React root 的宿主运行时。未安装 Provider 时回退到兼容单例。
 *
 * @deprecated 新应用应始终在根节点安装 `WorkbenchHostProvider`。
 */
export function useWorkbenchHostRuntime(): WorkbenchHostRuntime {
  return useContext(WorkbenchHostRuntimeContext) ?? workbenchHost
}
