import { type ReactElement, useState } from 'react'
import {
  ArrowsClockwiseIcon,
  CaretDownIcon,
  CloudArrowUpIcon,
  SpinnerGapIcon,
} from '@phosphor-icons/react'
import { workbenchHost } from '@renderer/host'
import { useStableWorkbenchMessageTranslate } from '@renderer/runtime/useStableWorkbenchMessaging'

import { AppError } from '@velaros-ai/core/error'
import { Result } from '@velaros-ai/core/result'
import { AnchoredPopover } from '@velaros-ai/ui/primitives/overlays/AnchoredPopover'
import { BubbleTooltip } from '@velaros-ai/ui/primitives/overlays/Tooltip'

import type {
  SystemWorkspaceGitSummary,
  WorkspaceGitRemoteAction,
  WorkspaceGitRemoteActionResult,
} from '@shared/contracts'

import styles from '../../styles/workbenchPageStyles'

interface WorkbenchGitSyncControlProps {
  workspaceRoot: string
  summary: SystemWorkspaceGitSummary
  gitSshKeyPath?: string
  hasUnsavedOpenTabs: boolean
  onRefresh: () => Promise<void>
  /** 拉取出了冲突：打开提交面板，冲突文件列在「合并冲突」里。 */
  onOpenCommitTool: () => void
}

/** 冲突提示挂得久一点：要照着它去解决。 */
const ConflictNoticeDurationMs = 12_000

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

/**
 * 顶栏分支旁边的同步按钮：显示当前分支落后（↓）、领先（↑）上游几个提交，点一下同步（先拉取再推送）；
 * 还没有上游时点一下推送并关联远端。旁边的小三角展开拉取、推送、同步、获取远端。
 */
export function WorkbenchGitSyncControl({
  workspaceRoot,
  summary,
  gitSshKeyPath,
  hasUnsavedOpenTabs,
  onRefresh,
  onOpenCommitTool,
}: WorkbenchGitSyncControlProps): Nullable<ReactElement> {
  const { t, messageLatest, tLatest } = useStableWorkbenchMessageTranslate()
  const [busyAction, setBusyAction] = useState<Nullable<WorkspaceGitRemoteAction>>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const status = summary.status
  if (!summary.repository || !status?.branch) return null

  const upstream = status.upstream
  const { ahead, behind } = status
  const busy = !!busyAction
  const mainAction: WorkspaceGitRemoteAction = upstream ? 'sync' : 'upload'
  const mainLabel = upstream
    ? t('workbench.gitSyncTooltip', { upstream, behind, ahead })
    : t('workbench.gitPublishTooltip')
  const menuItems: Array<{
    action: WorkspaceGitRemoteAction
    label: string
    hint: string
    disabled: boolean
  }> = [
    {
      action: 'pull',
      label: t('workbench.gitPull'),
      hint: upstream ? t('workbench.gitPullHint', { upstream }) : t('workbench.gitNoUpstreamHint'),
      disabled: !upstream,
    },
    {
      action: 'upload',
      label: t('workbench.gitUpload'),
      hint: upstream ? t('workbench.gitPushHint', { upstream }) : t('workbench.gitPublishHint'),
      disabled: false,
    },
    {
      action: 'sync',
      label: t('workbench.gitSync'),
      hint: upstream ? t('workbench.gitSyncHint') : t('workbench.gitNoUpstreamHint'),
      disabled: !upstream,
    },
    {
      action: 'fetch',
      label: t('workbench.gitFetch'),
      hint: t('workbench.gitFetchHint'),
      disabled: false,
    },
  ]

  /** 拉取、同步改写工作区里的文件，推送之前要确认；获取远端只动远端分支的记录，什么都不用问。 */
  function confirmAction(action: WorkspaceGitRemoteAction): boolean {
    if (action !== 'fetch' && hasUnsavedOpenTabs) {
      messageLatest.current.warning({
        title: tLatest.current('workbench.gitUnsavedBlockedTitle'),
        description: tLatest.current('workbench.gitUnsavedBlockedDescription'),
      })
      return false
    }
    if (action === 'sync')
      return window.confirm(tLatest.current('workbench.gitSyncConfirm', { upstream: upstream ?? '' }))
    if (action === 'upload') return window.confirm(tLatest.current('workbench.gitPushConfirm'))
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
    onOpenCommitTool()
  }

  async function runAction(action: WorkspaceGitRemoteAction): Promise<void> {
    setMenuOpen(false)
    if (busy || !confirmAction(action)) return
    try {
      setBusyAction(action)
      const result = Result.unwrap(
        await workbenchHost.kernel.workspace.performWorkspaceGitAction(workspaceRoot, action, {
          privateKeyPath: gitSshKeyPath,
        })
      )
      await onRefresh()
      if (result.action.conflicts.length > 0) {
        showConflicts(result.action)
        return
      }
      messageLatest.current.success({
        title: tLatest.current(SuccessTitleKeys[action]),
        description: tLatest.current('workbench.gitRemoteActionSuccessDescription', {
          branch: result.action.branch,
        }),
      })
    } catch (actionError) {
      const appError = AppError.from(actionError)
      messageLatest.current.open({
        title: tLatest.current(FailedTitleKeys[action]),
        description:
          appError.message.trim() || tLatest.current('workbench.gitRemoteActionFailedFallback'),
        tone: appError.code === 'VALIDATION' ? 'warning' : 'error',
        showClose: true,
      })
      await onRefresh()
    } finally {
      setBusyAction(null)
    }
  }

  return (
    <div className={styles.gitSyncControl}>
      <BubbleTooltip content={mainLabel} ariaLabel={mainLabel} delayDuration={80} sideOffset={6}>
        <button
          type="button"
          className={styles.gitSyncButton}
          aria-label={mainLabel}
          disabled={busy}
          onClick={() => void runAction(mainAction)}
        >
          {busy ? (
            <SpinnerGapIcon size={13} className={styles.spinIcon} />
          ) : upstream ? (
            <ArrowsClockwiseIcon size={13} />
          ) : (
            <CloudArrowUpIcon size={13} />
          )}
          {!!upstream && (behind > 0 || ahead > 0) && (
            <span className={styles.gitSyncCounts}>
              {behind > 0 && <span data-direction="behind">↓{behind}</span>}
              {ahead > 0 && <span data-direction="ahead">↑{ahead}</span>}
            </span>
          )}
        </button>
      </BubbleTooltip>
      <AnchoredPopover
        open={menuOpen}
        onOpenChange={setMenuOpen}
        className={styles.gitSyncMenuPopover}
        side="bottom"
        align="start"
        sideOffset={6}
        widthStrategy="content"
        anchor={({ getAnchorProps }) => (
          <button
            {...getAnchorProps<HTMLButtonElement>({ disabled: busy })}
            type="button"
            className={styles.gitSyncMenuButton}
            aria-label={t('workbench.gitRemoteActionsMenu')}
            title={t('workbench.gitRemoteActionsMenu')}
            disabled={busy}
          >
            <CaretDownIcon size={10} />
          </button>
        )}
      >
        <div className={styles.gitSyncMenu} role="menu" aria-label={t('workbench.gitRemoteActionsMenu')}>
          {menuItems.map((item) => (
            <button
              key={item.action}
              type="button"
              role="menuitem"
              className={styles.gitSyncMenuItem}
              disabled={busy || item.disabled}
              onClick={() => void runAction(item.action)}
            >
              <span className={styles.gitSyncMenuLabel}>{item.label}</span>
              <span className={styles.gitSyncMenuHint}>{item.hint}</span>
            </button>
          ))}
        </div>
      </AnchoredPopover>
    </div>
  )
}
