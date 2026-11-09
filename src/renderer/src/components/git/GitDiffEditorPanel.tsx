import { type ReactElement, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowLeftIcon, ArrowRightIcon } from '@phosphor-icons/react'
import { workbenchHost } from '@renderer/host/WorkbenchHost'
import { workbenchGitDiffScopeLabel } from '@renderer/models/git/changesPanel.model'
import {
  buildWorkbenchContentDiffRows,
  buildWorkbenchGitPatchRows,
  type WorkbenchUnifiedDiffRow,
} from '@renderer/models/git/workbenchGitDiffModel'
import {
  getWorkbenchGitChangeDisplayPath,
  type WorkbenchGitChangeItem,
} from '@renderer/models/git/workbenchGitModel'
import type { WorkbenchThemeId } from '@renderer/models/workbenchPreferences'
import { useStableWorkbenchMessageTranslate } from '@renderer/runtime/useStableWorkbenchMessaging'

import { Button } from '@velaros-ai/ui/primitives/buttons/Button'
import { IconButton } from '@velaros-ai/ui/primitives/buttons/IconButton'
import { Paragraph } from '@velaros-ai/ui/primitives/display/Paragraph'
import { Text } from '@velaros-ai/ui/primitives/display/Text'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@velaros-ai/ui/primitives/overlays/Dialog'
import { AppError, isEmpty } from '@velaros-ai/velaros/core'
import { Result } from '@velaros-ai/velaros/core/result'

import { type WorkspaceGitHunkAction } from '@shared/contracts/workspaceGit'
import {
  isWorkbenchGitWholeFilePatch,
  parseWorkbenchGitFilePatches,
  type WorkbenchGitFilePatch,
  type WorkbenchGitHunkSelector,
} from '@shared/workbenchGitPatch'

import {
  useWorkbenchGitDiffPreview,
  type WorkbenchEditorDiffPreview,
} from '../../hooks/useWorkbenchGitDiffPreview'
import styles from '../../styles/workbenchPageStyles'
import { useMemoizedFn } from '../../support/genericHooks'
import { preloadWhenIdle } from '../../support/lazyWithPreload'
import type { ReadOnlyDiffHunkActions } from '../editor/ReadOnlyDiffCodeMirror'
import { WorkbenchFileTypeIcon } from '../files/WorkbenchFileTypeIcon'

import { WorkbenchDiffLayoutToggle } from './WorkbenchDiffLayoutToggle'
import {
  WorkbenchDiffViewerCode,
  WorkbenchUnifiedDiffRows,
  type WorkbenchUnifiedDiffRowsHandle,
} from './WorkbenchUnifiedDiffRows'

interface GitDiffEditorPanelProps {
  projectRoot: string
  item: WorkbenchGitChangeItem
  workbenchTheme: WorkbenchThemeId
  focusFirstChangeRequestId?: number
  /** 编辑器里有没保存的内容：暂存、回滚读写的是磁盘上的文件，先提醒保存。 */
  hasUnsavedOpenTabs: boolean
  /** 按块暂存、回滚之后刷新 Git 状态（提交面板、文件树的颜色）。 */
  onGitStateChanged?: () => Promise<void> | void
}

interface GitHunkActionRequest {
  projectRoot: string
  path: string
  originalPath?: string
  group: WorkbenchGitChangeItem['group']
  hunkIndex: number
  hunk: WorkbenchGitHunkSelector
}

/** git 的补丁（未跟踪文件没有）。 */
function readPreviewPatch(preview: WorkbenchEditorDiffPreview): Nullable<WorkbenchGitFilePatch> {
  if (preview.scope === 'untracked') return null
  return parseWorkbenchGitFilePatches(preview.diff)[0] ?? null
}

/** 差异行：未跟踪文件整份都是新增；别的按 git 的补丁铺，读到了一侧全文时没变的行也铺开。 */
function buildPreviewRows(
  preview: WorkbenchEditorDiffPreview,
  patch: Nullable<WorkbenchGitFilePatch>
): WorkbenchUnifiedDiffRow[] {
  if (preview.scope === 'untracked')
    return buildWorkbenchContentDiffRows(preview.path, '', preview.content?.text ?? '', {
      fullFile: true,
    })
  return patch ? buildWorkbenchGitPatchRows(patch, preview.content).rows : []
}

