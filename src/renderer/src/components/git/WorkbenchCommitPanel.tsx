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
  CheckCircleIcon,
  CheckIcon,
  ClockCounterClockwiseIcon,
  CrosshairIcon,
  MinusIcon,
  PlusIcon,
  SparkleIcon,
  SpinnerGapIcon,
  StopCircleIcon,
} from '@phosphor-icons/react'
import {
  describeWorkbenchGitRemoteActionCancel,
  reportWorkbenchGitRemoteActionFailure,
  useWorkbenchGitRemoteAction,
} from '@renderer/hooks/useWorkbenchGitRemoteAction'
import { workbenchHost } from '@renderer/host'
import { getWorkbenchFilePresentationVariant } from '@renderer/models/files/workbenchFilePresentation'
import {
  buildCommitPanelGroups,
  type CommitPanelGroupId,
  deriveCommitPanelGitPaths,
  deriveRollbackTargetItems,
  getCommitPanelItemKey,
  isCommitPanelRollbackDeletion,
  resolveCommitPanelCommitMode,
  summarizeCommitPanelCommitAll,
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
import { Button } from '@velaros-ai/ui/primitives/buttons/Button'
import { Textarea } from '@velaros-ai/ui/primitives/forms/Textarea'
import { ScrollArea } from '@velaros-ai/ui/primitives/layout/ScrollArea'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@velaros-ai/ui/primitives/overlays/Dialog'
import { BubbleTooltip } from '@velaros-ai/ui/primitives/overlays/Tooltip'

import type { WorkspaceGitFileAction } from '@shared/contracts'

import styles from '../../styles/workbenchPageStyles'
import { WorkbenchFileTypeIcon } from '../files/WorkbenchFileTypeIcon'

import type { WorkbenchGitPanelSessionProps } from './workbenchGitPanelProps'

export interface WorkbenchCommitPanelProps {
  git: WorkbenchGitPanelSessionProps
  onOpenDiff: (item: WorkbenchGitChangeItem, options?: WorkbenchOpenDiffOptions) => void
  onOpenFile: (path: string) => Promise<void> | void
}

/** 报冲突时点名的文件：最多列 3 个，其余说个数。 */
const ConflictNamesShown = 3

const NoCommitPaths: ReadonlySet<string> = new Set()

/**
 * 拆分前 Workbench 左上角“提交”工具：只负责本次提交，不承载 Git 历史。
 *
 * 暂存区里有改动时提交按钮提交暂存区（同 VS Code，没暂存的留在工作区），这时不显示勾选框；暂存区是空的
 * 时照勾选的文件提交它们在工作区里的样子（`git commit --only`），一个都没勾时先问要不要提交全部。
 */
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
  const [busyAction, setBusyAction] = useState<Nullable<'commit' | 'generate'>>(null)
  // 这个项目正在跑的远端操作（这里的推送，或顶栏发起的拉取、同步）：跑着的时候推送按钮换成取消。
  const remoteAction = useWorkbenchGitRemoteAction(workspaceRoot)
  /** 拉取、同步正在改工作区里的文件：等它跑完再提交。 */
  const pulling =
    remoteAction.running?.action === 'pull' || remoteAction.running?.action === 'sync'
  const [pendingFileAction, setPendingFileAction] = useState<Nullable<string>>(null)
  const [rollbackRequest, setRollbackRequest] =
    useState<Nullable<WorkbenchGitChangeItem[]>>(null)
  const [commitAllRequest, setCommitAllRequest] =
    useState<Nullable<WorkbenchGitChangeItem[]>>(null)
  /** 在列表里点中的那一行（分组 + 路径：暂存了一部分的文件两侧各一行）。 */
  const [selectedChangeKey, setSelectedChangeKey] = useState<Nullable<string>>(null)
  const [selectedCommitPaths, setSelectedCommitPaths] = useState<ReadonlySet<string>>(
    () => new Set()
  )
  const [expandedGroups, setExpandedGroups] = useState<ReadonlySet<CommitPanelGroupId>>(
    () => new Set(['conflicted', 'staged', 'changed', 'untracked'])
  )

  const status = summary?.status ?? null
  const commitMode = resolveCommitPanelCommitMode(changeItems)
  const selectable = commitMode === 'selection'
  const groups = useMemo(
    () =>
      buildCommitPanelGroups(changeItems).map((group) => ({
        ...group,
        label:
          group.id === 'conflicted'
            ? t('workbench.commitGroupConflicted')
            : group.id === 'staged'
              ? t('workbench.gitGroupStaged')
              : group.id === 'changed'
                ? t('workbench.commitGroupChanged')
                : t('workbench.commitGroupUnversioned'),
      })),
    [changeItems, t]
  )
  const conflictItems = useMemo(
    () => changeItems.filter((item) => item.group === 'conflicted'),
    [changeItems]
  )
  const stagedItems = useMemo(
    () => changeItems.filter((item) => item.group === 'staged'),
    [changeItems]
  )
  const clickedItem = useMemo(
    () => changeItems.find((item) => getCommitPanelItemKey(item) === selectedChangeKey) ?? null,
    [changeItems, selectedChangeKey]
  )
  const selectedItem =
    clickedItem ??
    changeItems.find((item) => item.path === selectedFilePath) ??
    changeItems[0] ??
    null
  const selectedItems = useMemo(
    () => (selectable ? changeItems.filter((item) => selectedCommitPaths.has(item.path)) : []),
    [changeItems, selectable, selectedCommitPaths]
  )
  // 回滚只对用户明确选的文件：勾选的，或者点中的那一行；默认高亮的那一行不算。
  const rollbackTargets = useMemo(
    () =>
      deriveRollbackTargetItems(
        changeItems,
        selectable ? selectedCommitPaths : NoCommitPaths,
        clickedItem
      ),
    [changeItems, clickedItem, selectable, selectedCommitPaths]
  )
  // 输入框里的提交说明草稿，按这次会提交的文件拟：暂存区；或勾选的；一个都没勾时是全部。
  const commitDraft = useMemo(
    () =>
      buildWorkbenchGitCommitDraft(
        commitMode === 'staged'
          ? stagedItems
          : selectedItems.length > 0
            ? selectedItems
            : changeItems,
        locale
      ),
    [changeItems, commitMode, locale, selectedItems, stagedItems]
  )
  const conflictNames = describeConflictNames(conflictItems)
  const rollbackDeletions = rollbackRequest?.filter(isCommitPanelRollbackDeletion) ?? []
  const rollbackKeepsStaged = !!rollbackRequest?.some((item) =>
    stagedItems.some((staged) => staged.path === item.path)
  )
  const commitAllSummary = commitAllRequest
    ? summarizeCommitPanelCommitAll(commitAllRequest)
    : null

  useEffect(() => {
    const availablePaths = new Set(changeItems.map((item) => item.path))
    setSelectedCommitPaths((current) => {
      const next = new Set([...current].filter((path) => availablePaths.has(path)))
      return next.size === current.size ? current : next
    })
  }, [changeItems])

  // 暂存区里一有改动，提交的就是暂存区：之前勾选的不再作数，清掉，免得以为勾选的会被提交。
  useEffect(() => {
    if (!selectable) setSelectedCommitPaths((current) => (current.size ? new Set() : current))
  }, [selectable])

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
    setSelectedChangeKey(getCommitPanelItemKey(item))
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
    if (!shouldDeselect && items[0]) setSelectedChangeKey(getCommitPanelItemKey(items[0]))
  }

  /** 一批文件做同一个 Git 操作：一次请求，失败时照原话提示；成功与否都刷新列表。 */
  async function runFileAction(
    items: readonly WorkbenchGitChangeItem[],
    action: WorkspaceGitFileAction,
    pendingKey: string
  ): Promise<boolean> {
    if (!items.length || pendingFileAction) return false
    try {
      setPendingFileAction(pendingKey)
      Result.unwrap(
        await workbenchHost.kernel.workspace.performWorkspaceGitFileAction(
          workspaceRoot,
          [...new Set(items.map((item) => item.path))],
          action
        )
      )
      await onRefresh()
      return true
    } catch (actionError) {
      showActionError(
        actionError,
        tLatest.current('workbench.gitFileActionFailedTitle'),
        tLatest.current('workbench.gitFileActionFailedFallback')
      )
      await onRefresh()
      return false
    } finally {
      setPendingFileAction(null)
    }
  }

  /** 暂存读的是磁盘上的文件：编辑器里还有没保存的内容时先提醒保存，免得暂存了旧的。 */
  function stageItems(items: readonly WorkbenchGitChangeItem[], pendingKey: string): void {
    if (!items.length || pendingFileAction || warnUnsavedOpenTabs()) return
    void runFileAction(items, 'stage', pendingKey)
  }

  /** 取消暂存只动暂存区，不碰工作区里的文件。 */
  function unstageItems(items: readonly WorkbenchGitChangeItem[], pendingKey: string): void {
    void runFileAction(items, 'unstage', pendingKey)
  }

  async function rollbackItems(items: WorkbenchGitChangeItem[]): Promise<void> {
    if (!items.length || pendingFileAction || warnUnsavedOpenTabs()) return
    setRollbackRequest(null)
    const done = await runFileAction(
      items,
      'discard',
      items.length === 1 ? `discard:${getCommitPanelItemKey(items[0])}` : 'discard:selected'
    )
    if (!done) return
    setSelectedCommitPaths((current) => {
      const next = new Set(current)
      for (const item of items) next.delete(item.path)
      return next
    })
    messageLatest.current.success({
      title: tLatest.current('workbench.gitDiscardSuccessTitle'),
      description:
        items.length === 1
          ? items[0].path
          : tLatest.current('workbench.commitGroupFileCount', { count: items.length }),
    })
  }

  function requestRollback(items: WorkbenchGitChangeItem[]): void {
    if (!items.length || pendingFileAction || warnUnsavedOpenTabs()) return
    setRollbackRequest([...items])
  }

  async function resolveConflict(item: WorkbenchGitChangeItem): Promise<void> {
    if (pendingFileAction || warnUnsavedOpenTabs()) return
    const done = await runFileAction([item], 'resolve', `resolve:${getCommitPanelItemKey(item)}`)
    if (!done) return
    messageLatest.current.success({
      title: tLatest.current('workbench.gitMarkResolvedSuccessTitle'),
      description: item.path,
    })
  }

  async function generateCommitMessage(): Promise<void> {
    if (!summary?.repository || !changeItems.length || busyAction) return
    // 暂存模式按暂存区里的文件生成；勾选模式按勾选的，一个都没勾时按全部。
    const paths = deriveCommitPanelGitPaths(commitMode === 'staged' ? stagedItems : selectedItems)
    try {
      setBusyAction('generate')
      const result = Result.unwrap(
        await workbenchHost.kernel.workspace.generateWorkspaceGitCommitMessage(
          workspaceRoot,
          locale,
          paths.length ? paths : undefined
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

  /**
   * 暂存区里有改动时提交暂存区；否则勾了文件就只提交它们，一个都没勾时先问要不要提交全部，
   * 不默默全提交。
   */
  function commitChanges(): void {
    if (!summary?.repository || !changeItems.length || busyAction || pulling) return
    if (warnUnsavedOpenTabs()) return
    if (conflictItems.length) {
      messageLatest.current.warning({
        title: tLatest.current('workbench.gitCommitConflictsTitle'),
        description: tLatest.current('workbench.gitCommitConflictsBlocked', {
          files: conflictNames,
        }),
      })
      return
    }
    if (commitMode === 'staged') {
      void submitCommit(null)
      return
    }
    if (!selectedItems.length) {
      setCommitAllRequest([...changeItems])
      return
    }
    void submitCommit(selectedItems)
  }

  /** `items` 为 null：提交暂存区。 */
  async function submitCommit(items: Nullable<WorkbenchGitChangeItem[]>): Promise<void> {
    if ((items && !items.length) || busyAction) return
    try {
      setCommitAllRequest(null)
      setBusyAction('commit')
      const message = commitMessage.trim() || undefined
      const result = Result.unwrap(
        items
          ? await workbenchHost.kernel.workspace.commitWorkspaceGitChanges(
              workspaceRoot,
              locale,
              message,
              deriveCommitPanelGitPaths(items)
            )
          : await workbenchHost.kernel.workspace.commitWorkspaceGitStagedChanges(
              workspaceRoot,
              locale,
              message
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
    if (!summary?.repository || busyAction || remoteAction.running) return
    if (warnUnsavedOpenTabs()) return
    if (!window.confirm(tLatest.current('workbench.gitPushConfirm'))) return
    try {
      const result = await remoteAction.run('upload', { privateKeyPath: gitSshKeyPath })
      await onRefresh()
      messageLatest.current.success({
        title: tLatest.current('workbench.gitUploadSuccessTitle'),
        description: tLatest.current('workbench.gitRemoteActionSuccessDescription', {
          branch: result.action.branch,
        }),
      })
    } catch (actionError) {
      reportWorkbenchGitRemoteActionFailure(actionError, 'upload', { messageLatest, tLatest })
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

  function describeConflictNames(items: readonly WorkbenchGitChangeItem[]): string {
    const names = items
      .slice(0, ConflictNamesShown)
      .map((item) => item.path)
      .join(locale === 'zh-CN' ? '、' : ', ')
    return items.length > ConflictNamesShown
      ? t('workbench.gitConflictMoreFiles', { files: names, count: items.length })
      : names
  }

  function handleKeyDown(event: KeyboardEvent<HTMLElement>): void {
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
      event.preventDefault()
      commitChanges()
      return
    }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'a') {
      if (event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLInputElement)
        return
      if (!selectable) return
      event.preventDefault()
      setSelectedCommitPaths(new Set(changeItems.map((item) => item.path)))
    }
  }

  /** 分组标题右边的操作：已暂存的全部取消暂存，更改、未跟踪的全部暂存；冲突逐个标记，没有。 */
  function renderGroupAction(
    groupId: CommitPanelGroupId,
    items: WorkbenchGitChangeItem[]
  ): ReactElement {
    if (groupId === 'conflicted') return <span aria-hidden="true" />
    const pendingKey = `${groupId === 'staged' ? 'unstage' : 'stage'}:group:${groupId}`
    const label = t(groupId === 'staged' ? 'workbench.gitUnstageAll' : 'workbench.gitStageAll')
    return (
      <button
        type="button"
        className={styles.commitGroupActionButton}
        title={label}
        aria-label={label}
        disabled={!!pendingFileAction || (groupId !== 'staged' && hasUnsavedOpenTabs)}
        onClick={() =>
          groupId === 'staged' ? unstageItems(items, pendingKey) : stageItems(items, pendingKey)
        }
      >
        {pendingFileAction === pendingKey ? (
          <SpinnerGapIcon size={12} className={styles.spinIcon} />
        ) : groupId === 'staged' ? (
          <MinusIcon size={12} />
        ) : (
          <PlusIcon size={12} />
        )}
      </button>
    )
  }

  /** 行上第一个操作：冲突是标记为已解决，已暂存的是取消暂存，其余是暂存。 */
  function renderStageAction(item: WorkbenchGitChangeItem, itemKey: string): ReactElement {
    if (item.group === 'conflicted') {
      const pendingKey = `resolve:${itemKey}`
      return (
        <button
          type="button"
          className={styles.commitFileRollbackButton}
          title={t('workbench.gitMarkResolved')}
          aria-label={t('workbench.gitMarkResolved')}
          disabled={!!pendingFileAction || hasUnsavedOpenTabs}
          onClick={() => void resolveConflict(item)}
        >
          {pendingFileAction === pendingKey ? (
            <SpinnerGapIcon size={12} className={styles.spinIcon} />
          ) : (
            <CheckCircleIcon size={12} />
          )}
        </button>
      )
    }
    const staged = item.group === 'staged'
    const pendingKey = `${staged ? 'unstage' : 'stage'}:${itemKey}`
    const label = t(staged ? 'workbench.gitUnstageFile' : 'workbench.gitStageFile')
    return (
      <button
        type="button"
        className={styles.commitFileRollbackButton}
        title={label}
        aria-label={label}
        disabled={!!pendingFileAction || (!staged && hasUnsavedOpenTabs)}
        onClick={() =>
          staged ? unstageItems([item], pendingKey) : stageItems([item], pendingKey)
        }
      >
        {pendingFileAction === pendingKey ? (
          <SpinnerGapIcon size={12} className={styles.spinIcon} />
        ) : staged ? (
          <MinusIcon size={12} />
        ) : (
          <PlusIcon size={12} />
        )}
      </button>
    )
  }

  return (
    <>
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
                          <div
                            className={styles.commitGroupRow}
                            data-selectable={selectable}
                            data-group={group.id}
                          >
                            <button
                              type="button"
                              className={styles.commitDisclosureButton}
                              onClick={() => toggleGroup(group.id)}
                            >
                              {isExpanded ? <CaretDownIcon size={11} /> : <CaretRightIcon size={11} />}
                            </button>
                            {selectable && (
                              <button
                                type="button"
                                className={styles.commitGroupCheckbox}
                                data-checked={allSelected}
                                data-partial={selectedCount > 0 && !allSelected}
                                onClick={() => toggleGroupItems(group.items)}
                              >
                                {allSelected && <CheckIcon size={9} weight="bold" />}
                              </button>
                            )}
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
                            {renderGroupAction(group.id, group.items)}
                          </div>
                          {isExpanded && (
                            <div className={styles.commitFileList}>
                              {group.items.map((item) => {
                                const itemKey = getCommitPanelItemKey(item)
                                const checked = selectable && selectedCommitPaths.has(item.path)
                                const displayPath = getWorkbenchGitChangeDisplayPath(item)
                                const conflicted = item.group === 'conflicted'
                                const rollbackable =
                                  item.group === 'unstaged' || item.group === 'untracked'
                                const conflictTitle = conflicted
                                  ? t('workbench.gitConflictStatus', {
                                      kind: t(
                                        `workbench.gitConflictKinds.${item.indexStatus}${item.workTreeStatus}`
                                      ),
                                    })
                                  : undefined
                                return (
                                  <div
                                    key={`${itemKey}:${item.statusCode}`}
                                    className={styles.commitFileRow}
                                    data-selectable={selectable}
                                    data-git-tone={getWorkbenchGitChangeItemTone(item)}
                                    data-active={
                                      !!selectedItem &&
                                      getCommitPanelItemKey(selectedItem) === itemKey
                                    }
                                    data-selected={checked}
                                  >
                                    {selectable && (
                                      <button
                                        type="button"
                                        className={styles.commitFileCheckbox}
                                        data-checked={checked}
                                        aria-label={displayPath}
                                        onClick={() => toggleItem(item)}
                                      >
                                        {checked && <CheckIcon size={9} weight="bold" />}
                                      </button>
                                    )}
                                    <button
                                      type="button"
                                      className={styles.commitFileMain}
                                      onClick={() => setSelectedChangeKey(itemKey)}
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
                                    <span
                                      className={styles.commitFileStatus}
                                      title={conflictTitle}
                                      aria-label={conflictTitle}
                                    >
                                      {conflicted ? '!' : item.statusCode}
                                    </span>
                                    {renderStageAction(item, itemKey)}
                                    {rollbackable ? (
                                      <button
                                        type="button"
                                        className={styles.commitFileRollbackButton}
                                        title={t('workbench.gitRollback')}
                                        aria-label={t('workbench.gitRollback')}
                                        disabled={!!pendingFileAction || hasUnsavedOpenTabs}
                                        onClick={() => requestRollback([item])}
                                      >
                                        {pendingFileAction === `discard:${itemKey}` ? (
                                          <SpinnerGapIcon size={12} className={styles.spinIcon} />
                                        ) : (
                                          <ClockCounterClockwiseIcon size={12} />
                                        )}
                                      </button>
                                    ) : (
                                      <span aria-hidden="true" />
                                    )}
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
            {commitMode === 'staged' && (
              <p className={styles.gitCommitHint}>
                {t('workbench.gitCommitStagedHint', { count: stagedItems.length })}
              </p>
            )}
            {hasUnsavedOpenTabs && (
              <p className={styles.gitCommitWarning}>
                {t('workbench.gitUnsavedBlockedDescription')}
              </p>
            )}
            {!!conflictItems.length && (
              <p className={styles.gitCommitWarning}>
                {t('workbench.gitCommitConflictsBlocked', { files: conflictNames })}
              </p>
            )}
            <div className={styles.gitCommitFooter}>
              <div className={styles.commitFooterLeft}>
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
                  disabled={!rollbackTargets.length || !!pendingFileAction || hasUnsavedOpenTabs}
                  onClick={() => requestRollback(rollbackTargets)}
                >
                  {pendingFileAction === 'discard:selected' ? (
                    <SpinnerGapIcon size={14} className={styles.spinIcon} />
                  ) : (
                    <ClockCounterClockwiseIcon size={15} />
                  )}
                </CommitIconButton>
                <CommitIconButton
                  label={t(
                    commitMode === 'staged'
                      ? 'workbench.gitCommitStagedAction'
                      : 'workbench.gitCommitAction'
                  )}
                  disabled={
                    !!busyAction ||
                    pulling ||
                    !changeItems.length ||
                    !!conflictItems.length ||
                    hasUnsavedOpenTabs
                  }
                  onClick={commitChanges}
                >
                  {busyAction === 'commit' ? (
                    <SpinnerGapIcon size={14} className={styles.spinIcon} />
                  ) : (
                    <CheckIcon size={15} />
                  )}
                </CommitIconButton>
                {remoteAction.running ? (
                  <CommitIconButton
                    label={describeWorkbenchGitRemoteActionCancel(remoteAction.running, t)}
                    disabled={remoteAction.running.cancelling}
                    onClick={() => remoteAction.cancel()}
                  >
                    <StopCircleIcon size={15} />
                  </CommitIconButton>
                ) : (
                  <CommitIconButton
                    label={t('workbench.gitUpload')}
                    disabled={!!busyAction || hasUnsavedOpenTabs}
                    onClick={() => void pushChanges()}
                  >
                    <ArrowUpRightIcon size={15} />
                  </CommitIconButton>
                )}
              </div>
            </div>
          </form>
        </>
        )}
      </section>
      <Dialog
        open={!!rollbackRequest}
        onOpenChange={(open) => !open && setRollbackRequest(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('workbench.gitRollbackConfirmTitle')}</DialogTitle>
            <DialogDescription>
              {rollbackRequest?.length === 1
                ? t('workbench.gitDiscardConfirm', { path: rollbackRequest[0].path })
                : t('workbench.gitDiscardSelectedConfirm', {
                    count: rollbackRequest?.length ?? 0,
                  })}
            </DialogDescription>
          </DialogHeader>
          {!!rollbackRequest && rollbackRequest.length > 1 && (
            <ul className={styles.commitConfirmFileList}>
              {rollbackRequest.map((item) => (
                <li key={item.path} className={styles.commitConfirmFileRow}>
                  <span className={styles.commitConfirmFilePath}>
                    {getWorkbenchGitChangeDisplayPath(item)}
                  </span>
                  {isCommitPanelRollbackDeletion(item) && (
                    <span className={styles.commitConfirmDeletedTag}>
                      {t('workbench.gitDiscardDeletedTag')}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
          {rollbackKeepsStaged && (
            <p className={styles.commitConfirmNote}>{t('workbench.gitDiscardKeepsStaged')}</p>
          )}
          {!!rollbackDeletions.length && (
            <p className={styles.commitConfirmWarning}>
              {rollbackRequest?.length === 1
                ? t('workbench.gitDiscardDeletesUntrackedFile')
                : t('workbench.gitDiscardDeletesUntrackedFiles', {
                    count: rollbackDeletions.length,
                  })}
            </p>
          )}
          <DialogFooter>
            <Button variant="ghost" onClick={() => setRollbackRequest(null)}>
              {t('common.cancel')}
            </Button>
            <Button
              variant="destructiveOutline"
              disabled={!rollbackRequest?.length || !!pendingFileAction}
              onClick={() => rollbackRequest && void rollbackItems(rollbackRequest)}
            >
              {t('workbench.gitRollbackConfirmAction')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog
        open={!!commitAllRequest}
        onOpenChange={(open) => !open && setCommitAllRequest(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('workbench.gitCommitAllConfirmTitle')}</DialogTitle>
            <DialogDescription>
              {commitAllSummary?.untracked
                ? t('workbench.gitCommitAllConfirm', {
                    count: commitAllSummary.count,
                    untracked: commitAllSummary.untracked,
                  })
                : t('workbench.gitCommitAllTrackedConfirm', {
                    count: commitAllSummary?.count ?? 0,
                  })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setCommitAllRequest(null)}>
              {t('common.cancel')}
            </Button>
            <Button
              disabled={!commitAllRequest?.length || !!busyAction}
              onClick={() => commitAllRequest && void submitCommit(commitAllRequest)}
            >
              {t('workbench.gitCommitAll')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
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
