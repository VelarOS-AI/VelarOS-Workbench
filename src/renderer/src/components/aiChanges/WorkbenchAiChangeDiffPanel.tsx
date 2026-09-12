import { type ReactElement, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowLeftIcon, ArrowRightIcon, ArrowSquareOutIcon } from '@phosphor-icons/react'
import { useWorkbenchI18n } from '@renderer/i18n'
import type { WorkbenchThemeId } from '@renderer/models/settings/workbenchPreferences'

import { Button } from '@velaros-ai/ui/primitives/buttons/Button'
import { IconButton } from '@velaros-ai/ui/primitives/buttons/IconButton'
import { Paragraph } from '@velaros-ai/ui/primitives/display/Paragraph'
import { Text } from '@velaros-ai/ui/primitives/display/Text'

import type { WorkbenchAiChangeTab } from '../../hooks/useWorkbenchAiChanges'
import { buildWorkbenchAiChangeDiffView } from '../../models/chat/workbenchAiChangeRounds'
import type { WorkbenchUnifiedDiffRow } from '../../models/git/workbenchGitDiffModel'
import {
  readWorkbenchRunChangeBaseFile,
  useWorkbenchRunChangeRecord,
} from '../../runtime/workbenchRunChangeRecords'
import pageStyles from '../../styles/workbenchPageStyles'
import { WorkbenchFileTypeIcon } from '../files/WorkbenchFileTypeIcon'
import {
  WorkbenchUnifiedDiffRows,
  type WorkbenchUnifiedDiffRowsHandle,
} from '../git/WorkbenchUnifiedDiffRows'

import styles from './WorkbenchAiChanges.module.css'

interface WorkbenchAiChangeDiffPanelProps {
  projectRoot: string
  tab: WorkbenchAiChangeTab
  workbenchTheme: WorkbenchThemeId
  onOpenFile: (path: string, line: number) => void
}

interface BaseFileLoad {
  readonly key: string
  readonly content: string | null
}

/** 编辑器里对应到这处改动的行：第一行新增的行，纯删除时取删除处紧挨着的那一行。 */
function findFirstChangedLine(rows: readonly WorkbenchUnifiedDiffRow[]): number {
  let lastNewLine = 1
  for (const row of rows) {
    if (row.kind === 'addition' && row.newLine) return row.newLine
    if (row.kind === 'deletion') return lastNewLine
    if (row.newLine) lastNewLine = row.newLine
  }
  return 1
}

/**
 * 「AI 改动」标签页：某一轮里某个文件改了什么，只读。
 *
 * 能拼出前后全文时显示整份文件、新增行绿底删除行红底，打开时跳到第一处改动；这一轮的起点快照读不到时
 * 退回补丁本身（只有改动附近的行），顶上标一句说明。
 */
