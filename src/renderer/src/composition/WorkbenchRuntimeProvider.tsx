import { type ReactNode } from 'react'

import { WorkbenchHostProvider } from '../host/WorkbenchHostProvider'
import { WorkbenchCommentStoreProvider } from '../models/workbenchCommentStore'

import type { WorkbenchRuntime } from './WorkbenchRuntime'

export function WorkbenchRuntimeProvider({
  children,
  runtime,
}: {
  children: ReactNode
  runtime: WorkbenchRuntime
}): React.JSX.Element {
  return (
    <WorkbenchHostProvider runtime={runtime.host}>
      <WorkbenchCommentStoreProvider store={runtime.comments}>
        {children}
      </WorkbenchCommentStoreProvider>
    </WorkbenchHostProvider>
  )
}
