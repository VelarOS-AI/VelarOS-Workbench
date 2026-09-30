import { type FormEvent, type ReactElement, useMemo, useRef, useState } from 'react'
import { CaretDownIcon, GitBranchIcon, SpinnerGapIcon } from '@phosphor-icons/react'
import {
  reportWorkbenchGitRemoteActionFailure,
  reportWorkbenchGitRemoteActionSuccess,
  useWorkbenchGitRemoteAction,
} from '@renderer/hooks/useWorkbenchGitRemoteAction'
import { workbenchHost } from '@renderer/host'
import {
  describeWorkbenchGitBranchControl,
  describeWorkbenchGitRemoteActions,
  describeWorkbenchGitRemoteNote,
  listWorkbenchGitMenuBranches,
  resolveWorkbenchGitBranchSwitch,
} from '@renderer/models/git/workbenchGitBranchMenuModel'
import { describeWorkbenchGitHead } from '@renderer/models/git/workbenchGitTopBarModel'
import { useStableWorkbenchMessageTranslate } from '@renderer/runtime/useStableWorkbenchMessaging'

import { AppError } from '@velaros-ai/core/error'
import { Result } from '@velaros-ai/core/result'
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
import {
  getTopBarControlMainButtonClassName,
  getTopBarControlMainClassName,
  getTopBarControlPanelClassName,
  TopBarControlFrame,
} from '@velaros-ai/ui/product/layout/TopBarControlFrame'

import type {
  SystemWorkspaceGitSummary,
  WorkspaceGitBranch,
  WorkspaceGitRemoteAction,
  WorkspaceGitRemoteActionResult,
} from '@shared/contracts'

import styles from '../../styles/workbenchPageStyles'

import { WorkbenchGitBranchMenu } from './WorkbenchGitBranchMenu'

interface WorkbenchGitBranchControlProps {
  workspaceRoot: string
  summary: SystemWorkspaceGitSummary
  gitSshKeyPath?: string
  hasUnsavedOpenTabs: boolean
  onRefresh: () => Promise<void>
  /** 切了分支：工作区里的文件跟着变了。 */
  onRepositoryChanged: () => void | Promise<void>
  /** 拉取出了冲突：打开提交面板，冲突文件列在「合并冲突」里。 */
  onOpenCommitTool: () => void
}

/** 冲突提示挂得久一点：要照着它去解决。 */
const ConflictNoticeDurationMs = 12_000

/** 新建分支在跑时 `pendingBranch` 里记的值（分支名里不会有空格，和签出的分支名撞不上）。 */
const CreatingBranch = 'create branch'

/**
 * 顶栏上唯一的 Git 控件。按钮上是当前分支（分离的 HEAD 写「分离的 HEAD · 1a2b3c4」）和它落后（↓）、领先
 * （↑）上游几个提交；点开是一块面板：当前分支的拉取、推送、同步、获取远端，下面是分支列表（签出、推送
 * 某个分支）和新建分支。
 *
 * 远端操作经 {@link useWorkbenchGitRemoteAction} 跑：这个项目有一个在跑时（不管是这里还是提交面板发起
 * 的）按钮转圈，面板里换成进度和取消。
 */
