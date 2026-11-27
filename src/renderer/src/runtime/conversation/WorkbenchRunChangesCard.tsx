import {
  createContext,
  memo,
  type ReactElement,
  useCallback,
  useContext,
  useId,
  useMemo,
  useState,
} from 'react'
import { CaretRightIcon, MagnifyingGlassIcon, SpinnerGapIcon } from '@phosphor-icons/react'
import { useWorkbenchI18n } from '@renderer/i18n/WorkbenchLocalizationProvider'

import {
  buildFileDiffSummaryFromUnifiedPatch,
  FileChangeSummaryList,
  type FileChangeSummaryListEntry,
  type FileDiffSummary,
} from '@velaros-ai/ui/conversation'
import { Button } from '@velaros-ai/ui/primitives/buttons/Button'
import { IconButton } from '@velaros-ai/ui/primitives/buttons/IconButton'
import { Text } from '@velaros-ai/ui/primitives/display/Text'
import { isPresent, optionalWhen } from '@velaros-ai/velaros/core'

import type {
  WorkbenchChatRunChangesSummary,
  WorkbenchChatRunFileChange,
} from '@shared/workbenchGit'

import { useWorkbenchRunChangeRecord } from '../workbenchRunChangeRecords'

import styles from '../../styles/WorkbenchRunChangesCard.module.css'

/** 当前会话里「消息 id → 这一轮的改动摘要」，由会话面挂在共享会话 UI 外层。 */
export interface WorkbenchRunChangesScope {
  readonly projectRoot: string
  readonly sessionId: string
  readonly summaries: ReadonlyMap<string, WorkbenchChatRunChangesSummary>
  /** 「查看」这一轮：在编辑区打开「AI 改动」对比标签页（宿主没接时退回共享 UI 的查看改动）。 */
  readonly onReviewRound?: (target: { sessionId: string; recordId: string }) => void
}

/**
 * 摘要经 context 送达而不是跟着运行标记走 props：摘要是一轮收尾之后才采集到的，共享气泡的 memo
 * 只比较它认识的标记字段，经 props 会被挡在门外；context 一变，卡片自己重渲。
 */
export const WorkbenchRunChangesScopeContext = createContext<WorkbenchRunChangesScope | null>(null)

function buildRunChangeDiffSummary(
  change: WorkbenchChatRunFileChange,
  patch: string,
  labels: { binary: string; patchOmitted: string }
): FileDiffSummary {
  if (!patch && change.patchOmitted)
    return {
      added: change.additions,
      removed: change.deletions,
      rows: [
        { kind: 'context', oldLineNumber: null, newLineNumber: null, text: labels.patchOmitted },
      ],
    }
  return buildFileDiffSummaryFromUnifiedPatch(patch, {
    additions: change.additions,
    deletions: change.deletions,
    binary: change.binary,
    binaryLabel: labels.binary,
  })
}

interface WorkbenchRunChangesCardProps {
  messageId: string
  formatPathForDisplay?: (path: string) => string
  onOpenEntry?: (entry: FileChangeSummaryListEntry) => void | Promise<void>
  onReviewEntries?: (entries: FileChangeSummaryListEntry[]) => void | Promise<void>
}

