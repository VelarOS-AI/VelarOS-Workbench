import { createContext, type ReactNode, useContext } from 'react'

import { WorkbenchHostProvider } from '../host'
import { WorkbenchCommentStoreProvider } from '../models/comments/workbenchCommentStore'

import type { WorkbenchRuntime } from './WorkbenchRuntime'

const WorkbenchRuntimeContext = createContext<Nullable<WorkbenchRuntime>>(null)

export function WorkbenchRuntimeProvider({
  children,
  runtime,
}: {
  children: ReactNode
  runtime: WorkbenchRuntime
}): React.JSX.Element {
  return (
    <WorkbenchRuntimeContext.Provider value={runtime}>
      <WorkbenchHostProvider runtime={runtime.host}>
        <WorkbenchCommentStoreProvider store={runtime.comments}>
          {children}
        </WorkbenchCommentStoreProvider>
      </WorkbenchHostProvider>
    </WorkbenchRuntimeContext.Provider>
  )
}

/** 仅在已安装 `WorkbenchRuntimeProvider` 的子树中使用。 */
export function useWorkbenchRuntime(): WorkbenchRuntime {
  const runtime = useContext(WorkbenchRuntimeContext)
  if (!runtime) throw new Error('Workbench runtime is not installed')
  return runtime
}
