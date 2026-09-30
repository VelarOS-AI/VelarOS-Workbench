import { type ReactElement, useEffect, useMemo, useRef } from 'react'
import { ArrowLeftIcon, ArrowRightIcon } from '@phosphor-icons/react'
import { useWorkbenchI18n } from '@renderer/i18n'
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
import type { WorkbenchThemeId } from '@renderer/models/settings/workbenchPreferences'

import { isEmpty } from '@velaros-ai/core'
import { IconButton } from '@velaros-ai/ui/primitives/buttons/IconButton'
import { Paragraph } from '@velaros-ai/ui/primitives/display/Paragraph'
import { Text } from '@velaros-ai/ui/primitives/display/Text'

import { parseWorkbenchGitFilePatches } from '@shared/workbenchGitPatch'

import {
  useWorkbenchGitDiffPreview,
  type WorkbenchEditorDiffPreview,
} from '../../hooks/useWorkbenchGitDiffPreview'
import styles from '../../styles/workbenchPageStyles'
import { WorkbenchFileTypeIcon } from '../files/WorkbenchFileTypeIcon'

import {
  WorkbenchUnifiedDiffRows,
  type WorkbenchUnifiedDiffRowsHandle,
} from './WorkbenchUnifiedDiffRows'

interface GitDiffEditorPanelProps {
  projectRoot: string
  item: WorkbenchGitChangeItem
  workbenchTheme: WorkbenchThemeId
  focusFirstChangeRequestId?: number
}

/** 差异行：未跟踪文件整份都是新增；别的按 git 的补丁铺，读到了一侧全文时没变的行也铺开。 */
function buildPreviewRows(preview: WorkbenchEditorDiffPreview): WorkbenchUnifiedDiffRow[] {
  if (preview.scope === 'untracked')
    return buildWorkbenchContentDiffRows(preview.path, '', preview.content?.text ?? '', {
      fullFile: true,
    })
  const [patch] = parseWorkbenchGitFilePatches(preview.diff)
  return patch ? buildWorkbenchGitPatchRows(patch, preview.content).rows : []
}

export function GitDiffEditorPanel({
  projectRoot,
  item,
  workbenchTheme,
  focusFirstChangeRequestId = 0,
}: GitDiffEditorPanelProps): ReactElement {
  const { t } = useWorkbenchI18n()
  const diffViewRef = useRef<WorkbenchUnifiedDiffRowsHandle>(null)
  const displayPath = getWorkbenchGitChangeDisplayPath(item)
  const { preview, isLoading, error } = useWorkbenchGitDiffPreview({ item, projectRoot })
  const diffRows = useMemo(() => (preview ? buildPreviewRows(preview) : []), [preview])
  const changedLineCount = useMemo(
    () => diffRows.filter((row) => row.kind === 'addition' || row.kind === 'deletion').length,
    [diffRows]
  )
  const appliedFocusRequestRef = useRef(0)
  useEffect(() => {
    if (
      !focusFirstChangeRequestId
      || !changedLineCount
      || appliedFocusRequestRef.current === focusFirstChangeRequestId
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
            />
            {!!preview.truncated && (
              <Paragraph spacing="none" tone="muted" className={styles.gitDiffTruncated}>
                {t('workbench.gitDiffTruncated')}
              </Paragraph>
            )}
          </>
        )}
      </div>
    </section>
  )
}
