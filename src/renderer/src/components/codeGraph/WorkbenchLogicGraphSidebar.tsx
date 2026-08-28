import { type ReactElement } from 'react'
import { useWorkbenchI18n } from '@renderer/i18n'

import type { VelarLogicGraphSnapshot } from '@shared/contributions/velar/logicGraph'

import styles from '../../styles/workbenchPageStyles'

import { WorkbenchLogicGraphScopeTree } from './WorkbenchLogicGraphScopeTree'

export interface WorkbenchLogicGraphSidebarProps {
  projectFiles: ReadonlyArray<{ path: string }>
  snapshot: Nullable<VelarLogicGraphSnapshot>
  scopePaths: readonly string[]
  onScopePathsChange: (paths: readonly string[]) => void
}

export function WorkbenchLogicGraphSidebar({
  projectFiles,
  snapshot,
  scopePaths,
  onScopePathsChange,
}: WorkbenchLogicGraphSidebarProps): ReactElement {
  const { t } = useWorkbenchI18n()

  return (
    <aside className={styles.logicGraphSidebar}>
      <div className={styles.filePanelProjectHeader}>
        <span className={styles.filePanelViewTitle}>{t('workbench.logicGraphStructureView')}</span>
      </div>
      <div className={styles.logicGraphSidebarScope}>
        <WorkbenchLogicGraphScopeTree
          files={projectFiles}
          snapshot={snapshot}
          selectedPaths={scopePaths}
          onSelectionChange={onScopePathsChange}
        />
      </div>
    </aside>
  )
}
