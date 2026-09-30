import { type ReactElement } from 'react'
import {
  reportWorkbenchGitRemoteActionFailure,
  useWorkbenchGitRemoteAction,
} from '@renderer/hooks/useWorkbenchGitRemoteAction'
import { workbenchHost } from '@renderer/host'
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

  if (!summary.repository || !status?.branch) return null

  const activeStatus = status
  const controlSummary = {
    repository: summary.repository,
    status: {
      branch: status.branch,
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
        from: result.previousBranch ?? tLatest.current('common.unknown'),
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
    messageLatest.current.success({
      title: tLatest.current(
        action === 'fetch'
          ? 'workbench.gitFetchSuccessTitle'
          : 'workbench.gitUploadSuccessTitle'
      ),
      description: tLatest.current('workbench.gitRemoteActionSuccessDescription', {
        branch: result.action.branch,
      }),
    })
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
      t('workbench.gitBranchCreateDialogDescription', { branch }),
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
