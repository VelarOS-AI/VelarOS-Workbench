import { type ReactElement } from 'react'
import {
  reportWorkbenchGitRemoteActionFailure,
  reportWorkbenchGitRemoteActionSuccess,
  useWorkbenchGitRemoteAction,
} from '@renderer/hooks/useWorkbenchGitRemoteAction'
import { workbenchHost } from '@renderer/host'
import { describeWorkbenchGitHead } from '@renderer/models/git/workbenchGitTopBarModel'
import { useStableWorkbenchMessageTranslate } from '@renderer/runtime/useStableWorkbenchMessaging'

import { AppError } from '@velaros-ai/core/error'
import { Result } from '@velaros-ai/core/result'
import {
  WorkspaceGitCommitControl,
  type WorkspaceGitCommitControlAction,
  type WorkspaceGitCommitControlLayout,
  type WorkspaceGitCommitControlMessages,
  type WorkspaceGitCommitControlVariant,
} from '@velaros-ai/ui/product/git/WorkspaceGitCommitControl'

import type {
  SystemWorkspaceGitSummary,
  WorkspaceGitRemoteAction,
} from '@shared/contracts'

export type WorkbenchGitCommitControlVariant = WorkspaceGitCommitControlVariant
export type WorkbenchGitCommitControlLayout = WorkspaceGitCommitControlLayout

interface WorkbenchGitCommitControlProps {
  workspaceRoot: string
  summary: SystemWorkspaceGitSummary
  onRefresh: () => Promise<void>
  gitSshKeyPath?: string
  hasUnsavedOpenTabs: boolean
  variant?: WorkbenchGitCommitControlVariant
  layout?: WorkbenchGitCommitControlLayout
  onRepositoryChanged: () => void | Promise<void>
  onOpenCommitTool: () => void
}

