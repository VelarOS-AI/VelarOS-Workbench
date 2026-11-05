import { useEffect, useMemo, useRef } from 'react'
import { workbenchHost } from '@renderer/host/WorkbenchHost'
import type { WorkbenchGitChangeItem } from '@renderer/models/git/workbenchGitModel'
import { scanWorkbenchMergeResolutions } from '@renderer/models/git/workbenchMergeResolution'
import type { WorkbenchOpenEditorTab } from '@renderer/types/workbenchTypes'

import { AppError } from '@velaros-ai/velaros/core/error'
import { Result } from '@velaros-ai/velaros/core/result'

import type { useStableWorkbenchMessageTranslate } from '../runtime/useStableWorkbenchMessaging'
import { useLatest } from '../support/genericHooks'

/** 提示挂得久一点：用户可能还在看文件。 */
const OfferDurationMs = 15_000

interface UseWorkbenchMergeResolutionOfferOptions {
  workspaceRoot: Nullable<string>
  changeItems: readonly WorkbenchGitChangeItem[]
  openTabs: readonly WorkbenchOpenEditorTab[]
  /** 标记之后刷新 Git 状态（提交面板里这一行从「合并冲突」挪走）。 */
  onResolved: () => Promise<void> | void
  translate: Pick<
    ReturnType<typeof useStableWorkbenchMessageTranslate>,
    'messageLatest' | 'tLatest'
  >
}

/**
 * 冲突文件在编辑器里解决完最后一块、存了盘（手动保存或自动保存都算）：提示一句，提示上有「标记为已解决」，
 * 点了就用提交面板那个按钮同样的操作（`git add`）。在别处解决的、打开时就没有标记的不提示。
 */
export function useWorkbenchMergeResolutionOffer({
  workspaceRoot,
  changeItems,
  openTabs,
  onResolved,
  translate: { messageLatest, tLatest },
}: UseWorkbenchMergeResolutionOfferOptions): void {
  const markersRef = useRef<ReadonlyMap<string, boolean>>(new Map())
  const onResolvedLatest = useLatest(onResolved)
  const conflictedPaths = useMemo(
    () =>
      new Set(changeItems.filter((item) => item.group === 'conflicted').map((item) => item.path)),
    [changeItems]
  )

  // 换了项目：上一个项目记着的不算数。
  useEffect(() => {
    markersRef.current = new Map()
  }, [workspaceRoot])

  useEffect(() => {
    if (!workspaceRoot) return
    const { markers, resolved } = scanWorkbenchMergeResolutions(
      markersRef.current,
      conflictedPaths,
      openTabs
    )
    markersRef.current = markers

    async function markResolved(path: string): Promise<void> {
      if (!workspaceRoot) return
      try {
        Result.unwrap(
          await workbenchHost.kernel.workspace.performWorkspaceGitFileAction(
            workspaceRoot,
            [path],
            'resolve'
          )
        )
        messageLatest.current.success({
          title: tLatest.current('workbench.gitMarkResolvedSuccessTitle'),
          description: path,
        })
      } catch (error) {
        const appError = AppError.from(error)
        messageLatest.current.open({
          title: tLatest.current('workbench.gitFileActionFailedTitle'),
          description:
            appError.message.trim() || tLatest.current('workbench.gitFileActionFailedFallback'),
          tone: appError.code === 'VALIDATION' ? 'warning' : 'error',
          showClose: true,
        })
      } finally {
        await onResolvedLatest.current()
      }
    }

    for (const path of resolved)
      messageLatest.current.info({
        id: `merge-conflict-resolved:${workspaceRoot}:${path}`,
        title: tLatest.current('workbench.mergeConflict.resolvedTitle'),
        description: tLatest.current('workbench.mergeConflict.resolvedDescription', { path }),
        duration: OfferDurationMs,
        action: {
          label: tLatest.current('workbench.gitMarkResolved'),
          onClick: () => void markResolved(path),
        },
      })
  }, [conflictedPaths, messageLatest, onResolvedLatest, openTabs, tLatest, workspaceRoot])
}