export function WorkbenchGitBranchControl({
  workspaceRoot,
  summary,
  gitSshKeyPath,
  hasUnsavedOpenTabs,
  onRefresh,
  onRepositoryChanged,
  onOpenCommitTool,
}: WorkbenchGitBranchControlProps): Nullable<ReactElement> {
  const { locale, messageLatest, t, tLatest } = useStableWorkbenchMessageTranslate()
  const remoteAction = useWorkbenchGitRemoteAction(workspaceRoot)
  const [menuOpen, setMenuOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [pendingBranch, setPendingBranch] = useState<Nullable<string>>(null)
  const [createDialogOpen, setCreateDialogOpen] = useState(false)
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
  // 分离的 HEAD 上控件照样在：按钮上写「分离的 HEAD · 1a2b3c4」，列表里没有哪个分支算当前的，点哪个都能切过去。
  const headLabel = status ? describeWorkbenchGitHead(status, t) : null
  if (!summary.repository || !status || !headLabel) return null

  const running = remoteAction.running
  const creating = pendingBranch === CreatingBranch
  // 同一时刻只做一件事：远端操作跑着时不切分支，切分支时不起远端操作。
  const locked = !!running || !!pendingBranch
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
      return
    }
    // 打开时重读一次：分支可能是在终端里建的、删的。
    void onRefresh().catch(showBranchActionFailure)
  }

  /** 有没提交的改动也照样切：git 能带过去就带过去，会被覆盖时 git 自己拒绝，原因照它说的报出来。 */
  async function switchBranch(branch: WorkspaceGitBranch): Promise<void> {
    if (locked || warnUnsavedOpenTabs()) return
    const target = resolveWorkbenchGitBranchSwitch(branch, branches)
    setPendingBranch(branch.name)
    try {
      const result = Result.unwrap(
        await workbenchHost.kernel.workspace.switchWorkspaceGitBranch(
          workspaceRoot,
          target.branch,
          locale,
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

  function openCreateBranchDialog(): void {
    handleMenuOpenChange(false)
    setNewBranchName('')
    setCheckoutCreatedBranch(true)
    setCreateDialogOpen(true)
  }

  function handleCreateDialogOpenChange(open: boolean): void {
    // 正在建的时候不让关：结果出来之前对话框留着。
    if (!open && creating) return
    setCreateDialogOpen(open)
  }

  async function createBranch(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    const name = newBranchName.trim()
    if (!name || locked) return
    if (checkoutCreatedBranch && warnUnsavedOpenTabs()) return
    setPendingBranch(CreatingBranch)
    try {
      const created = checkoutCreatedBranch
        ? Result.unwrap(
            await workbenchHost.kernel.workspace.switchWorkspaceGitBranch(
              workspaceRoot,
              name,
              locale,
              { create: true }
            )
          ).branch
        : Result.unwrap(
            await workbenchHost.kernel.workspace.createWorkspaceGitBranch(workspaceRoot, name)
          ).branch
      await onRefresh()
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

  /**
   * 拉取、同步改写工作区里的文件，推送之前要确认；获取远端只动远端分支的记录，什么都不用问。`branch` 是
   * 列表里点的那个分支（推送它，不是当前分支）。
   */
  function confirmRemoteAction(action: WorkspaceGitRemoteAction, branch?: string): boolean {
    if (action !== 'fetch' && warnUnsavedOpenTabs()) return false
    if (action === 'sync')
      return window.confirm(tLatest.current('workbench.gitSyncConfirm', { upstream: upstream ?? '' }))
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

  async function runRemoteAction(action: WorkspaceGitRemoteAction, branch?: string): Promise<void> {
    if (locked || !confirmRemoteAction(action, branch)) return
    try {
      const result = await remoteAction.run(action, { branch, privateKeyPath: gitSshKeyPath })
      await onRefresh()
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
    <TopBarControlFrame
      plain
      busy={locked}
      tone={status.isClean ? 'muted' : 'default'}
      title={tooltip}
      className={styles.gitBranchControl}
    >
      <AnchoredPopover
        open={menuOpen}
        onOpenChange={handleMenuOpenChange}
        onOpenAutoFocus={() => searchRef.current?.focus({ preventScroll: true })}
        anchorClassName={getTopBarControlMainClassName()}
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
            className={getTopBarControlMainButtonClassName(styles.gitBranchControlButton)}
            aria-label={`${headLabel} · ${tooltip}`}
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
            <CaretDownIcon size={11} className={styles.gitBranchControlCaret} />
          </Button>
        )}
      >
        <WorkbenchGitBranchMenu
          branches={branches}
          currentBranch={branchName}
          search={search}
          searchRef={searchRef}
          remoteActions={describeWorkbenchGitRemoteActions(status, t)}
          remoteNote={describeWorkbenchGitRemoteNote(status, t)}
          running={running}
          switchingBranch={creating ? null : pendingBranch}
          locked={locked}
          onSearchChange={setSearch}
          onRunRemoteAction={(action) => void runRemoteAction(action)}
          onCancelRemoteAction={() => remoteAction.cancel()}
          onSwitchBranch={(branch) => void switchBranch(branch)}
          onPushBranch={(branch) => void runRemoteAction('upload', branch.name)}
          onOpenCreateBranch={openCreateBranchDialog}
        />
      </AnchoredPopover>
      <Dialog open={createDialogOpen} onOpenChange={handleCreateDialogOpenChange}>
        <DialogContent className={styles.gitBranchCreateDialog}>
          <DialogHeader>
            <DialogTitle>{t('workbench.gitBranchCreateDialogTitle')}</DialogTitle>
            <DialogDescription>
              {detachedHead
                ? t('workbench.gitBranchCreateFromDetachedDescription', {
                    sha: detachedHead.shortSha,
                  })
                : t('workbench.gitBranchCreateDialogDescription', { branch: headLabel })}
            </DialogDescription>
          </DialogHeader>
          <form className={styles.gitBranchCreateForm} onSubmit={(event) => void createBranch(event)}>
            <Input
              autoFocus
              size="sm"
              value={newBranchName}
              disabled={creating}
              placeholder={t('workbench.gitBranchCreatePlaceholder')}
              aria-label={t('workbench.gitBranchCreatePlaceholder')}
              spellCheck={false}
              onChange={(event) => setNewBranchName(event.target.value)}
            />
            <DialogFooter className={styles.gitBranchCreateFooter}>
              <label className={styles.gitBranchCreateCheckout}>
                <input
                  type="checkbox"
                  checked={checkoutCreatedBranch}
                  disabled={creating}
                  onChange={(event) => setCheckoutCreatedBranch(event.target.checked)}
                />
                <span>{t('workbench.gitBranchCheckoutCreated')}</span>
              </label>
              <div className={styles.gitBranchCreateActions}>
                <Button
                  variant="ghost"
                  size="sm"
                  type="button"
                  disabled={creating}
                  onClick={() => handleCreateDialogOpenChange(false)}
                >
                  {t('common.cancel')}
                </Button>
                <Button
                  size="sm"
                  type="submit"
                  className={styles.gitBranchCreateSubmit}
                  disabled={!newBranchName.trim() || locked}
                >
                  {creating ? (
                    <SpinnerGapIcon size={13} className={styles.spinIcon} />
                  ) : (
                    t('workbench.gitBranchCreate')
                  )}
                </Button>
              </div>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </TopBarControlFrame>
  )
}