export function WorkbenchGitCommitControl({
  workspaceRoot,
  summary,
  onRefresh,
  gitSshKeyPath,
  hasUnsavedOpenTabs,
  variant = 'branch-menu-actions',
  layout = 'pill',
  onRepositoryChanged,
  onOpenCommitTool,
}: WorkbenchGitCommitControlProps): ReactElement | null {
  const { locale, messageLatest, t, tLatest } = useStableWorkbenchMessageTranslate()
  const remoteAction = useWorkbenchGitRemoteAction(workspaceRoot)
  const status = summary.status
  // 分离的 HEAD 上控件照样在：按钮上写「分离的 HEAD · 1a2b3c4」，菜单里没有哪个分支算当前的，点哪个都能切过去。
  const headLabel = status ? describeWorkbenchGitHead(status, t) : null

  if (!summary.repository || !status || !headLabel) return null

  const activeStatus = status
  const detachedHead = status.detachedHead
  const controlSummary = {
    repository: summary.repository,
    status: {
      // 共享的分支菜单只认一个名字：分离的 HEAD 把这句说明当名字给它。
      branch: headLabel,
      upstream: status.upstream,
      isClean: status.isClean,
      changedFiles: status.changedFiles,
    },
    branches: summary.branches,
    lineStats: summary.lineStats,
  }

  function warnUnsavedOpenTabs(): boolean {
    if (!hasUnsavedOpenTabs) return false
    messageLatest.current.warning({
      title: tLatest.current('workbench.gitUnsavedBlockedTitle'),
      description: tLatest.current('workbench.gitUnsavedBlockedDescription'),
    })
    return true
  }

  /** 有没提交的改动也照样切：git 能带过去就带过去，会被覆盖时 git 自己拒绝，原因经 onActionError 显示。 */
  async function switchBranch(
    branch: string,
    options?: { create?: boolean; startPoint?: string }
  ): Promise<boolean> {
    if (warnUnsavedOpenTabs()) return false

    const result = Result.unwrap(
      await workbenchHost.kernel.workspace.switchWorkspaceGitBranch(
        workspaceRoot,
        branch,
        locale,
        options
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
    return true
  }

  async function createBranch(
    branch: string,
    { checkout }: { checkout: boolean }
  ): Promise<boolean> {
    if (checkout && warnUnsavedOpenTabs()) return false

    const createdBranch = checkout
      ? Result.unwrap(
          await workbenchHost.kernel.workspace.switchWorkspaceGitBranch(
            workspaceRoot,
            branch,
            locale,
            { create: true }
          )
        ).branch
      : Result.unwrap(
          await workbenchHost.kernel.workspace.createWorkspaceGitBranch(workspaceRoot, branch)
        ).branch

    await onRefresh()
    messageLatest.current.success({
      title: tLatest.current('workbench.gitBranchCreateSuccessTitle'),
      description: checkout
        ? tLatest.current('workbench.gitBranchCreateAndCheckoutSuccessDescription', {
            branch: createdBranch,
          })
        : tLatest.current('workbench.gitBranchCreateSuccessDescription', {
            branch: createdBranch,
          }),
    })
    return true
  }

  async function runRemoteAction(
    action: Extract<WorkspaceGitRemoteAction, 'fetch' | 'upload'>,
    branch?: string
  ): Promise<void> {
    if (action !== 'fetch' && warnUnsavedOpenTabs()) return
    if (action === 'upload' && !window.confirm(tLatest.current('workbench.gitPushConfirm'))) return

    // 经统一入口跑：顶栏同步按钮上看得到它在跑，也能在那里取消。
    const result = await remoteAction.run(action, { branch, privateKeyPath: gitSshKeyPath })
    await onRefresh()
    reportWorkbenchGitRemoteActionSuccess(result.action, { messageLatest, tLatest })
  }

  async function handleActionError(
    error: unknown,
    action: WorkspaceGitCommitControlAction
  ): Promise<void> {
    if (action === 'fetch' || action === 'upload') {
      reportWorkbenchGitRemoteActionFailure(error, action, { messageLatest, tLatest })
    } else {
      const appError = AppError.from(error)
      messageLatest.current.open({
        title: tLatest.current('workbench.gitBranchActionFailedTitle'),
        description:
          appError.message.trim() || tLatest.current('workbench.gitBranchActionFailedFallback'),
        tone: appError.code === 'VALIDATION' ? 'warning' : 'error',
        showClose: true,
      })
    }
    await onRefresh()
  }

  const messages: WorkspaceGitCommitControlMessages = {
    branchSearchPlaceholder: t('workbench.gitBranchSearchPlaceholder'),
    branchCreate: t('workbench.gitBranchCreate'),
    checkoutAction: t('workbench.gitBranchCheckoutCreated'),
    commitAction: t('workbench.gitCommitAction'),
    fetchAction: t('workbench.gitFetch'),
    uploadAction: t('workbench.gitUpload'),
    localBranches: t('workbench.gitBranchLocal'),
    remoteBranches: t('workbench.gitBranchRemoteGroup'),
    createDialogTitle: t('workbench.gitBranchCreateDialogTitle'),
    createDialogDescription: (branch) =>
      detachedHead
        ? t('workbench.gitBranchCreateFromDetachedDescription', { sha: detachedHead.shortSha })
        : t('workbench.gitBranchCreateDialogDescription', { branch }),
    createBranchPlaceholder: t('workbench.gitBranchCreatePlaceholder'),
    checkoutCreatedBranch: t('workbench.gitBranchCheckoutCreated'),
    cancel: t('common.cancel'),
    create: t('workbench.gitBranchCreate'),
    clean: t('workbench.gitClean'),
    changedFiles: (count) => t('workbench.gitChangedFiles', { count }),
  }

  return (
    <WorkspaceGitCommitControl
      summary={controlSummary}
      messages={messages}
      commitDisabled={activeStatus.isClean || hasUnsavedOpenTabs}
      themeColor="var(--workbench-theme-color)"
      variant={variant}
      layout={layout}
      onMenuOpen={onRefresh}
      onSwitchBranch={switchBranch}
      onCreateBranch={createBranch}
      onUpload={(branch) => runRemoteAction('upload', branch.name)}
      onFetch={() => runRemoteAction('fetch')}
      onOpenCommit={onOpenCommitTool}
      onActionError={handleActionError}
    />
  )
}
