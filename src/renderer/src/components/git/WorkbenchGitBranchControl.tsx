import { type FormEvent, type ReactElement, useMemo, useRef, useState } from 'react'
import { CaretDownIcon, GitBranchIcon, SpinnerGapIcon } from '@phosphor-icons/react'
import { useWorkbenchGitOperation } from '@renderer/hooks/useWorkbenchGitOperation'
import {
  reportWorkbenchGitRemoteActionFailure,
  reportWorkbenchGitRemoteActionSuccess,
  useWorkbenchGitRemoteAction,
} from '@renderer/hooks/useWorkbenchGitRemoteAction'
import { workbenchHost } from '@renderer/host/WorkbenchHost'
import {
  describeWorkbenchGitBranchControl,
  describeWorkbenchGitBranchControlHead,
  describeWorkbenchGitOperationBlock,
  describeWorkbenchGitRemoteActions,
  describeWorkbenchGitRemoteNote,
  listWorkbenchGitMenuBranches,
  resolveWorkbenchGitBranchSwitch,
  type WorkbenchGitRemoteActionItem,
} from '@renderer/models/git/workbenchGitBranchMenuModel'
import {
  resolveWorkbenchGitListedBranch,
  type WorkbenchGitOperationBranch,
} from '@renderer/models/git/workbenchGitOperationModel'
import { useStableWorkbenchMessageTranslate } from '@renderer/runtime/useStableWorkbenchMessaging'

import { Button } from '@velaros-ai/ui/primitives/buttons/Button'
import { Input } from '@velaros-ai/ui/primitives/forms/Input'
import { AnchoredPopover } from '@velaros-ai/ui/primitives/overlays/AnchoredPopover'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@velaros-ai/ui/primitives/overlays/Dialog'
import { getTopBarControlPanelClassName } from '@velaros-ai/ui/product/layout/TopBarControlFrame'
import { AppError } from '@velaros-ai/velaros/core/error'
import { Result } from '@velaros-ai/velaros/core/result'

import {
  type SystemWorkspaceGitSummary,
  type WorkspaceGitBranch,
  type WorkspaceGitRemoteActionResult,
} from '@shared/contracts/system'
import type { WorkbenchGitBranchEdit } from '@shared/workbenchGit'

import styles from '../../styles/workbenchPageStyles'

import { WorkbenchGitBranchMenu } from './WorkbenchGitBranchMenu'

interface WorkbenchGitBranchControlProps {
  workspaceRoot: string
  summary: SystemWorkspaceGitSummary
  gitSshKeyPath?: string
  hasUnsavedOpenTabs: boolean
  onRefresh: () => Promise<void>
  onWorkingTreeChanged: () => Promise<void>
  /** 切了分支：工作区里的文件跟着变了。 */
  onRepositoryChanged: () => void | Promise<void>
  /** 拉取出了冲突：打开提交面板，冲突文件列在「合并冲突」里。 */
  onOpenCommitTool: () => void
  onInspectBranch: (workspaceRoot: string, branch: string, compare: boolean) => void
}

/** 冲突提示挂得久一点：要照着它去解决。 */
const ConflictNoticeDurationMs = 12_000

/** 新建分支在跑时 `pendingBranch` 里记的值（分支名里不会有空格，和签出的分支名撞不上）。 */
const CreatingBranch = 'create branch'
const EditingBranch = 'edit branch'