export const WorkbenchRunChangesCard = memo(function WorkbenchRunChangesCard({
  messageId,
  formatPathForDisplay,
  onOpenEntry,
  onReviewEntries,
}: WorkbenchRunChangesCardProps): ReactElement | null {
  const { t } = useWorkbenchI18n()
  const scope = useContext(WorkbenchRunChangesScopeContext)
  const summary = scope?.summaries.get(messageId) ?? null
  const { record, loading, failed } = useWorkbenchRunChangeRecord(
    scope?.projectRoot ?? '',
    scope?.sessionId ?? '',
    summary && summary.fileCount > 0 && !summary.error ? summary.recordId : null,
    summary?.capturedAt ?? 0
  )
  const [expandedKeys, setExpandedKeys] = useState<ReadonlySet<string>>(() => new Set())
  const [expanded, setExpanded] = useState(false)
  const bodyId = useId()
  const titleId = `${bodyId}-project`
  const projectRoot = scope?.projectRoot ?? ''
  const projectName = projectRoot.split(/[\\/]/u).filter(Boolean).at(-1) ?? projectRoot
  const binaryLabel = t('chat.fileChangeSummaryBinary')
  const patchOmittedLabel = t('chat.fileChangeSummaryPatchOmitted')
  const entries = useMemo<FileChangeSummaryListEntry[]>(
    () =>
      (record?.changes ?? []).map((change) => ({
        key: change.path,
        rootPath: projectRoot,
        path: change.path,
        added: change.additions,
        removed: change.deletions,
        addedLabel: optionalWhen(change.statsOmitted, '+?'),
        removedLabel: optionalWhen(change.statsOmitted, '-?'),
        diffSummaries: (change.patches.length ? change.patches : ['']).map((patch) =>
          buildRunChangeDiffSummary(change, patch, {
            binary: binaryLabel,
            patchOmitted: patchOmittedLabel,
          })
        ),
      })),
    [binaryLabel, patchOmittedLabel, projectRoot, record]
  )
  const toggleEntry = useCallback((key: string): void => {
    setExpandedKeys((current) => {
      const next = new Set(current)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }, [])
  if (!summary || (summary.fileCount === 0 && !summary.error)) return null

  if (summary.error)
    return (
      <div className={styles.root}>
        <div className={styles.feedback}>{t('chat.fileChangeSummaryUnavailable')}</div>
      </div>
    )

  return (
    <div className={styles.root} role="group" aria-labelledby={titleId}>
      <div className={styles.header}>
        <div className={styles.headerSummary}>
          <span id={titleId} className={styles.projectTitle} title={projectRoot}>
            {projectName}
          </span>
          <Text>{t('chat.fileChangeSummaryCommitted', { count: summary.fileCount })}</Text>
          <Text className={styles.added}>+{summary.statsOmitted ? '?' : summary.additions}</Text>
          <Text className={styles.removed}>-{summary.statsOmitted ? '?' : summary.deletions}</Text>
        </div>
        <div className={styles.headerActions}>
          {(!!scope?.onReviewRound || !!onReviewEntries) && (
            <Button
              variant="ghost"
              size="sm"
              hoverBackground={false}
              className={styles.reviewButton}
              disabled={entries.length === 0}
              onClick={() => {
                if (scope?.onReviewRound)
                  scope.onReviewRound({ sessionId: scope.sessionId, recordId: summary.recordId })
                else void onReviewEntries?.(entries)
              }}
            >
              <MagnifyingGlassIcon size={15} />
              {t('chat.fileChangeSummaryReview')}
            </Button>
          )}
          <IconButton
            label={t(
              expanded
                ? 'chat.fileChangeSummaryCollapseProject'
                : 'chat.fileChangeSummaryExpandProject',
              { project: projectName }
            )}
            variant="ghost"
            size="icon-sm"
            hoverBackground={false}
            className={styles.expandButton}
            aria-controls={bodyId}
            aria-expanded={expanded}
            onClick={() => setExpanded((current) => !current)}
          >
            <CaretRightIcon size={15} aria-hidden="true" className={styles.chevron} />
          </IconButton>
        </div>
      </div>
      <div id={bodyId} hidden={!expanded}>
        {expanded &&
          (loading ? (
            <div className={styles.feedback}>
              <SpinnerGapIcon size={14} className={styles.spinIcon} />
              <Text>{t('chat.fileChangeSummaryLoading')}</Text>
            </div>
          ) : failed ? (
            <div className={styles.feedback}>{t('chat.fileChangeSummaryUnavailable')}</div>
          ) : (
            <FileChangeSummaryList
              entries={entries}
              expandedKeys={expandedKeys}
              formatPathForDisplay={formatPathForDisplay}
              onToggleEntry={toggleEntry}
              onOpenEntry={optionalWhen(
                isPresent(onOpenEntry),
                (entry: FileChangeSummaryListEntry) => {
                  void onOpenEntry?.(entry)
                }
              )}
            />
          ))}
      </div>
    </div>
  )
})
