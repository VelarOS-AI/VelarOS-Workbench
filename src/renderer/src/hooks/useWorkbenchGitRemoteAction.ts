import { useCallback, useSyncExternalStore } from 'react'
import { workbenchHost } from '@renderer/host/WorkbenchHost'
import {
  beginWorkbenchGitRemoteOperation,
  endWorkbenchGitRemoteOperation,
  markWorkbenchGitRemoteOperationCancelling,
  readWorkbenchGitRemoteOperation,
  subscribeWorkbenchGitRemoteOperations,
  type WorkbenchGitRemoteOperation,
} from '@renderer/models/git/workbenchGitRemoteOperation'

import { optionalWhenLazy } from '@velaros-ai/velaros/core'
import { AppError } from '@velaros-ai/velaros/core/error'
import { Result } from '@velaros-ai/velaros/core/result'

import {
  type SystemWorkspaceGitActionRequest,
  type SystemWorkspaceGitActionResult,
  type WorkspaceGitRemoteAction,
  type WorkspaceGitRemoteActionResult,
} from '@shared/contracts/system'

import { type WorkbenchI18nContextValue } from '../i18n/WorkbenchLocalizationProvider'
import type { useStableWorkbenchMessageTranslate } from '../runtime/useStableWorkbenchMessaging'

type WorkbenchGitRemoteActionOptions = Pick<
  SystemWorkspaceGitActionRequest,
  'branch' | 'privateKeyPath'
>

export interface WorkbenchGitRemoteActionController {
  /** 这个项目正在跑的远端操作，不管是哪个按钮发起的；没有为 null。 */
  running: Nullable<WorkbenchGitRemoteOperation>
  /**
   * 跑一个远端操作。失败时抛 AppError：用户取消的是 `CANCELLED`；这个项目已经有一个在跑时是 `CONFLICT`
   * （没有发起新的）。提示交给 {@link reportWorkbenchGitRemoteActionFailure}。
   */
  run: (
    action: WorkspaceGitRemoteAction,
    options?: WorkbenchGitRemoteActionOptions
  ) => Promise<SystemWorkspaceGitActionResult>
  /** 取消正在跑的那个；没有在跑的、已经在取消的不做事。 */
  cancel: () => void
}

const SuccessTitleKeys: Record<WorkspaceGitRemoteAction, string> = {
  fetch: 'workbench.gitFetchSuccessTitle',
  pull: 'workbench.gitPullSuccessTitle',
  sync: 'workbench.gitSyncSuccessTitle',
  upload: 'workbench.gitUploadSuccessTitle',
}

const FailedTitleKeys: Record<WorkspaceGitRemoteAction, string> = {
  fetch: 'workbench.gitFetchFailedTitle',
  pull: 'workbench.gitPullFailedTitle',
  sync: 'workbench.gitSyncFailedTitle',
  upload: 'workbench.gitUploadFailedTitle',
}

const ActionLabelKeys: Record<WorkspaceGitRemoteAction, string> = {
  fetch: 'workbench.gitFetch',
  pull: 'workbench.gitPull',
  sync: 'workbench.gitSync',
  upload: 'workbench.gitUpload',
}

/** 取消按钮上的说明：「取消拉取」；已经点过取消、在等 git 收场时是「正在取消…」。 */
export function describeWorkbenchGitRemoteActionCancel(
  operation: Pick<WorkbenchGitRemoteOperation, 'action' | 'cancelling'>,
  t: WorkbenchI18nContextValue['t']
): string {
  return operation.cancelling
    ? t('workbench.gitRemoteActionCancelling')
    : t('workbench.gitCancelRemoteAction', { action: t(ActionLabelKeys[operation.action]) })
}

type WorkbenchGitRemoteActionMessaging = Pick<
  ReturnType<typeof useStableWorkbenchMessageTranslate>,
  'messageLatest' | 'tLatest'
>

/** 远端操作做完了的提示：哪个操作、哪个分支（分离的 HEAD 上获取远端时没有分支可说）。 */
export function reportWorkbenchGitRemoteActionSuccess(
  result: Pick<WorkspaceGitRemoteActionResult, 'action' | 'branch'>,
  { messageLatest, tLatest }: WorkbenchGitRemoteActionMessaging
): void {
  const { branch } = result
  messageLatest.current.success({
    title: tLatest.current(SuccessTitleKeys[result.action]),
    description: optionalWhenLazy(branch, () =>
      tLatest.current('workbench.gitRemoteActionSuccessDescription', { branch: branch ?? '' })
    ),
  })
}

/**
 * 远端操作没成时的提示：用户自己取消的只说一声「已取消」；这个项目已经有一个在跑的，说等它跑完；其余照
 * git 的说明报出来。
 */
export function reportWorkbenchGitRemoteActionFailure(
  error: unknown,
  action: WorkspaceGitRemoteAction,
  { messageLatest, tLatest }: WorkbenchGitRemoteActionMessaging
): void {
  const appError = AppError.from(error)
  if (appError.code === 'CANCELLED') {
    messageLatest.current.info({
      title: tLatest.current('workbench.gitRemoteActionCancelledTitle'),
    })
    return
  }
  if (appError.code === 'CONFLICT') {
    messageLatest.current.warning({
      title: tLatest.current(FailedTitleKeys[action]),
      description: tLatest.current('workbench.gitRemoteActionBusy'),
    })
    return
  }
  messageLatest.current.open({
    title: tLatest.current(FailedTitleKeys[action]),
    description:
      appError.message.trim() || tLatest.current('workbench.gitRemoteActionFailedFallback'),
    tone: appError.code === 'VALIDATION' ? 'warning' : 'error',
    showClose: true,
  })
}

/**
 * 远端操作（获取、拉取、同步、推送）的统一入口：每个项目同一时刻只跑一个，跑着的时候哪个按钮都看得到、
 * 都能取消。取消是请主进程结束那条 git 命令，发起的那次 `run` 随后以 `CANCELLED` 收场。
 */
export function useWorkbenchGitRemoteAction(
  workspaceRoot: string
): WorkbenchGitRemoteActionController {
  const running = useSyncExternalStore(subscribeWorkbenchGitRemoteOperations, () =>
    readWorkbenchGitRemoteOperation(workspaceRoot)
  )

  const run = useCallback(
    async (
      action: WorkspaceGitRemoteAction,
      options: WorkbenchGitRemoteActionOptions = {}
    ): Promise<SystemWorkspaceGitActionResult> => {
      const operation = beginWorkbenchGitRemoteOperation(workspaceRoot, action)
      // 说明由 reportWorkbenchGitRemoteActionFailure 按界面语言给。
      if (!operation) throw new AppError('CONFLICT', 'A Git remote action is already running.')
      try {
        return Result.unwrap(
          await workbenchHost.kernel.workspace.performWorkspaceGitAction(workspaceRoot, action, {
            ...options,
            operationId: operation.id,
          })
        )
      } finally {
        endWorkbenchGitRemoteOperation(operation.id)
      }
    },
    [workspaceRoot]
  )

  const cancel = useCallback((): void => {
    const operation = readWorkbenchGitRemoteOperation(workspaceRoot)
    if (!operation || operation.cancelling) return
    markWorkbenchGitRemoteOperationCancelling(operation.id)
    // 取消不了（操作刚好结束了）也无妨：那次 run 自己会收场。
    void workbenchHost.kernel.workspace.cancelWorkspaceGitAction(operation.id)
  }, [workspaceRoot])

  return { running, run, cancel }
}