export function WorkbenchAiChangeDiffPanel({
  projectRoot,
  tab,
  workbenchTheme,
  onOpenFile,
}: WorkbenchAiChangeDiffPanelProps): ReactElement {
  const { t } = useWorkbenchI18n()
  const diffViewRef = useRef<WorkbenchUnifiedDiffRowsHandle>(null)
  // 还在跑的一轮每采一次，标签上的采集时刻就跟着换：对比内容随之重读。
  const { record, loading, failed } = useWorkbenchRunChangeRecord(
    projectRoot,
    tab.sessionId,
    tab.recordId,
    tab.capturedAt
  )
  const change = record?.changes.find((candidate) => candidate.path === tab.path) ?? null
  const status = change?.status ?? tab.status
  const needsBaseFile =
    !!change && change.status !== 'added' && !change.binary && !change.patchOmitted && !!change.patch
  const baseKey = `${tab.id}\0${record?.baseCommitId ?? ''}`
  const [baseLoad, setBaseLoad] = useState<BaseFileLoad | null>(null)

  useEffect(() => {
    if (!needsBaseFile || !record?.baseCommitId) return undefined
    let cancelled = false
    void readWorkbenchRunChangeBaseFile(projectRoot, tab.sessionId, tab.recordId, tab.path).then(
      (content) => {
        if (!cancelled) setBaseLoad({ key: baseKey, content })
      }
    )
    return () => {
      cancelled = true
    }
  }, [baseKey, needsBaseFile, projectRoot, record?.baseCommitId, tab.path, tab.recordId, tab.sessionId])

  const baseReady = !needsBaseFile || !record?.baseCommitId || baseLoad?.key === baseKey
  const baseContent = baseLoad?.key === baseKey ? baseLoad.content : null
  const view = useMemo(
    () => (change && baseReady ? buildWorkbenchAiChangeDiffView(change, baseContent) : null),
    [baseContent, baseReady, change]
  )
  const rows = view?.kind === 'rows' ? view.rows : null
  const changedLineCount = useMemo(
    () =>
      rows?.filter((row) => row.kind === 'addition' || row.kind === 'deletion').length ?? 0,
    [rows]
  )

  // 打开或切到这个标签时，先把第一处改动带进视野。
  const focusedTabRef = useRef<string | null>(null)
  useEffect(() => {
    if (!rows || changedLineCount === 0 || focusedTabRef.current === tab.id) return undefined
    const frame = window.requestAnimationFrame(() => {
      diffViewRef.current?.goToChange(1)
      focusedTabRef.current = tab.id
    })
    return () => window.cancelAnimationFrame(frame)
  }, [changedLineCount, rows, tab.id])

  const statusLabel =
    status === 'added'
      ? t('workbench.aiChangesStatusAdded')
      : status === 'deleted'
        ? t('workbench.aiChangesStatusDeleted')
        : t('workbench.aiChangesStatusModified')

  return (
    <section className={pageStyles.diffViewerPanel} data-ai-change-tab={tab.id}>
      <div className={pageStyles.diffViewerToolbar}>
        <div className={pageStyles.diffViewerFile}>
          <WorkbenchFileTypeIcon fileName={tab.path} size={14} />
          <span className={styles.statusChip} data-status={status}>
            {statusLabel}
          </span>
          <strong title={tab.path}>{tab.path}</strong>
          {tab.runNumber > 0 && (
            <Text tone="caption" truncate>
              {t('workbench.aiChangesRunLabel', { number: tab.runNumber })}
            </Text>
          )}
        </div>
        <div className={pageStyles.diffViewerSummaryGroup}>
          {!!change && (
            <span className={styles.lineStats}>
              <span className={styles.additions}>+{change.additions}</span>
              <span className={styles.deletions}>-{change.deletions}</span>
            </span>
          )}
          <div className={pageStyles.diffViewerNav}>
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
          <Button
            variant="ghost"
            size="sm"
            disabled={status === 'deleted'}
            title={t('workbench.aiChangesOpenFile')}
            onClick={() => onOpenFile(tab.path, rows ? findFirstChangedLine(rows) : 1)}
          >
            <ArrowSquareOutIcon size={14} />
            {t('workbench.aiChangesOpenFile')}
          </Button>
        </div>
      </div>
      {view?.kind === 'rows' && !view.fullFile && (
        <div className={pageStyles.aiChangesDiffFallbackNotice}>
          {t('workbench.aiChangesPatchOnly')}
        </div>
      )}
      <div className={pageStyles.diffEditorScroll}>
        {loading || (!!change && !baseReady) ? (
          <Paragraph spacing="none" className={pageStyles.editorPlaceholder}>
            {t('workbench.aiChangesLoading')}
          </Paragraph>
        ) : failed || !change ? (
          <Paragraph spacing="none" tone="muted" className={pageStyles.gitDiffEmpty}>
            {t('workbench.aiChangesUnavailable')}
          </Paragraph>
        ) : view?.kind === 'binary' ? (
          <Paragraph spacing="none" tone="muted" className={pageStyles.gitDiffEmpty}>
            {t('workbench.aiChangesBinary')}
          </Paragraph>
        ) : view?.kind === 'omitted' ? (
          <Paragraph spacing="none" tone="muted" className={pageStyles.gitDiffEmpty}>
            {t('workbench.aiChangesOmitted', {
              additions: change.additions,
              deletions: change.deletions,
            })}
          </Paragraph>
        ) : rows ? (
          <WorkbenchUnifiedDiffRows
            ref={diffViewRef}
            rows={rows}
            path={tab.path}
            workbenchTheme={workbenchTheme}
            ariaLabel={t('workbench.aiChangesDiffLabel', { path: tab.path })}
          />
        ) : (
          <Paragraph spacing="none" tone="muted" className={pageStyles.gitDiffEmpty}>
            {t('workbench.aiChangesNoLineChanges')}
          </Paragraph>
        )}
      </div>
    </section>
  )
}
