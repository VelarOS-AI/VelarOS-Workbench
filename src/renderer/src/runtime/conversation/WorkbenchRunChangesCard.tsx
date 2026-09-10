import {
  createContext,
  memo,
  type ReactElement,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react'
import { MagnifyingGlassIcon, SpinnerGapIcon } from '@phosphor-icons/react'
import { useWorkbenchI18n } from '@renderer/i18n'

import {
  buildFileDiffSummaryFromUnifiedPatch,
  FileChangeSummaryList,
  type FileChangeSummaryListEntry,
  type FileDiffSummary,
} from '@velaros-ai/ui/conversation'
import { Button } from '@velaros-ai/ui/primitives/buttons/Button'
import { Text } from '@velaros-ai/ui/primitives/display/Text'

import type {
  WorkbenchChatRunChangesRecord,
  WorkbenchChatRunChangesSummary,
  WorkbenchChatRunFileChange,
} from '@shared/workbenchGit'

import styles from './WorkbenchRunChangesCard.module.css'

/** 当前会话里「消息 id → 这一轮的改动摘要」，由会话面挂在共享会话 UI 外层。 */
export interface WorkbenchRunChangesScope {
  readonly projectRoot: string
  readonly sessionId: string
  readonly summaries: ReadonlyMap<string, WorkbenchChatRunChangesSummary>
}

/**
 * 摘要经 context 送达而不是跟着运行标记走 props：摘要是一轮收尾之后才采集到的，共享气泡的 memo
 * 只比较它认识的标记字段，经 props 会被挡在门外；context 一变，卡片自己重渲。
 */
export const WorkbenchRunChangesScopeContext = createContext<WorkbenchRunChangesScope | null>(null)

/** 读过的记录在内存里留一小份：会话列表是虚拟滚动的，卡片滚出去再回来不必重读磁盘。 */
const RecordCacheLimit = 24
const recordCache = new Map<string, WorkbenchChatRunChangesRecord>()

function readCachedRecord(key: string): WorkbenchChatRunChangesRecord | undefined {
  const record = recordCache.get(key)
  if (record) {
    recordCache.delete(key)
    recordCache.set(key, record)
  }
  return record
}

function cacheRecord(key: string, record: WorkbenchChatRunChangesRecord): void {
  recordCache.set(key, record)
  const oldest = recordCache.keys().next()
  if (recordCache.size > RecordCacheLimit && !oldest.done) recordCache.delete(oldest.value)
}

interface RecordLoad {
  readonly key: string
  readonly record: WorkbenchChatRunChangesRecord | null
}

/** 补丁全文在主进程的记录文件里，卡片挂出来时按 recordId 读一次。 */
function useRunChangesRecord(
  scope: WorkbenchRunChangesScope | null,
  summary: WorkbenchChatRunChangesSummary | null
): { record: WorkbenchChatRunChangesRecord | null; loading: boolean; failed: boolean } {
  const projectRoot = scope?.projectRoot ?? ''
  const sessionId = scope?.sessionId ?? ''
  const recordId = summary && summary.fileCount > 0 && !summary.error ? summary.recordId : null
  const key = recordId ? `${projectRoot}\0${sessionId}\0${recordId}` : null
  const [load, setLoad] = useState<RecordLoad | null>(() => {
    const cached = key ? readCachedRecord(key) : undefined
    return key && cached ? { key, record: cached } : null
  })

  useEffect(() => {
    if (!key || !recordId) return undefined
    const cached = readCachedRecord(key)
    if (cached) {
      setLoad({ key, record: cached })
      return undefined
    }
    let cancelled = false
    void window.velarosWorkbenchGit
      .readChatRunChanges({ workspaceRoot: projectRoot, sessionId, recordId })
      .then(
        (result) => {
          if (cancelled) return
          if (result.ok && result.value) cacheRecord(key, result.value)
          setLoad({ key, record: result.ok ? result.value : null })
        },
        () => {
          if (!cancelled) setLoad({ key, record: null })
        }
      )
    return () => {
      cancelled = true
    }
  }, [key, projectRoot, recordId, sessionId])

  const current = load?.key === key ? load : null
  return {
    record: current?.record ?? null,
    loading: !!key && !current,
    failed: !!current && !current.record,
  }
}

function buildRunChangeDiffSummary(
  change: WorkbenchChatRunFileChange,
  labels: { binary: string; patchOmitted: string }
): FileDiffSummary {
  if (change.patchOmitted)
    return {
      added: change.additions,
      removed: change.deletions,
      rows: [{ kind: 'context', oldLineNumber: null, newLineNumber: null, text: labels.patchOmitted }],
    }
  return buildFileDiffSummaryFromUnifiedPatch(change.patch, {
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

/**
 * 一轮回答末尾的「本轮改动」卡（Desktop `MessageFileChangeSummary` 的对位件）：这一轮在磁盘上改了
 * 哪些文件、各增删多少行，展开看逐行差异，点开跳进编辑器。
 *
 * 数据是这一轮开跑前后两个工作树快照的 git diff；Workbench 的文件编辑没有可单独撤销的事务，
 * 所以不带 Desktop 的逐文件撤销 / 恢复——整轮撤回走回溯。
 */
export const WorkbenchRunChangesCard = memo(function WorkbenchRunChangesCard({
  messageId,
  formatPathForDisplay,
  onOpenEntry,
  onReviewEntries,
}: WorkbenchRunChangesCardProps): ReactElement | null {
  const { t } = useWorkbenchI18n()
  const scope = useContext(WorkbenchRunChangesScopeContext)
  const summary = scope?.summaries.get(messageId) ?? null
  const { record, loading, failed } = useRunChangesRecord(scope, summary)
  const [expandedKeys, setExpandedKeys] = useState<ReadonlySet<string>>(() => new Set())
  const projectRoot = scope?.projectRoot ?? ''
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
        diffSummaries: [
          buildRunChangeDiffSummary(change, {
            binary: binaryLabel,
            patchOmitted: patchOmittedLabel,
          }),
        ],
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
    <div className={styles.root}>
      <div className={styles.header}>
        <div className={styles.headerSummary}>
          <Text>{t('chat.fileChangeSummaryFilesChanged', { count: summary.fileCount })}</Text>
          <Text className={styles.added}>+{summary.additions}</Text>
          <Text className={styles.removed}>-{summary.deletions}</Text>
        </div>
        {!!onReviewEntries && (
          <Button
            variant="ghost"
            size="sm"
            hoverBackground={false}
            className={styles.reviewButton}
            disabled={entries.length === 0}
            onClick={() => {
              void onReviewEntries(entries)
            }}
          >
            <MagnifyingGlassIcon size={15} />
            {t('chat.fileChangeSummaryReview')}
          </Button>
        )}
      </div>
      {loading ? (
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
          {...(onOpenEntry
            ? {
                onOpenEntry: (entry: FileChangeSummaryListEntry) => {
                  void onOpenEntry(entry)
                },
              }
            : {})}
        />
      )}
    </div>
  )
})
