import { type KeyboardEvent, type ReactElement, useMemo } from 'react'
import {
  ArrowCounterClockwiseIcon,
  ArrowSquareOutIcon,
  SparkleIcon,
  SpinnerGapIcon,
  XIcon,
} from '@phosphor-icons/react'

import { IconButton } from '@velaros-ai/ui/primitives/buttons/IconButton'
import { FileTypeIcon } from '@velaros-ai/ui/primitives/display/FileTypeIcon'
import { Text } from '@velaros-ai/ui/primitives/display/Text'
import { ScrollArea } from '@velaros-ai/ui/primitives/layout/ScrollArea'
import { useWorkbenchI18n } from '@velaros-ai/workbench/i18n'
import {
  getWorkbenchGitChangeDisplayPath,
  getWorkbenchGitChangeItemKey,
  isSameWorkbenchGitChangeItem,
  type WorkbenchGitChangeItem,
} from '@velaros-ai/workbench/models/git/workbenchGitModel'
import type { WorkbenchThemeId } from '@velaros-ai/workbench/models/settings/workbenchPreferences'

import styles from '../../styles/workbenchPageStyles'
import { GitDiffEditorPanel } from '../git/GitDiffEditorPanel'

type WorkbenchChatChangeAction = 'added' | 'deleted' | 'modified' | 'renamed' | 'copied'

interface WorkbenchChatChangePreviewPanelProps {
  activeItem: WorkbenchGitChangeItem
  items: WorkbenchGitChangeItem[]
  pendingFileAction: Nullable<string>
  projectRoot: string
  workbenchTheme: WorkbenchThemeId
  onOpenFile: (path: string) => void
  onClose: () => void
  onDiscardItem: (item: WorkbenchGitChangeItem) => void
  onSelectItem: (item: WorkbenchGitChangeItem) => void
}

function getChangeAction(item: WorkbenchGitChangeItem): WorkbenchChatChangeAction {
  const statuses = `${item.indexStatus}${item.workTreeStatus}`

  if (item.originalPath || statuses.includes('R')) return 'renamed'

  if (statuses.includes('C')) return 'copied'

  if (statuses.includes('D')) return 'deleted'

  if (statuses.includes('A') || statuses.includes('?')) return 'added'

  return 'modified'
}

function getChangeActionLabel(
  action: WorkbenchChatChangeAction,
  t: ReturnType<typeof useWorkbenchI18n>['t']
): string {
  switch (action) {
    case 'added':
      return t('workbench.aiChangePreviewAdded')
    case 'deleted':
      return t('workbench.aiChangePreviewDeleted')
    case 'renamed':
      return t('workbench.aiChangePreviewRenamed')
    case 'copied':
      return t('workbench.aiChangePreviewCopied')
    default:
      return t('workbench.aiChangePreviewModified')
  }
}

