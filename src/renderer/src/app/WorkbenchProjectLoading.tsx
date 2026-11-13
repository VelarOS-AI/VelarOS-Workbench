import { CircleNotchIcon } from '@phosphor-icons/react'
import { useWorkbenchI18n } from '@renderer/i18n/WorkbenchLocalizationProvider'
import type { ReactElement } from 'react'

import { useWorkbenchPreferences } from '../hooks/useWorkbenchPreferences'

import '../styles/projectLoading.css'

/** Keep the project transition visible while its code and registration load. */
export function WorkbenchProjectLoading({ projectName }: { projectName?: string }): ReactElement {
  useWorkbenchPreferences()
  const { t } = useWorkbenchI18n()
  return (
    <main className="workbench-project-loading" role="status" aria-busy="true">
      <div className="workbench-project-loading__header">{projectName ?? 'VelarOS Workbench'}</div>
      <div className="workbench-project-loading__body">
        <div className="workbench-project-loading__files" aria-hidden="true">
          <span />
          <span />
          <span />
          <span />
        </div>
        <div className="workbench-project-loading__status">
          <CircleNotchIcon size={20} aria-hidden="true" />
          <span>{projectName ? t('workbench.openingProject') : t('common.loading')}</span>
        </div>
      </div>
    </main>
  )
}
