import { type ReactElement, useMemo, useRef } from 'react'
import { ArrowLeftIcon, ArrowRightIcon } from '@phosphor-icons/react'
import { useWorkbenchI18n } from '@workbench/i18n'
import { buildWorkbenchContentDiffRows } from '@workbench/models/git/workbenchGitDiffModel'
import {
  getWorkbenchGitChangeDisplayPath,
  type WorkbenchGitChangeItem,
} from '@workbench/models/git/workbenchGitModel'
import type { WorkbenchThemeId } from '@workbench/models/settings/workbenchPreferences'

import { isEmpty } from '@velaros-ai/core'
import { IconButton } from '@velaros-ai/ui/primitives/buttons/IconButton'
import { FileTypeIcon } from '@velaros-ai/ui/primitives/display/FileTypeIcon'
import { Paragraph } from '@velaros-ai/ui/primitives/display/Paragraph'
import { Text } from '@velaros-ai/ui/primitives/display/Text'

import {
  useWorkbenchGitDiffPreview,
  type WorkbenchEditorDiffPreview,
} from '../../hooks/useWorkbenchGitDiffPreview'
import styles from '../../styles/workbenchPageStyles'

import {
  WorkbenchUnifiedDiffRows,
  type WorkbenchUnifiedDiffRowsHandle,
} from './WorkbenchUnifiedDiffRows'

interface GitDiffEditorPanelProps {
  projectRoot: string
  item: WorkbenchGitChangeItem
  workbenchTheme: WorkbenchThemeId
}

function diffScopeLabel(
  scope: WorkbenchEditorDiffPreview['scope'],
  t: ReturnType<typeof useWorkbenchI18n>['t']
): string {
  switch (scope) {
    case 'commit':
      return t('workbench.gitDiffCommit')
    case 'staged':
      return t('workbench.gitDiffStaged')
    case 'untracked':
      return t('workbench.gitDiffUntracked')
    default:
      return t('workbench.gitDiffWorking')
  }
}

export function GitDiffEditorPanel({
  projectRoot,
  item,
  workbenchTheme,
}: GitDiffEditorPanelProps): ReactElement {
  const { t } = useWorkbenchI18n()
  const diffViewRef = useRef<WorkbenchUnifiedDiffRowsHandle>(null)
  const displayPath = getWorkbenchGitChangeDisplayPath(item)
  const { preview, isLoading, error } = useWorkbenchGitDiffPreview({ item, projectRoot })
  const diffRows = useMemo(() => {
    if (!preview) return []
    return buildWorkbenchContentDiffRows(
      preview.path,
      preview.beforeContent,
      preview.afterContent,
      { fullFile: true }
    )
  }, [preview])
  const changedLineCount = useMemo(
    () => diffRows.filter((row) => row.kind === 'addition' || row.kind === 'deletion').length,
    [diffRows]
  )
  return (
    <section className={styles.diffViewerPanel}>
      <div className={styles.diffViewerToolbar}>
        <div className={styles.diffViewerFile}>
          <FileTypeIcon fileName={item.fileName} size={14} />
          <Text truncate>
            {preview ? diffScopeLabel(preview.scope, t) : t('workbench.gitDiffPreview')}
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