export function WorkbenchGitBranchControl({
  workspaceRoot,
  summary,
  gitSshKeyPath,
  hasUnsavedOpenTabs,
  onRefresh,
  onWorkingTreeChanged,
  onRepositoryChanged,
  onOpenCommitTool,
  onInspectBranch,
}: WorkbenchGitBranchControlProps): Nullable<ReactElement> {
  const { messageLatest, t, tLatest } = useStableWorkbenchMessageTranslate()
  const remoteAction = useWorkbenchGitRemoteAction(workspaceRoot)
  const gitOperation = useWorkbenchGitOperation({
    workspaceRoot,
    summary,
    hasUnsavedOpenTabs,
    onRefresh: onWorkingTreeChanged,
    onOpenCommitTool: () => {
      handleMenuOpenChange(false)
      onOpenCommitTool()
    },
  })
  const [menuOpen, setMenuOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [selectedBranch, setSelectedBranch] = useState<Nullable<WorkspaceGitBranch>>(null)
  const [pendingBranch, setPendingBranch] = useState<Nullable<string>>(null)
  const [createDialogOpen, setCreateDialogOpen] = useState(false)
  const [createSource, setCreateSource] = useState<Nullable<WorkbenchGitOperationBranch>>(null)
  const [renameSource, setRenameSource] = useState<Nullable<WorkspaceGitBranch>>(null)
  const [newBranchName, setNewBranchName] = useState('')
  const [checkoutCreatedBranch, setCheckoutCreatedBranch] = useState(true)
  const searchRef = useRef<HTMLInputElement>(null)

  const status = summary.status
  const branchName = status?.branch ?? null
  const upstream = status?.upstream ?? null
  const branches = useMemo(
    () => listWorkbenchGitMenuBranches(summary.branches, { branch: branchName, upstream }),
    [branchName, summary.branches, upstream]
  )
  // 分离的 HEAD 仍可打开分支菜单；变基期间保留正在变基的分支名称。
  const headLabel = status
    ? describeWorkbenchGitBranchControlHead(status, summary.operation, t)
    : null
  if (!summary.repository || !status || !headLabel) return null

  const running = remoteAction.running
  const creating = pendingBranch === CreatingBranch
  const editing = pendingBranch === EditingBranch
  const branchDialogPending = creating || editing
  // 同一时刻只做一件事：远端操作跑着时不切分支，切分支时不起远端操作。
  const locked = !!running || !!pendingBranch || !!gitOperation.pending
  // 合并、变基、拣选、撤销进行到一半：先去提交面板继续或放弃。这时只有获取远端还能用。
  const operationBlock = describeWorkbenchGitOperationBlock(summary.operation, t)
  const canIntegrate = !!branchName && !status.conflictedFiles
  const detachedHead = status.detachedHead
  const { ahead, behind } = status
  const tooltip = describeWorkbenchGitBranchControl(status, t)

  function warnUnsavedOpenTabs(): boolean {
    if (!hasUnsavedOpenTabs) return false
    messageLatest.current.warning({
      title: tLatest.current('workbench.gitUnsavedBlockedTitle'),
      description: tLatest.current('workbench.gitUnsavedBlockedDescription'),
    })
    return true
  }

  function showBranchActionFailure(error: unknown): void {
    const appError = AppError.from(error)
    messageLatest.current.open({
      title: tLatest.current('workbench.gitBranchActionFailedTitle'),
      description:
        appError.message.trim() || tLatest.current('workbench.gitBranchActionFailedFallback'),
      tone: appError.code === 'VALIDATION' ? 'warning' : 'error',
      showClose: true,
    })
  }

  function handleMenuOpenChange(open: boolean): void {
    setMenuOpen(open)
    if (!open) {
      setSearch('')
      setSelectedBranch(null)
      return
    }
    // 打开时重读一次：分支可能是在终端里建的、删的。
    void onRefresh().catch(showBranchActionFailure)
  }

  /** 有没提交的改动也照样切：git 能带过去就带过去，会被覆盖时 git 自己拒绝，原因照它说的报出来。 */
  async function switchBranch(branch: WorkspaceGitBranch): Promise<void> {
    if (locked || operationBlock || warnUnsavedOpenTabs()) return
    const target = resolveWorkbenchGitBranchSwitch(branch, branches)
    setPendingBranch(branch.name)
    try {
      const result = Result.unwrap(
        await workbenchHost.kernel.workspace.switchWorkspaceGitBranch(
          workspaceRoot,
          target.branch,
          target.options
        )
      )
      await onRepositoryChanged()
      messageLatest.current.success({
        title: tLatest.current('workbench.gitBranchSwitchSuccessTitle'),
        description: tLatest.current('workbench.gitBranchSwitchSuccessDescription', {
          // 从分离的 HEAD 切过来的：没有上一个分支，写它停在的提交。
          from: result.previousBranch ?? headLabel ?? tLatest.current('common.unknown'),
          to: result.branch,
        }),
      })
      handleMenuOpenChange(false)
    } catch (error) {
      showBranchActionFailure(error)
      await onRefresh()
    } finally {
      setPendingBranch(null)
    }
  }

  function openCreateBranchDialog(branch?: WorkspaceGitBranch): void {
    if (locked || operationBlock) return
    handleMenuOpenChange(false)
    setCreateSource(branch ? resolveWorkbenchGitListedBranch(branch) : null)
    setRenameSource(null)
    setNewBranchName('')
    setCheckoutCreatedBranch(true)
    setCreateDialogOpen(true)
  }

  function localBranchName(branch: WorkspaceGitBranch): string {
    return branch.ref?.startsWith('refs/heads/')
      ? branch.ref.slice('refs/heads/'.length)
      : branch.name
  }

  function openRenameBranchDialog(branch: WorkspaceGitBranch): void {
    if (locked || operationBlock || branch.kind === 'remote') return
    handleMenuOpenChange(false)
    setRenameSource(branch)
    setNewBranchName(localBranchName(branch))
    setCreateDialogOpen(true)
  }

  async function editLocalBranch(
    branch: WorkspaceGitBranch,
    edit: WorkbenchGitBranchEdit
  ): Promise<boolean> {
    if (locked || operationBlock || branch.kind === 'remote') return false
    const source = localBranchName(branch)
    if (edit.action === 'delete') {
      if (branch.current || source === branchName) return false
      if (!window.confirm(tLatest.current('workbench.gitBranchDeleteConfirm', { branch: source })))
        return false
    }
    setPendingBranch(EditingBranch)
    try {
      const result = Result.unwrap(
        await workbenchHost.kernel.workspace.editWorkspaceGitBranch(workspaceRoot, source, edit)
      )
      await onRefresh()
      messageLatest.current.success({
        title: tLatest.current(
          edit.action === 'rename' ? 'workbench.gitBranchRenamed' : 'workbench.gitBranchDeleted',
          { branch: result.branch }
        ),
      })
      return true
    } catch (error) {
      showBranchActionFailure(error)
      await onRefresh().catch(showBranchActionFailure)
      return false
    } finally {
      setPendingBranch(null)
    }
  }

  function handleCreateDialogOpenChange(open: boolean): void {
    // 正在建的时候不让关：结果出来之前对话框留着。
    if (!open && branchDialogPending) return
    setCreateDialogOpen(open)
  }

  async function createBranch(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    const name = newBranchName.trim()
    if (!name || locked || operationBlock) return
    if (renameSource) {
      if (
        name !== localBranchName(renameSource) &&
        (await editLocalBranch(renameSource, { action: 'rename', name }))
      )
        setCreateDialogOpen(false)
      return
    }
    if (checkoutCreatedBranch && warnUnsavedOpenTabs()) return
    setPendingBranch(CreatingBranch)
    try {
      const startPoint = createSource?.revision
      const created = checkoutCreatedBranch
        ? Result.unwrap(
            await workbenchHost.kernel.workspace.switchWorkspaceGitBranch(workspaceRoot, name, {
              create: true,
              startPoint,
            })
          ).branch
        : Result.unwrap(
            await workbenchHost.kernel.workspace.createWorkspaceGitBranch(
              workspaceRoot,
              name,
              startPoint
            )
          ).branch
      if (checkoutCreatedBranch) await onRepositoryChanged()
      else await onRefresh()
      messageLatest.current.success({
        title: tLatest.current('workbench.gitBranchCreateSuccessTitle'),
        description: tLatest.current(
          checkoutCreatedBranch
            ? 'workbench.gitBranchCreateAndCheckoutSuccessDescription'
            : 'workbench.gitBranchCreateSuccessDescription',
          { branch: created }
        ),
      })
      setCreateDialogOpen(false)
    } catch (error) {
      showBranchActionFailure(error)
      await onRefresh()
    } finally {
      setPendingBranch(null)
    }
  }

  function runBranchOperation(action: 'merge' | 'rebase', branch: WorkspaceGitBranch): void {
    if (locked || operationBlock || !canIntegrate) return
    void gitOperation.run({ action, branch: resolveWorkbenchGitListedBranch(branch) })
  }

  /**
   * 拉取会更新工作区里的文件，推送之前要确认；获取远端只动远端分支的记录，什么都不用问。`branch` 是
   * 列表里点的那个分支（推送它，不是当前分支）。
   */
  function confirmRemoteAction(
    action: WorkbenchGitRemoteActionItem['action'],
    branch?: string
  ): boolean {
    if (action !== 'fetch' && warnUnsavedOpenTabs()) return false
    if (action === 'sync')
      return (
        !!upstream &&
        window.confirm(tLatest.current('workbench.gitBranchSyncConfirm', { upstream }))
      )
    if (action === 'upload')
      return window.confirm(
        branch
          ? tLatest.current('workbench.gitPushBranchConfirm', { branch })
          : tLatest.current('workbench.gitPushConfirm')
      )
    return true
  }

  function showConflicts(result: WorkspaceGitRemoteActionResult): void {
    messageLatest.current.warning({
      title: tLatest.current('workbench.gitPullConflictsTitle'),
      description: tLatest.current(
        result.rebasing
          ? 'workbench.gitPullRebaseConflictsDescription'
          : 'workbench.gitPullConflictsDescription',
        { count: result.conflicts.length }
      ),
      duration: ConflictNoticeDurationMs,
    })
    handleMenuOpenChange(false)
    onOpenCommitTool()
  }

  async function runRemoteAction(
    action: WorkbenchGitRemoteActionItem['action'],
    branch?: string
  ): Promise<void> {
    if (locked || !confirmRemoteAction(action, branch)) return
    try {
      const result = await remoteAction.run(action, { branch, privateKeyPath: gitSshKeyPath })
      if (action === 'pull' || action === 'sync') await onWorkingTreeChanged()
      else await onRefresh()
      if (result.action.conflicts.length > 0) {
        showConflicts(result.action)
        return
      }
      reportWorkbenchGitRemoteActionSuccess(result.action, { messageLatest, tLatest })
    } catch (actionError) {
      reportWorkbenchGitRemoteActionFailure(actionError, action, { messageLatest, tLatest })
      // 取消、失败都可能已经动过仓库（拉取取到一半）：照样刷新。
      await onRefresh()
    }
  }

  return (
    <>
      <AnchoredPopover
        open={menuOpen}
        onOpenChange={handleMenuOpenChange}
        onOpenAutoFocus={() => searchRef.current?.focus({ preventScroll: true })}
        onCloseAutoFocus={(event) => {
          if (createDialogOpen) event.preventDefault()
        }}
        anchorClassName={`${styles.filePanelPickerAnchor} ${styles.gitBranchControlAnchor}`}
        className={getTopBarControlPanelClassName(styles.gitBranchMenuPanel)}
        data-topbar-panel="picker"
        side="bottom"
        align="start"
        sideOffset={6}
        widthStrategy="content"
        anchor={({ getAnchorProps }) => (
          <Button
            {...getAnchorProps<HTMLButtonElement>()}
            variant="ghost"
            size="sm"
            className={styles.filePanelPickerButton}
            aria-label={`${headLabel} · ${tooltip}`}
            title={tooltip}
          >
            {locked ? (
              <SpinnerGapIcon size={13} className={styles.spinIcon} />
            ) : (
              <GitBranchIcon size={13} weight="bold" />
            )}
            <span className={styles.gitBranchControlName}>{headLabel}</span>
            {!!upstream && (behind > 0 || ahead > 0) && (
              <span className={styles.gitBranchControlCounts} aria-hidden>
                {behind > 0 && <span>↓{behind}</span>}
                {ahead > 0 && <span>↑{ahead}</span>}
              </span>
            )}
            <CaretDownIcon size={11} />
          </Button>
        )}
      >
        <WorkbenchGitBranchMenu
          branches={branches}
          currentBranch={branchName}
          selectedBranch={selectedBranch}
          search={search}
          searchRef={searchRef}
          remoteActions={describeWorkbenchGitRemoteActions(status, t, operationBlock)}
          remoteNote={describeWorkbenchGitRemoteNote(status, t, operationBlock)}
          running={running}
          switchingBranch={branchDialogPending ? null : pendingBranch}
          locked={locked}
          branchesBlocked={operationBlock}
          canIntegrate={canIntegrate}
          onSearchChange={setSearch}
          onSelectBranch={setSelectedBranch}
          onRunRemoteAction={(action) => void runRemoteAction(action)}
          onCancelRemoteAction={() => remoteAction.cancel()}
          onSwitchBranch={(branch) => void switchBranch(branch)}
          onPushBranch={(branch) => void runRemoteAction('upload', branch.name)}
          onRunBranchOperation={runBranchOperation}
          onOpenCreateBranch={openCreateBranchDialog}
          onOpenRenameBranch={openRenameBranchDialog}
          onDeleteBranch={(branch) => void editLocalBranch(branch, { action: 'delete' })}
          onCopyBranch={(branch) => {
            const name = branch.kind === 'remote' ? branch.name : localBranchName(branch)
            void navigator.clipboard.writeText(name).catch(showBranchActionFailure)
            handleMenuOpenChange(false)
          }}
          onInspectBranch={(branch, compare) => {
            handleMenuOpenChange(false)
            onInspectBranch(workspaceRoot, branch.name, compare)
          }}
        />
      </AnchoredPopover>
      <Dialog open={createDialogOpen} onOpenChange={handleCreateDialogOpenChange}>
        <DialogContent className={styles.gitBranchCreateDialog}>
          <DialogHeader>
            <DialogTitle>
              {t(
                renameSource ? 'workbench.gitBranchRename' : 'workbench.gitBranchCreateDialogTitle'
              )}
            </DialogTitle>
            <DialogDescription>
              {renameSource
                ? t('workbench.gitBranchRenameDescription', {
                    branch: localBranchName(renameSource),
                  })
                : createSource
                  ? t('workbench.gitBranchCreateFromSelectedDescription', {
                      branch: createSource.name,
                    })
                  : detachedHead
                    ? t('workbench.gitBranchCreateFromDetachedDescription', {
                        sha: detachedHead.shortSha,
                      })
                    : t('workbench.gitBranchCreateDialogDescription', { branch: headLabel })}
            </DialogDescription>
          </DialogHeader>
          <form
            className={styles.gitBranchCreateForm}
            onSubmit={(event) => void createBranch(event)}
          >
            <Input
              autoFocus
              size="sm"
              value={newBranchName}
              disabled={branchDialogPending}
              placeholder={t('workbench.gitBranchCreatePlaceholder')}
              aria-label={t('workbench.gitBranchCreatePlaceholder')}
              spellCheck={false}
              onChange={(event) => setNewBranchName(event.target.value)}
            />
            <DialogFooter className={styles.gitBranchCreateFooter}>
              {!renameSource && (
                <label className={styles.gitBranchCreateCheckout}>
                  <input
                    type="checkbox"
                    checked={checkoutCreatedBranch}
                    disabled={creating}
                    onChange={(event) => setCheckoutCreatedBranch(event.target.checked)}
                  />
                  <span>{t('workbench.gitBranchCheckoutCreated')}</span>
                </label>
              )}
              <div className={styles.gitBranchCreateActions}>
                <Button
                  variant="ghost"
                  size="sm"
                  type="button"
                  disabled={branchDialogPending}
                  onClick={() => handleCreateDialogOpenChange(false)}
                >
                  {t('common.cancel')}
                </Button>
                <Button
                  size="sm"
                  type="submit"
                  className={styles.gitBranchCreateSubmit}
                  disabled={
                    !newBranchName.trim() ||
                    locked ||
                    (renameSource && newBranchName.trim() === localBranchName(renameSource)) ||
                    !!operationBlock
                  }
                >
                  {branchDialogPending ? (
                    <SpinnerGapIcon size={13} className={styles.spinIcon} />
                  ) : (
                    t(
                      renameSource ? 'workbench.gitBranchRenameSubmit' : 'workbench.gitBranchCreate'
                    )
                  )}
                </Button>
              </div>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  )
}
