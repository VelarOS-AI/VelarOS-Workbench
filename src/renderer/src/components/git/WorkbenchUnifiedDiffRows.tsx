import { forwardRef, type ReactElement } from 'react'
import type { WorkbenchUnifiedDiffRow } from '@renderer/models/git/workbenchGitDiffModel'
import type { WorkbenchThemeId } from '@renderer/models/settings/workbenchPreferences'

import styles from '../../styles/workbenchPageStyles'
import {
  ReadOnlyDiffCodeMirror,
  type ReadOnlyDiffCodeMirrorHandle,
  type ReadOnlyDiffHunkActions,
} from '../editor/ReadOnlyDiffCodeMirror'

export type WorkbenchUnifiedDiffRowsHandle = ReadOnlyDiffCodeMirrorHandle

interface WorkbenchUnifiedDiffRowsProps {
  rows: WorkbenchUnifiedDiffRow[]
  path: Nullable<string>
  workbenchTheme: WorkbenchThemeId
  ariaLabel?: string
  /** 每块改动上方的按钮（Git 差异里暂存、回滚这一块）。 */
  hunkActions?: Nullable<ReadOnlyDiffHunkActions>
}

/**
 * Workbench 唯一的文件差异查看器。Git、提交、AI 变更与本地历史都经过这里，
 * 共享双列行号、语法高亮、增删底色和词级差异高亮。
 */
export const WorkbenchUnifiedDiffRows = forwardRef<
  WorkbenchUnifiedDiffRowsHandle,
  WorkbenchUnifiedDiffRowsProps
>(function WorkbenchUnifiedDiffRows(
  { rows, path, workbenchTheme, ariaLabel, hunkActions },
  ref
): ReactElement {
  return (
    <div className={styles.workbenchUnifiedDiffViewer} aria-label={ariaLabel}>
      <ReadOnlyDiffCodeMirror
        ref={ref}
        rows={rows}
        path={path}
        workbenchTheme={workbenchTheme}
        hunkActions={hunkActions}
      />
    </div>
  )
})