export function WorkbenchChatChangePreviewPanel({
  activeItem,
  items,
  pendingFileAction,
  projectRoot,
  workbenchTheme,
  onOpenFile,
  onClose,
  onDiscardItem,
  onSelectItem,
}: WorkbenchChatChangePreviewPanelProps): ReactElement {
  const { t } = useWorkbenchI18n()
  const counts = useMemo(
    () =>
      items.reduce(
        (next, item) => {
          next[getChangeAction(item)] += 1
          return next
        },
        {
          added: 0,
          copied: 0,
          deleted: 0,
          modified: 0,
          renamed: 0,
        } satisfies Record<WorkbenchChatChangeAction, number>
      ),
    [items]
  )
  const summary = useMemo(
    () =>
      [
        counts.added ? t('workbench.aiChangePreviewAddedCount', { count: counts.added }) : null,
        counts.modified
          ? t('workbench.aiChangePreviewModifiedCount', { count: counts.modified })
          : null,
        counts.deleted
          ? t('workbench.aiChangePreviewDeletedCount', { count: counts.deleted })
          : null,
        counts.renamed
          ? t('workbench.aiChangePreviewRenamedCount', { count: counts.renamed })
          : null,
        counts.copied ? t('workbench.aiChangePreviewCopiedCount', { count: counts.copied }) : null,
      ].filter((value) => !!value),
    [counts, t]
  )

  function handleRowKeyDown(
    event: KeyboardEvent<HTMLDivElement>,
    item: WorkbenchGitChangeItem
  ): void {
    if (event.key !== 'Enter' && event.key !== ' ') return

    event.preventDefault()
    onSelectItem(item)
  }

  return (
    <section className={styles.aiChangePreviewPanel}>
      <aside className={styles.aiChangePreviewSidebar}>
        <header className={styles.aiChangePreviewHeader}>
          <div className={styles.aiChangePreviewTitle}>
            <SparkleIcon size={15} />
            <Text truncate>{t('workbench.aiChangePreviewTitle')}</Text>
          </div>
          <Text tone="caption" truncate>
            {summary.length
              ? summary.join(' / ')
              : t('workbench.aiChangePreviewFileCount', { count: items.length })}
          </Text>
          <IconButton
            variant="ghost"
            size="icon-sm"
            label={t('workbench.aiChangePreviewClose')}
            title={t('workbench.aiChangePreviewClose')}
            className={styles.aiChangePreviewCloseButton}
            onClick={onClose}
          >
            <XIcon size={14} />
          </IconButton>
        </header>
        <ScrollArea className={styles.aiChangePreviewScroll}>
          <div className={styles.aiChangePreviewList}>
            {items.map((item) => {
              const action = getChangeAction(item)
              const isDeleted = action === 'deleted'
              const pendingDiscard = pendingFileAction === `discard:${item.path}`
              const displayPath = getWorkbenchGitChangeDisplayPath(item)

              return (
                <div
                  key={getWorkbenchGitChangeItemKey(item)}
                  className={styles.aiChangePreviewRow}
                  data-active={isSameWorkbenchGitChangeItem(activeItem, item)}
                  data-change-action={action}
                  role="button"
                  tabIndex={0}
                  title={displayPath}
                  onClick={() => onSelectItem(item)}
                  onDoubleClick={() => {
                    if (!isDeleted) {
                      onOpenFile(item.path)
                    }
                  }}
                  onKeyDown={(event) => handleRowKeyDown(event, item)}
                >
                  <FileTypeIcon
                    className={styles.aiChangePreviewFileIcon}
                    fileName={item.fileName}
                    size={15}
                  />
                  <div className={styles.aiChangePreviewFileCopy}>
                    <Text className={styles.aiChangePreviewFileName} truncate>
                      {item.fileName}
                    </Text>
                    <Text className={styles.aiChangePreviewFilePath} tone="caption" truncate>
                      {displayPath}
                    </Text>
                  </div>
                  <span className={styles.aiChangePreviewStatus}>
                    {getChangeActionLabel(action, t)}
                  </span>
                  <IconButton
                    variant="ghost"
                    size="icon-sm"
                    label={t('workbench.gitRollback')}
                    title={t('workbench.gitRollback')}
                    disabled={!!pendingFileAction}
                    className={styles.aiChangePreviewRowButton}
                    onClick={(event) => {
                      event.stopPropagation()
                      onDiscardItem(item)
                    }}
                  >
                    {pendingDiscard ? (
                      <SpinnerGapIcon size={14} className={styles.spinIcon} />
                    ) : (
                      <ArrowCounterClockwiseIcon size={14} />
                    )}
                  </IconButton>
                  <IconButton
                    variant="ghost"
                    size="icon-sm"
                    label={t('workbench.openChangedFile')}
                    title={t('workbench.openChangedFile')}
                    disabled={isDeleted}
                    className={styles.aiChangePreviewRowButton}
                    onClick={(event) => {
                      event.stopPropagation()
                      onOpenFile(item.path)
                    }}
                  >
                    <ArrowSquareOutIcon size={14} />
                  </IconButton>
                </div>
              )
            })}
          </div>
        </ScrollArea>
      </aside>
      <div className={styles.aiChangePreviewDiff}>
        <GitDiffEditorPanel
          projectRoot={projectRoot}
          item={activeItem}
          workbenchTheme={workbenchTheme}
        />
      </div>
    </section>
  )
}
