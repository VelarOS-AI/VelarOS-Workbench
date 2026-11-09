import { type FormEvent, useState } from 'react'
import { workbenchHost } from '@renderer/host/WorkbenchHost'
import type { WorkbenchGitChangeItem } from '@renderer/models/git/workbenchGitModel'

import { isPresent } from '@velaros-ai/velaros/core'
import { AppError } from '@velaros-ai/velaros/core/error'
import { Result } from '@velaros-ai/velaros/core/result'

import {
  type SystemWorkspaceGitSummary,
  type WorkspaceGitFileAction,
} from '@shared/contracts/system'

import { type useStableWorkbenchMessageTranslate } from '../runtime/useStableWorkbenchMessaging'
import { useLatest } from '../support/genericHooks'

type WorkbenchGitChangeTranslate = Pick<
  ReturnType<typeof useStableWorkbenchMessageTranslate>,
  't' | 'messageLatest' | 'tLatest'
>

export interface UseWorkbenchGitChangeActionsParams {
  workspaceRoot: string
  hasUnsavedOpenTabs: boolean
  status: Nullable<SystemWorkspaceGitSummary['status']>
  onRefresh: () => Promise<void> | void
  onRepositoryChanged: () => Promise<void> | void
  setSelectedChangePath: (path: Nullable<string>) => void
  translate: WorkbenchGitChangeTranslate
}

export function useWorkbenchGitChangeActions({
  workspaceRoot,
  hasUnsavedOpenTabs,
  status,
  onRefresh,
  onRepositoryChanged,
  setSelectedChangePath,
  translate,
}: UseWorkbenchGitChangeActionsParams) {
  const { t, messageLatest, tLatest } = translate
  const onRefreshLatest = useLatest(onRefresh)
  const onRepositoryChangedLatest = useLatest(onRepositoryChanged)

  const [pendingFileAction, setPendingFileAction] = useState<Nullable<string>>(null)
  const [newBranchName, setNewBranchName] = useState('')
  const [pendingBranchAction, setPendingBranchAction] = useState<Nullable<string>>(null)

  const isBranchBusy = isPresent(pendingBranchAction)

  function warnUnsavedOpenTabs(): boolean {
    if (!hasUnsavedOpenTabs) return false

    messageLatest.current.warning({
      title: t('workbench.gitUnsavedBlockedTitle'),
      description: t('workbench.gitUnsavedBlockedDescription'),
    })
    return true
  }

  async function runFileAction(
    item: WorkbenchGitChangeItem,
    action: WorkspaceGitFileAction
  ): Promise<void> {
    const actionId = `${action}:${item.path}`
    if (pendingFileAction) return

    if (warnUnsavedOpenTabs()) return

    if (
      action === 'discard' &&
      !window.confirm(tLatest.current('workbench.gitDiscardConfirm', { path: item.path }))
    )
      return

    try {
      setPendingFileAction(actionId)
      Result.unwrap(
        await workbenchHost.kernel.workspace.performWorkspaceGitFileAction(
          workspaceRoot,
          [item.path],
          action
        )
      )
      if (action === 'discard') {
        setSelectedChangePath(null)
      }
      await onRefreshLatest.current()
      messageLatest.current.success({
        title: tLatest.current(
          action === 'stage'
            ? 'workbench.gitStageSuccessTitle'
            : action === 'unstage'
              ? 'workbench.gitUnstageSuccessTitle'
              : 'workbench.gitDiscardSuccessTitle'
        ),
        description: item.path,
      })
    } catch (error) {
      const appError = AppError.from(error)
      messageLatest.current.open({
        title: tLatest.current('workbench.gitFileActionFailedTitle'),
        description:
          appError.message.trim() || tLatest.current('workbench.gitFileActionFailedFallback'),
        tone: appError.code === 'VALIDATION' ? 'warning' : 'error',
        showClose: true,
      })
      await onRefreshLatest.current()
    } finally {
      setPendingFileAction(null)
    }
  }

  async function switchBranch(targetBranch: string): Promise<void> {
    if (!targetBranch || targetBranch === status?.branch || isBranchBusy) return

    if (warnUnsavedOpenTabs()) return

    // 有没提交的改动不预先拦：会被覆盖时 git 自己拒绝，下面照原话报出来。
    try {
      setPendingBranchAction(`switch:${targetBranch}`)
      const result = Result.unwrap(
        await workbenchHost.kernel.workspace.switchWorkspaceGitBranch(workspaceRoot, targetBranch)
      )
      await onRepositoryChangedLatest.current()
      messageLatest.current.success({
        title: tLatest.current('workbench.gitBranchSwitchSuccessTitle'),
        description: tLatest.current('workbench.gitBranchSwitchSuccessDescription', {
          from: result.previousBranch ?? tLatest.current('common.unknown'),
          to: result.branch,
        }),
      })
    } catch (error) {
      const appError = AppError.from(error)
      messageLatest.current.open({
        title: tLatest.current('workbench.gitBranchActionFailedTitle'),
        description:
          appError.message.trim() || tLatest.current('workbench.gitBranchActionFailedFallback'),
        tone: appError.code === 'VALIDATION' ? 'warning' : 'error',
        showClose: true,
      })
      await onRefreshLatest.current()
    } finally {
      setPendingBranchAction(null)
    }
  }

  async function createBranch(event: FormEvent): Promise<void> {
    event.preventDefault()

    const branchName = newBranchName.trim()
    if (!branchName || isBranchBusy) return

    if (warnUnsavedOpenTabs()) return

    try {
      setPendingBranchAction('create')
      const result = Result.unwrap(
        await workbenchHost.kernel.workspace.createWorkspaceGitBranch(workspaceRoot, branchName)
      )
      setNewBranchName('')
      await onRefreshLatest.current()
      messageLatest.current.success({
        title: tLatest.current('workbench.gitBranchCreateSuccessTitle'),
        description: tLatest.current('workbench.gitBranchCreateSuccessDescription', {
          branch: result.branch,
        }),
      })
    } catch (error) {
      const appError = AppError.from(error)
      messageLatest.current.open({
        title: tLatest.current('workbench.gitBranchActionFailedTitle'),
        description:
          appError.message.trim() || tLatest.current('workbench.gitBranchActionFailedFallback'),
        tone: appError.code === 'VALIDATION' ? 'warning' : 'error',
        showClose: true,
      })
      await onRefreshLatest.current()
    } finally {
      setPendingBranchAction(null)
    }
  }

  return {
    pendingFileAction,
    newBranchName,
    setNewBranchName,
    pendingBranchAction,
    isBranchBusy,
    runFileAction,
    switchBranch,
    createBranch,
  }
}
