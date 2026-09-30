import {
  forwardRef,
  type ReactElement,
  type RefAttributes,
  Suspense,
  useCallback,
  useImperativeHandle,
  useRef,
} from 'react'
import { useWorkbenchDiffLayout } from '@renderer/hooks/useWorkbenchPreferences'
import type { WorkbenchUnifiedDiffRow } from '@renderer/models/git/workbenchGitDiffModel'
import type { WorkbenchThemeId } from '@renderer/models/settings/workbenchPreferences'

import styles from '../../styles/workbenchPageStyles'
import { lazyWithPreload } from '../../support/lazyWithPreload'
import type {
  ReadOnlyDiffCodeMirrorHandle,
  ReadOnlyDiffCodeMirrorProps,
  ReadOnlyDiffHunkActions,
} from '../editor/ReadOnlyDiffCodeMirror'

export type WorkbenchUnifiedDiffRowsHandle = ReadOnlyDiffCodeMirrorHandle

/**
 * 查看器本体（CodeMirror 视图、行内变化、并排两栏）不进工作区外壳包：第一次显示差异时才加载。
 * 这里只从那个模块拿类型，值一律走这个按需加载的入口。
 */
const LazyReadOnlyDiffCodeMirror = lazyWithPreload<
  ReadOnlyDiffCodeMirrorProps & RefAttributes<ReadOnlyDiffCodeMirrorHandle>
>(async () => (await import('../editor/ReadOnlyDiffCodeMirror')).ReadOnlyDiffCodeMirror)

/** 交给 `preloadWhenIdle`：差异还在读的时候先把查看器本体的代码拉下来。 */
export const WorkbenchDiffViewerCode = { preload: LazyReadOnlyDiffCodeMirror.preload }

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
 * 共享行号、语法高亮、增删底色和词级差异高亮。改动前后上下合在一栏还是左右并排跟着偏好走
 * （`diffLayout`，工具栏上的 `WorkbenchDiffLayoutToggle` 切换），这几处用的是同一个。
 */
export const WorkbenchUnifiedDiffRows = forwardRef<
  WorkbenchUnifiedDiffRowsHandle,
  WorkbenchUnifiedDiffRowsProps
>(function WorkbenchUnifiedDiffRows(
  { rows, path, workbenchTheme, ariaLabel, hunkActions },
  ref
): ReactElement {
  const layout = useWorkbenchDiffLayout()
  const viewerRef = useRef<Nullable<ReadOnlyDiffCodeMirrorHandle>>(null)
  /** 查看器本体还没加载好就要跳到某一处改动（刚打开差异）：它一就位就补上。 */
  const pendingDirectionRef = useRef<Nullable<1 | -1>>(null)

  const attachViewer = useCallback((viewer: Nullable<ReadOnlyDiffCodeMirrorHandle>): void => {
    viewerRef.current = viewer
    const pending = pendingDirectionRef.current
    if (!viewer || pending === null) return
    pendingDirectionRef.current = null
    viewer.goToChange(pending)
  }, [])

  useImperativeHandle(
    ref,
    () => ({
      goToChange: (direction: 1 | -1): void => {
        if (viewerRef.current) viewerRef.current.goToChange(direction)
        else pendingDirectionRef.current = direction
      },
    }),
    []
  )

  return (
    <div className={styles.workbenchUnifiedDiffViewer} aria-label={ariaLabel}>
      <Suspense fallback={null}>
        <LazyReadOnlyDiffCodeMirror
          ref={attachViewer}
          rows={rows}
          path={path}
          workbenchTheme={workbenchTheme}
          hunkActions={hunkActions}
          layout={layout}
        />
      </Suspense>
    </div>
  )
})
