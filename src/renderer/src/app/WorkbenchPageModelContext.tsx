import { createContext, type ReactElement, type ReactNode, useContext } from 'react'

import { isObject,isPresent } from '@velaros-ai/core'

import type { StandaloneWorkbenchPageModel } from '../hooks/useStandaloneWorkbenchPageModel'

/**
 * 由独立工作台页面 model 钩子构造、通过上下文供应方提供的运行时载荷；
 * 展示层通过页面上下文读取。
 */

export const WorkbenchPageModelContext = createContext<Nullable<StandaloneWorkbenchPageModel>>(null)

export function useWorkbenchPageContext(): StandaloneWorkbenchPageModel {
  const ctx = useContext(WorkbenchPageModelContext)

  if (!isPresent(ctx) || !isObject(ctx)) {
    // 独立宿主无 desktop 的 RendererError 全局，装配缺失属编程错误，普通 Error 即可。
    throw new Error('WorkbenchPageModelContext: missing Provider')
  }

  return ctx
}

export function WorkbenchPageModelProvider({
  model,
  children,
}: {
  model: StandaloneWorkbenchPageModel
  children: ReactNode
}): ReactElement {
  return (
    <WorkbenchPageModelContext.Provider value={model}>{children}</WorkbenchPageModelContext.Provider>
  )
}
