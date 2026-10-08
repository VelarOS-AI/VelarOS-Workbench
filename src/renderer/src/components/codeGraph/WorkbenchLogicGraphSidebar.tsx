import { type ReactElement } from 'react'
import { useWorkbenchI18n } from '@renderer/i18n/WorkbenchLocalizationProvider'

import type { VelarLogicGraphSnapshot } from '@shared/contributions/velar/logicGraph'

import styles from '../../styles/workbenchPageStyles'

import { WorkbenchLogicGraphScopeTree } from './WorkbenchLogicGraphScopeTree'

export interface WorkbenchLogicGraphSidebarProps {
  projectFiles: ReadonlyArray<{ path: string }>
  snapshot: Nullable<VelarLogicGraphSnapshot>
  scopePaths: readonly string[]
  expansionOverrides: ReadonlyMap<string, boolean>
  onScopePathsChange: (paths: readonly string[]) => void
  onExpansionOverridesChange: (paths: ReadonlyMap<string, boolean>) => void
}

export function WorkbenchLogicGraphSidebar({
  projectFiles,
  snapshot,
  scopePaths,
  expansionOverrides,
  onScopePathsChange,
  onExpansionOverridesChange,
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
          expansionOverrides={expansionOverrides}
          onSelectionChange={onScopePathsChange}
          onExpansionOverridesChange={onExpansionOverridesChange}
        />
      </div>
    </aside>
  )
}
