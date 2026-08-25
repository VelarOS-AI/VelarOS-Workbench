import {
  type KeyboardEvent,
  type ReactElement,
  useEffect,
  useMemo,
  useState,
} from 'react'
import {
  ArrowUpRightIcon,
  CaretDownIcon,
  CaretRightIcon,
  CheckIcon,
  ClockCounterClockwiseIcon,
  CrosshairIcon,
  GearSixIcon,
  SparkleIcon,
  SpinnerGapIcon,
} from '@phosphor-icons/react'
import { workbenchHost } from '@renderer/host'
import { getWorkbenchFilePresentationVariant } from '@renderer/models/files/workbenchFilePresentation'
import {
  buildCommitPanelGroups,
  type CommitPanelGroupId,
} from '@renderer/models/git/commitPanel.model'
import {
  buildWorkbenchGitCommitDraft,
  getWorkbenchGitChangeDisplayPath,
  getWorkbenchGitChangeItemTone,
  type WorkbenchGitChangeItem,
  type WorkbenchOpenDiffOptions,
} from '@renderer/models/git/workbenchGitModel'
import { useStableWorkbenchMessageTranslate } from '@renderer/runtime/useStableWorkbenchMessaging'

import { AppError } from '@velaros-ai/core/error'
import { Result } from '@velaros-ai/core/result'
import { Textarea } from '@velaros-ai/ui/primitives/forms/Textarea'
import { ScrollArea } from '@velaros-ai/ui/primitives/layout/ScrollArea'
import { BubbleTooltip } from '@velaros-ai/ui/primitives/overlays/Tooltip'

import styles from '../../styles/workbenchPageStyles'
import { WorkbenchFileTypeIcon } from '../files/WorkbenchFileTypeIcon'

import type { WorkbenchGitPanelSessionProps } from './workbenchGitPanelProps'

export interface WorkbenchCommitPanelProps {
  git: WorkbenchGitPanelSessionProps
  onOpenDiff: (item: WorkbenchGitChangeItem, options?: WorkbenchOpenDiffOptions) => void
  onOpenFile: (path: string) => Promise<void> | void
}

