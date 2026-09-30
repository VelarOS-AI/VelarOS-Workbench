import { useCallback, useSyncExternalStore } from 'react'
import { workbenchHost } from '@renderer/host'
import {
  beginWorkbenchGitOperation,
  buildWorkbenchGitOperationConfirm,
  describeWorkbenchGitOperationOutcome,
  endWorkbenchGitOperation,
  getWorkbenchGitOperationName,
  readWorkbenchGitPendingOperation,
  subscribeWorkbenchGitPendingOperations,
  toWorkspaceGitOperationRequest,
  type WorkbenchGitOperationIntent,
} from '@renderer/models/git/workbenchGitOperationModel'
import { readWorkbenchGitRemoteOperation } from '@renderer/models/git/workbenchGitRemoteOperation'
import { describeWorkbenchGitHead } from '@renderer/models/git/workbenchGitTopBarModel'
import { useStableWorkbenchMessageTranslate } from '@renderer/runtime/useStableWorkbenchMessaging'

import { AppError } from '@velaros-ai/core/error'
import { Result } from '@velaros-ai/core/result'

import type { SystemWorkspaceGitSummary, WorkspaceGitOperationAction } from '@shared/contracts'
import { isWorkspaceGitOperationKind } from '@shared/workbenchGit'

import { useLatest } from '../support/genericHooks'

/** 冲突提示挂得久一点：要照着它去解决。 */
const ConflictNoticeDurationMs = 12_000

interface UseWorkbenchGitOperationOptions {
  workspaceRoot: string
  summary: Nullable<SystemWorkspaceGitSummary>
  /** 编辑器里有没保存的内容：这些操作都会改写磁盘上的文件，先提醒保存。 */
  hasUnsavedOpenTabs: boolean
  /** 做完一步之后刷新文件树与 Git 状态。 */
  onRefresh: () => Promise<void> | void
  /** 停在冲突上了：打开提交面板，冲突文件列在「合并冲突」里。已经在提交面板里时不用给。 */
  onOpenCommitTool?: () => void
}

export interface WorkbenchGitOperationController {
  /** 这个项目正在跑的那一步，不管是哪里点的；没有为 null。 */
  pending: Nullable<WorkspaceGitOperationAction>
  /** 做一步：先确认，做完刷新并提示结果。不抛错。 */
  run: (intent: WorkbenchGitOperationIntent) => Promise<void>
}

/**
 * 合并、变基、拣选、撤销，和它们停在半路之后的继续、放弃、跳过的统一入口。每个项目同一时刻只跑一步；
 * 出了冲突不算失败，提示一声并把提交面板打开，操作停在那里（摘要里的 `operation`，提示条据它显示）。
 */
export function useWorkbenchGitOperation({
  workspaceRoot,
  summary,
  hasUnsavedOpenTabs,
  onRefresh,
  onOpenCommitTool,
}: UseWorkbenchGitOperationOptions): WorkbenchGitOperationController {
  const { messageLatest, tLatest } = useStableWorkbenchMessageTranslate()
  const pending = useSyncExternalStore(subscribeWorkbenchGitPendingOperations, () =>
    readWorkbenchGitPendingOperation(workspaceRoot)
  )
  const latest = useLatest({ summary, hasUnsavedOpenTabs, onRefresh, onOpenCommitTool })

  const run = useCallback(
    async (intent: WorkbenchGitOperationIntent): Promise<void> => {
      const { summary, hasUnsavedOpenTabs, onRefresh, onOpenCommitTool } = latest.current
      const t = tLatest.current
      const status = summary?.status
      if (!status || readWorkbenchGitPendingOperation(workspaceRoot)) return
      const kind = isWorkspaceGitOperationKind(intent.action)
        ? intent.action
        : summary.operation?.kind
      // 继续、放弃、跳过说的是进行到一半的那个操作：它已经不在了就没有可做的。
      if (!kind) return
      const operation = getWorkbenchGitOperationName(kind, t)

      // 拉取、同步正在改写工作区里的文件：等它跑完。
      const remote = readWorkbenchGitRemoteOperation(workspaceRoot)
      if (remote?.action === 'pull' || remote?.action === 'sync') {
        messageLatest.current.warning({
          title: t('workbench.gitOperationFailedTitle', { operation }),
          description: t('workbench.gitRemoteActionBusy'),
        })
        return
      }
      // 合并是并到当前分支里，变基是挪当前分支：分离的 HEAD 上没有当前分支。
      if ((intent.action === 'merge' || intent.action === 'rebase') && !status.branch) {
        messageLatest.current.warning({
          title: t('workbench.gitOperationFailedTitle', { operation }),
          description: t('workbench.gitOperationNeedsBranch', {
            sha: status.detachedHead?.shortSha ?? '',
          }),
        })
        return
      }
      if (hasUnsavedOpenTabs) {
        messageLatest.current.warning({
          title: t('workbench.gitUnsavedBlockedTitle'),
          description: t('workbench.gitUnsavedBlockedDescription'),
        })
        return
      }
      const context = { current: describeWorkbenchGitHead(status, t) ?? '', kind }
      const confirmation = buildWorkbenchGitOperationConfirm(intent, context, t)
      if (confirmation && !window.confirm(confirmation)) return
      if (!beginWorkbenchGitOperation(workspaceRoot, intent.action)) return

      try {
        const result = Result.unwrap(
          await workbenchHost.kernel.workspace.performWorkspaceGitOperation(
            workspaceRoot,
            toWorkspaceGitOperationRequest(intent)
          )
        )
        await onRefresh()
        const notice = describeWorkbenchGitOperationOutcome(
          intent,
          result,
          context,
          tLatest.current
        )
        messageLatest.current[notice.tone]({
          title: notice.title,
          description: notice.description,
          duration: notice.conflicts ? ConflictNoticeDurationMs : undefined,
        })
        if (notice.conflicts) onOpenCommitTool?.()
      } catch (operationError) {
        const appError = AppError.from(operationError)
        messageLatest.current.open({
          title: tLatest.current('workbench.gitOperationFailedTitle', { operation }),
          description:
            appError.message.trim() || tLatest.current('workbench.gitOperationFailedFallback'),
          tone: appError.code === 'VALIDATION' ? 'warning' : 'error',
          showClose: true,
        })
        await onRefresh()
      } finally {
        endWorkbenchGitOperation(workspaceRoot)
      }
    },
    [latest, messageLatest, tLatest, workspaceRoot]
  )

  return { pending, run }
}
