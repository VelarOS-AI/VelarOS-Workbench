import {
  createContext,
  type ReactElement,
  type ReactNode,
  useContext,
} from 'react'

import type { AppLocale } from '@shared/contracts'

export type WorkbenchMessageKey = string

export interface WorkbenchTranslateParams {
  [key: string]: string | number
}

export interface WorkbenchI18nContextValue {
  locale: AppLocale
  setLocale: (locale: AppLocale) => Promise<void>
  t: (key: WorkbenchMessageKey, params?: WorkbenchTranslateParams) => string
}

const WorkbenchLocalizationContext = createContext<Nullable<WorkbenchI18nContextValue>>(null)

export function WorkbenchLocalizationProvider({
  children,
  value,
}: {
  children: ReactNode
  value: WorkbenchI18nContextValue
}): ReactElement {
  return (
    <WorkbenchLocalizationContext.Provider value={value}>
      {children}
    </WorkbenchLocalizationContext.Provider>
  )
}

export function useWorkbenchI18n(): WorkbenchI18nContextValue {
  const context = useContext(WorkbenchLocalizationContext)
  if (!context) {
    throw new Error('useWorkbenchI18n must be used within WorkbenchLocalizationProvider')
  }
  return context
}