/** 拆分前 Workbench 左上角“提交”工具：只负责本次提交，不承载 Git 历史。 */
export function WorkbenchCommitPanel({
  git: {
    workspaceRoot,
    gitSshKeyPath,
    summary,
    changeItems,
    hasUnsavedOpenTabs,
    isLoading,
    error,
    selectedFilePath,
    onRefresh,
  },
  onOpenDiff,
  onOpenFile,
}: WorkbenchCommitPanelProps): ReactElement {
  const { t, locale, messageLatest, tLatest } = useStableWorkbenchMessageTranslate()
  const [commitMessage, setCommitMessage] = useState('')
  const [busyAction, setBusyAction] = useState<Nullable<'commit' | 'generate' | 'push'>>(null)
  const [pendingFileAction, setPendingFileAction] = useState<Nullable<string>>(null)
  const [selectedChangePath, setSelectedChangePath] = useState<Nullable<string>>(null)
  const [selectedCommitPaths, setSelectedCommitPaths] = useState<ReadonlySet<string>>(
    () => new Set()
  )
  const [expandedGroups, setExpandedGroups] = useState<ReadonlySet<CommitPanelGroupId>>(
    () => new Set(['changed', 'untracked'])
  )

  const status = summary?.status ?? null
  const groups = useMemo(
    () =>
      buildCommitPanelGroups(changeItems).map((group) => ({
        ...group,
        label:
          group.id === 'changed'
            ? t('workbench.commitGroupChanged')
            : t('workbench.commitGroupUnversioned'),
      })),
    [changeItems, t]
  )
  const selectedItem = useMemo(
    () =>
      changeItems.find((item) => item.path === selectedChangePath) ??
      changeItems.find((item) => item.path === selectedFilePath) ??
      changeItems[0] ??
      null,
    [changeItems, selectedChangePath, selectedFilePath]
  )
  const selectedItems = useMemo(
    () => changeItems.filter((item) => selectedCommitPaths.has(item.path)),
    [changeItems, selectedCommitPaths]
  )
  const actionItems = selectedItems.length ? selectedItems : changeItems
  const actionPaths = useMemo(() => {
    const paths = new Set<string>()
    for (const item of selectedItems) {
      if (item.originalPath) paths.add(item.originalPath)
      paths.add(item.path)
    }
    return [...paths]
  }, [selectedItems])
  const commitDraft = useMemo(
    () => buildWorkbenchGitCommitDraft(actionItems, locale),
    [actionItems, locale]
  )

  useEffect(() => {
    const availablePaths = new Set(changeItems.map((item) => item.path))
    setSelectedCommitPaths((current) => {
      const next = new Set([...current].filter((path) => availablePaths.has(path)))
      return next.size === current.size ? current : next
    })
  }, [changeItems])

  function warnUnsavedOpenTabs(): boolean {
    if (!hasUnsavedOpenTabs) return false
    messageLatest.current.warning({
      title: tLatest.current('workbench.gitUnsavedBlockedTitle'),
      description: tLatest.current('workbench.gitUnsavedBlockedDescription'),
    })
    return true
  }

  function toggleGroup(groupId: CommitPanelGroupId): void {
    setExpandedGroups((current) => {
      const next = new Set(current)
      if (next.has(groupId)) next.delete(groupId)
      else next.add(groupId)
      return next
    })
  }

  function toggleItem(item: WorkbenchGitChangeItem): void {
    setSelectedChangePath(item.path)
    setSelectedCommitPaths((current) => {
      const next = new Set(current)
      if (next.has(item.path)) next.delete(item.path)
      else next.add(item.path)
      return next
    })
  }

  function toggleGroupItems(items: WorkbenchGitChangeItem[]): void {
    const shouldDeselect = items.every((item) => selectedCommitPaths.has(item.path))
    setSelectedCommitPaths((current) => {
      const next = new Set(current)
      for (const item of items) {
        if (shouldDeselect) next.delete(item.path)
        else next.add(item.path)
      }
      return next
    })
    if (!shouldDeselect && items[0]) setSelectedChangePath(items[0].path)
  }

  async function rollbackItems(items: WorkbenchGitChangeItem[]): Promise<void> {
    if (!items.length || pendingFileAction || warnUnsavedOpenTabs()) return
    const confirmed =
      items.length === 1
        ? window.confirm(tLatest.current('workbench.gitDiscardConfirm', { path: items[0].path }))
        : window.confirm(
            tLatest.current('workbench.gitDiscardSelectedConfirm', { count: items.length })
          )
    if (!confirmed) return

    try {
      setPendingFileAction(items.length === 1 ? `discard:${items[0].path}` : 'discard:selected')
      for (const item of items) {
        Result.unwrap(
          await workbenchHost.kernel.workspace.performWorkspaceGitFileAction(
            workspaceRoot,
            item.path,
            'discard'
          )
        )
      }
      setSelectedCommitPaths((current) => {
        const next = new Set(current)
        for (const item of items) next.delete(item.path)
        return next
      })
      await onRefresh()
      messageLatest.current.success({
        title: tLatest.current('workbench.gitDiscardSuccessTitle'),
        description:
          items.length === 1
            ? items[0].path
            : tLatest.current('workbench.commitGroupFileCount', { count: items.length }),
      })
    } catch (actionError) {
      showActionError(
        actionError,
        tLatest.current('workbench.gitFileActionFailedTitle'),
        tLatest.current('workbench.gitFileActionFailedFallback')
      )
    } finally {
      setPendingFileAction(null)
    }
  }

  async function generateCommitMessage(): Promise<void> {
    if (!summary?.repository || !changeItems.length || busyAction) return
    try {
      setBusyAction('generate')
      const result = Result.unwrap(
        await workbenchHost.kernel.workspace.generateWorkspaceGitCommitMessage(
          workspaceRoot,
          locale,
          actionPaths.length ? actionPaths : undefined
        )
      )
      setCommitMessage(result.message?.trim() || commitDraft)
    } catch (actionError) {
      showActionError(
        actionError,
        tLatest.current('workbench.gitGenerateCommitMessageFailedTitle'),
        tLatest.current('workbench.gitGenerateCommitMessageFailedFallback')
      )
    } finally {
      setBusyAction(null)
    }
  }

  async function commitChanges(): Promise<void> {
    if (!summary?.repository || !changeItems.length || busyAction || warnUnsavedOpenTabs()) return
    try {
      setBusyAction('commit')
      const result = Result.unwrap(
        await workbenchHost.kernel.workspace.commitWorkspaceGitChanges(
          workspaceRoot,
          locale,
          commitMessage.trim() || undefined,
          actionPaths.length ? actionPaths : undefined
        )
      )
      setCommitMessage('')
      setSelectedCommitPaths(new Set())
      await onRefresh()
      messageLatest.current.success({
        title: tLatest.current('workbench.gitCommitSuccessTitle'),
        description: tLatest.current('workbench.gitCommitSuccessDescription', {
          sha: result.commit.commitSha.slice(0, 7),
          files: result.commit.changedFiles,
        }),
      })
    } catch (actionError) {
      showActionError(
        actionError,
        tLatest.current('workbench.gitCommitFailedTitle'),
        tLatest.current('workbench.gitCommitFailedFallback')
      )
      await onRefresh()
    } finally {
      setBusyAction(null)
    }
  }

  async function pushChanges(): Promise<void> {
    if (!summary?.repository || busyAction || warnUnsavedOpenTabs()) return
    if (!window.confirm(tLatest.current('workbench.gitPushConfirm'))) return
    try {
      setBusyAction('push')
      const result = Result.unwrap(
        await workbenchHost.kernel.workspace.performWorkspaceGitAction(workspaceRoot, 'upload', {
          privateKeyPath: gitSshKeyPath,
        })
      )
      await onRefresh()
      messageLatest.current.success({
        title: tLatest.current('workbench.gitUploadSuccessTitle'),
        description: tLatest.current('workbench.gitRemoteActionSuccessDescription', {
          branch: result.action.branch,
        }),
      })
    } catch (actionError) {
      showActionError(
        actionError,
        tLatest.current('workbench.gitUploadFailedTitle'),
        tLatest.current('workbench.gitRemoteActionFailedFallback')
      )
    } finally {
      setBusyAction(null)
    }
  }

  function showActionError(actionError: unknown, title: string, fallback: string): void {
    const appError = AppError.from(actionError)
    messageLatest.current.open({
      title,
      description: appError.message.trim() || fallback,
      tone: appError.code === 'VALIDATION' ? 'warning' : 'error',
      showClose: true,
    })
  }

  function handleKeyDown(event: KeyboardEvent<HTMLElement>): void {
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
      event.preventDefault()
      void commitChanges()
      return
    }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'a') {
      if (event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLInputElement)
        return
      event.preventDefault()
      setSelectedCommitPaths(new Set(changeItems.map((item) => item.path)))
    }
  }

  return (
    <section className={styles.commitToolPanel} onKeyDown={handleKeyDown}>
      <div className={styles.panelHeader}>
        <div className={styles.panelTitleGroup}>
          <div className={styles.commitPanelTitleRow}>
            <span className={styles.panelTitle}>{t('workbench.commitToolWindow')}</span>
          </div>
        </div>
      </div>
      {!summary?.repository ? (
        <p className={styles.panelEmpty}>
          {isLoading ? t('workbench.gitLoading') : error || t('workbench.gitNoRepository')}
        </p>
      ) : (
        <>
          <div className={styles.commitListPane} tabIndex={0}>
            <ScrollArea className={styles.commitChangeScroll}>
              <div className={styles.commitChangeContent}>
                {status?.isClean ? (
                  <p className={styles.gitCleanState}>{t('workbench.gitClean')}</p>
                ) : (
                  <div className={styles.commitGroupList}>
                    {groups.map((group, groupIndex) => {
                      const isExpanded = expandedGroups.has(group.id)
                      const selectedCount = group.items.filter((item) =>
                        selectedCommitPaths.has(item.path)
                      ).length
                      const allSelected = selectedCount === group.items.length
                      return (
                        <section key={group.id} className={styles.commitGroup}>
                          <div className={styles.commitGroupRow}>
                            <button
                              type="button"
                              className={styles.commitDisclosureButton}
                              onClick={() => toggleGroup(group.id)}
                            >
                              {isExpanded ? <CaretDownIcon size={11} /> : <CaretRightIcon size={11} />}
                            </button>
                            <button
                              type="button"
                              className={styles.commitGroupCheckbox}
                              data-checked={allSelected}
                              data-partial={selectedCount > 0 && !allSelected}
                              onClick={() => toggleGroupItems(group.items)}
                            >
                              {allSelected && <CheckIcon size={9} weight="bold" />}
                            </button>
                            <button
                              type="button"
                              className={styles.commitGroupMain}
                              onClick={() => toggleGroup(group.id)}
                            >
                              <span className={styles.commitGroupTitle}>{group.label}</span>
                              <span className={styles.commitGroupCount}>
                                {t('workbench.commitGroupFileCount', { count: group.items.length })}
                              </span>
                            </button>
                          </div>
                          {isExpanded && (
                            <div className={styles.commitFileList}>
                              {group.items.map((item) => {
                                const checked = selectedCommitPaths.has(item.path)
                                const displayPath = getWorkbenchGitChangeDisplayPath(item)
                                return (
                                  <div
                                    key={`${item.group}:${item.path}:${item.statusCode}`}
                                    className={styles.commitFileRow}
                                    data-git-tone={getWorkbenchGitChangeItemTone(item)}
                                    data-active={selectedItem?.path === item.path}
                                    data-selected={checked}
                                  >
                                    <button
                                      type="button"
                                      className={styles.commitFileCheckbox}
                                      data-checked={checked}
                                      aria-label={displayPath}
                                      onClick={() => toggleItem(item)}
                                    >
                                      {checked && <CheckIcon size={9} weight="bold" />}
                                    </button>
                                    <button
                                      type="button"
                                      className={styles.commitFileMain}
                                      onClick={() => setSelectedChangePath(item.path)}
                                      onDoubleClick={() =>
                                        onOpenDiff(item, { focusFirstChange: true })
                                      }
                                    >
                                      <span
                                        className={styles.commitFileIcon}
                                        data-kind={getWorkbenchFilePresentationVariant({
                                          fileName: item.fileName,
                                        })}
                                      >
                                        <WorkbenchFileTypeIcon fileName={item.fileName} size={14} />
                                      </span>
                                      <span className={styles.commitFileName}>{item.fileName}</span>
                                      <span className={styles.commitFilePath}>{displayPath}</span>
                                    </button>
                                    <span className={styles.commitFileStatus}>{item.statusCode}</span>
                                    <button
                                      type="button"
                                      className={styles.commitFileRollbackButton}
                                      title={t('workbench.gitRollback')}
                                      disabled={!!pendingFileAction || hasUnsavedOpenTabs}
                                      onClick={() => void rollbackItems([item])}
                                    >
                                      {pendingFileAction === `discard:${item.path}` ? (
                                        <SpinnerGapIcon size={12} className={styles.spinIcon} />
                                      ) : (
                                        <ClockCounterClockwiseIcon size={12} />
                                      )}
                                    </button>
                                    <button
                                      type="button"
                                      className={styles.commitFileLocateButton}
                                      title={t('workbench.openChangedFile')}
                                      onClick={() => void onOpenFile(item.path)}
                                    >
                                      <CrosshairIcon size={12} />
                                    </button>
                                  </div>
                                )
                              })}
                            </div>
                          )}
                          {groupIndex < groups.length - 1 && (
                            <span className={styles.commitGroupSpacer} aria-hidden="true" />
                          )}
                        </section>
                      )
                    })}
                  </div>
                )}
              </div>
            </ScrollArea>
          </div>
          <form className={styles.commitForm} onSubmit={(event) => event.preventDefault()}>
            <Textarea
              className={styles.gitCommitInput}
              variant="ghost"
              size="sm"
              rows={6}
              value={commitMessage}
              placeholder={commitDraft || t('workbench.gitCommitPlaceholder')}
              disabled={!!busyAction}
              onChange={(event) => setCommitMessage(event.target.value)}
            />
            {hasUnsavedOpenTabs && (
              <p className={styles.gitCommitWarning}>
                {t('workbench.gitUnsavedBlockedDescription')}
              </p>
            )}
            <div className={styles.gitCommitFooter}>
              <div className={styles.commitFooterLeft}>
                <span className={styles.commitSettingsGlyph} aria-hidden="true">
                  <GearSixIcon size={16} />
                </span>
                <CommitIconButton
                  label={t('workbench.gitGenerateCommitMessage')}
                  disabled={!!busyAction || !changeItems.length}
                  onClick={() => void generateCommitMessage()}
                >
                  {busyAction === 'generate' ? (
                    <SpinnerGapIcon size={14} className={styles.spinIcon} />
                  ) : (
                    <SparkleIcon size={15} />
                  )}
                </CommitIconButton>
              </div>
              <div className={styles.commitButtonRow}>
                <CommitIconButton
                  label={t('workbench.gitRollback')}
                  disabled={!actionItems.length || !!pendingFileAction || hasUnsavedOpenTabs}
                  onClick={() => void rollbackItems(actionItems)}
                >
                  {pendingFileAction === 'discard:selected' ? (
                    <SpinnerGapIcon size={14} className={styles.spinIcon} />
                  ) : (
                    <ClockCounterClockwiseIcon size={15} />
                  )}
                </CommitIconButton>
                <CommitIconButton
                  label={t('workbench.gitCommitAction')}
                  disabled={!!busyAction || !changeItems.length || hasUnsavedOpenTabs}
                  onClick={() => void commitChanges()}
                >
                  {busyAction === 'commit' ? (
                    <SpinnerGapIcon size={14} className={styles.spinIcon} />
                  ) : (
                    <CheckIcon size={15} />
                  )}
                </CommitIconButton>
                <CommitIconButton
                  label={t('workbench.gitUpload')}
                  disabled={!!busyAction || hasUnsavedOpenTabs}
                  onClick={() => void pushChanges()}
                >
                  {busyAction === 'push' ? (
                    <SpinnerGapIcon size={14} className={styles.spinIcon} />
                  ) : (
                    <ArrowUpRightIcon size={15} />
                  )}
                </CommitIconButton>
              </div>
            </div>
          </form>
        </>
      )}
    </section>
  )
}

function CommitIconButton({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string
  disabled: boolean
  onClick: () => void
  children: ReactElement
}): ReactElement {
  return (
    <BubbleTooltip content={label} ariaLabel={label} delayDuration={80} sideOffset={6}>
      <span className={styles.commitTooltipTrigger}>
        <button
          type="button"
          className={styles.commitIconButton}
          aria-label={label}
          disabled={disabled}
          onClick={onClick}
        >
          {children}
        </button>
      </span>
    </BubbleTooltip>
  )
}
