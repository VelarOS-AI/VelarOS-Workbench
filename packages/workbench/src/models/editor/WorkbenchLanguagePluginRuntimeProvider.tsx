import { createContext, type ReactNode, useContext } from 'react'

import {
  type WorkbenchLanguagePluginInstallRuntime,
  workbenchLanguagePluginInstallRuntime,
} from './workbenchLanguagePluginInstallState'

const WorkbenchLanguagePluginRuntimeContext =
  createContext<Nullable<WorkbenchLanguagePluginInstallRuntime>>(null)

export function WorkbenchLanguagePluginRuntimeProvider({
  children,
  runtime,
}: {
  children: ReactNode
  runtime: WorkbenchLanguagePluginInstallRuntime
}): React.JSX.Element {
  return (
    <WorkbenchLanguagePluginRuntimeContext.Provider value={runtime}>
      {children}
    </WorkbenchLanguagePluginRuntimeContext.Provider>
  )
}

/** 未安装 Provider 时回退默认实例，仅用于兼容旧应用。 */
export function useWorkbenchLanguagePluginRuntime(): WorkbenchLanguagePluginInstallRuntime {
  return (
    useContext(WorkbenchLanguagePluginRuntimeContext) ?? workbenchLanguagePluginInstallRuntime
  )
}