export function GitDiffEditorPanel({
  projectRoot,
  item,
  workbenchTheme,
  focusFirstChangeRequestId = 0,
  hasUnsavedOpenTabs,
  onGitStateChanged,
}: GitDiffEditorPanelProps): ReactElement {
  const { t, messageLatest, tLatest } = useStableWorkbenchMessageTranslate()
  const diffViewRef = useRef<WorkbenchUnifiedDiffRowsHandle>(null)
  const displayPath = getWorkbenchGitChangeDisplayPath(item)
  const { preview, isLoading, error, reload } = useWorkbenchGitDiffPreview({ item, projectRoot })
  // 差异还在读的时候先把查看器本体的代码拉下来，读完就能画。
  useEffect(() => preloadWhenIdle([WorkbenchDiffViewerCode]), [])
  const patch = useMemo(() => (preview ? readPreviewPatch(preview) : null), [preview])
  const diffRows = useMemo(
    () => (preview ? buildPreviewRows(preview, patch) : []),
    [patch, preview]
  )
  const changedLineCount = useMemo(
    () => diffRows.filter((row) => row.kind === 'addition' || row.kind === 'deletion').length,
    [diffRows]
  )
  /** 正在处理的那一块（从 0 起）。 */
  const [pendingHunk, setPendingHunk] = useState<Nullable<number>>(null)
  /** 等用户确认的原始目标；差异刷新后仍由主进程核对同一块，不按索引重取。 */
  const [discardRequest, setDiscardRequest] = useState<Nullable<GitHunkActionRequest>>(null)

  useEffect(() => {
    setDiscardRequest(null)
  }, [item.group, item.originalPath, item.path, projectRoot])

  function captureHunkRequest(hunkIndex: number): Nullable<GitHunkActionRequest> {
    const hunk = patch?.hunks[hunkIndex]
    if (!hunk) return null
    return {
      projectRoot,
      path: item.path,
      originalPath: item.originalPath,
      group: item.group,
      hunkIndex,
      hunk: { header: hunk.header, lines: [...hunk.lines] },
    }
  }

  function checkHunkActionAllowed(actionId: string): boolean {
    if (actionId === 'unstage' || !hasUnsavedOpenTabs) return true
    messageLatest.current.warning({
      title: tLatest.current('workbench.gitUnsavedBlockedTitle'),
      description: tLatest.current('workbench.gitUnsavedBlockedDescription'),
    })
    return false
  }

  async function runHunkAction(request: GitHunkActionRequest, action: WorkspaceGitHunkAction): Promise<void> {
    setDiscardRequest(null)
    if (
      pendingHunk !== null ||
      request.projectRoot !== projectRoot || request.path !== item.path ||
      request.originalPath !== item.originalPath || request.group !== item.group
    ) return
    if (!checkHunkActionAllowed(action)) return
    try {
      setPendingHunk(request.hunkIndex)
      Result.unwrap(
        await workbenchHost.kernel.workspace.performWorkspaceGitHunkAction(request.projectRoot, {
          action,
          path: request.path,
          originalPath: request.originalPath,
          hunks: [request.hunk],
        })
      )
    } catch (actionError) {
      const appError = AppError.from(actionError)
      messageLatest.current.open({
        title: tLatest.current('workbench.gitHunkActionFailedTitle'),
        description:
          appError.message.trim() || tLatest.current('workbench.gitHunkActionFailedFallback'),
        tone: appError.code === 'VALIDATION' ? 'warning' : 'error',
        showClose: true,
      })
    } finally {
      setPendingHunk(null)
      // 原地重读差异，不等文件监听；提交面板、文件树的颜色跟着刷新。
      reload()
      await onGitStateChanged?.()
    }
  }

  const handleHunkAction = useMemoizedFn((hunkIndex: number, actionId: string): void => {
    if (pendingHunk !== null) return
    const request = captureHunkRequest(hunkIndex)
    if (!request) return
    if (!checkHunkActionAllowed(actionId)) return
    if (actionId === 'discard') {
      setDiscardRequest(request)
      return
    }
    if (actionId === 'stage' || actionId === 'unstage') void runHunkAction(request, actionId)
  })

  // 按块操作只在暂存、未暂存这两侧的差异上有；新建、删除、二进制、没读完整的补丁只能整个文件操作。
  const hunkSide = item.group === 'staged' || item.group === 'unstaged' ? item.group : null
  const hunkActions = useMemo<Nullable<ReadOnlyDiffHunkActions>>(() => {
    if (!preview || !patch || !hunkSide || preview.scope !== hunkSide) return null
    if (preview.truncated || isWorkbenchGitWholeFilePatch(patch)) return null
    return {
      actions:
        hunkSide === 'staged'
          ? [{ id: 'unstage', label: t('workbench.gitUnstageHunk') }]
          : [
              { id: 'stage', label: t('workbench.gitStageHunk') },
              { id: 'discard', label: t('workbench.gitDiscardHunk'), destructive: true },
            ],
      disabled: pendingHunk !== null,
      onAction: handleHunkAction,
    }
  }, [handleHunkAction, hunkSide, patch, pendingHunk, preview, t])

  const appliedFocusRequestRef = useRef(0)
  useEffect(() => {
    if (
      !focusFirstChangeRequestId ||
      !changedLineCount ||
      appliedFocusRequestRef.current === focusFirstChangeRequestId
    )
      return

    const frame = window.requestAnimationFrame(() => {
      diffViewRef.current?.goToChange(1)
      appliedFocusRequestRef.current = focusFirstChangeRequestId
    })
    return () => window.cancelAnimationFrame(frame)
  }, [changedLineCount, focusFirstChangeRequestId])
  return (
    <section className={styles.diffViewerPanel}>
      <div className={styles.diffViewerToolbar}>
        <div className={styles.diffViewerFile}>
          <WorkbenchFileTypeIcon fileName={item.fileName} size={14} />
          <Text truncate>
            {preview ? workbenchGitDiffScopeLabel(preview.scope, t) : t('workbench.gitDiffPreview')}
          </Text>
          <strong title={displayPath}>{displayPath}</strong>
        </div>
        <div className={styles.diffViewerSummaryGroup}>
          <div className={styles.diffViewerNav}>
            <WorkbenchDiffLayoutToggle />
            <IconButton
              variant="ghost"
              size="icon-sm"
              disabled={!changedLineCount}
              label={t('workbench.gitDiffPrevious')}
              title={t('workbench.gitDiffPrevious')}
              onClick={() => diffViewRef.current?.goToChange(-1)}
            >
              <ArrowLeftIcon size={14} />
            </IconButton>
            <IconButton
              variant="ghost"
              size="icon-sm"
              disabled={!changedLineCount}
              label={t('workbench.gitDiffNext')}
              title={t('workbench.gitDiffNext')}
              onClick={() => diffViewRef.current?.goToChange(1)}
            >
              <ArrowRightIcon size={14} />
            </IconButton>
          </div>
          <Paragraph spacing="none" className={styles.diffViewerSummary}>
            {t('workbench.gitDiffChangeSummary', { count: changedLineCount })}
          </Paragraph>
        </div>
      </div>
      <div className={styles.diffEditorScroll}>
        {isLoading ? (
          <Paragraph spacing="none" className={styles.editorPlaceholder}>
            {t('workbench.gitDiffLoading')}
          </Paragraph>
        ) : error ? (
          <Paragraph spacing="none" tone="muted" className={styles.gitDiffEmpty}>
            {error}
          </Paragraph>
        ) : !preview || isEmpty(diffRows) ? (
          <Paragraph spacing="none" tone="muted" className={styles.gitDiffEmpty}>
            {t('workbench.gitDiffEmpty')}
          </Paragraph>
        ) : (
          <>
            <WorkbenchUnifiedDiffRows
              ref={diffViewRef}
              rows={diffRows}
              path={preview.path}
              workbenchTheme={workbenchTheme}
              ariaLabel={t('workbench.gitDiffPreview')}
              hunkActions={hunkActions}
            />
            {!!preview.truncated && (
              <Paragraph spacing="none" tone="muted" className={styles.gitDiffTruncated}>
                {t('workbench.gitDiffTruncated')}
              </Paragraph>
            )}
          </>
        )}
      </div>
      <Dialog
        open={discardRequest !== null}
        onOpenChange={(open) => !open && setDiscardRequest(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('workbench.gitDiscardHunkConfirmTitle')}</DialogTitle>
            <DialogDescription>
              {t('workbench.gitDiscardHunkConfirm', { path: discardRequest?.path ?? item.path })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDiscardRequest(null)}>
              {t('common.cancel')}
            </Button>
            <Button
              variant="destructiveOutline"
              disabled={pendingHunk !== null}
              onClick={() =>
                discardRequest !== null && void runHunkAction(discardRequest, 'discard')
              }
            >
              {t('workbench.gitDiscardHunkConfirmAction')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  )
}
