import { type ReactElement, useEffect, useState } from 'react'
import {
  ArrowsClockwiseIcon,
  CaretDownIcon,
  CloudArrowUpIcon,
  SpinnerGapIcon,
  XIcon,
} from '@phosphor-icons/react'
import {
  describeWorkbenchGitRemoteActionCancel,
  reportWorkbenchGitRemoteActionFailure,
  useWorkbenchGitRemoteAction,
} from '@renderer/hooks/useWorkbenchGitRemoteAction'
import { useStableWorkbenchMessageTranslate } from '@renderer/runtime/useStableWorkbenchMessaging'

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

/**
 * 顶栏分支旁边的同步按钮：显示当前分支落后（↓）、领先（↑）上游几个提交，点一下同步（先拉取再推送）；
 * 还没有上游时点一下推送并关联远端。旁边的小三角展开拉取、推送、同步、获取远端。这个项目有远端操作在跑
 * 时（不管是这里、分支菜单还是提交面板发起的）按钮转圈，小三角换成取消。
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
  const remoteAction = useWorkbenchGitRemoteAction(workspaceRoot)
  const [menuOpen, setMenuOpen] = useState(false)
  const running = remoteAction.running
  const busy = !!running
  // 别处（分支菜单、提交面板）发起了远端操作：展开着的菜单收起来，等它跑完不会自己再弹出来。
  useEffect(() => {
    if (busy) setMenuOpen(false)
  }, [busy])
  const status = summary.status
  if (!summary.repository || !status?.branch) return null

  const upstream = status.upstream
  const { ahead, behind } = status
  const cancelLabel = running ? describeWorkbenchGitRemoteActionCancel(running, t) : ''
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
      const result = await remoteAction.run(action, { privateKeyPath: gitSshKeyPath })
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
      reportWorkbenchGitRemoteActionFailure(actionError, action, { messageLatest, tLatest })
      // 取消、失败都可能已经动过仓库（拉取取到一半）：照样刷新。
      await onRefresh()
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
      {running ? (
        <button
          type="button"
          className={styles.gitSyncMenuButton}
          aria-label={cancelLabel}
          title={cancelLabel}
          disabled={running.cancelling}
          onClick={() => remoteAction.cancel()}
        >
          <XIcon size={10} />
        </button>
      ) : (
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
              {...getAnchorProps<HTMLButtonElement>()}
              type="button"
              className={styles.gitSyncMenuButton}
              aria-label={t('workbench.gitRemoteActionsMenu')}
              title={t('workbench.gitRemoteActionsMenu')}
            >
              <CaretDownIcon size={10} />
            </button>
          )}
        >
          <div
            className={styles.gitSyncMenu}
            role="menu"
            aria-label={t('workbench.gitRemoteActionsMenu')}
          >
            {menuItems.map((item) => (
              <button
                key={item.action}
                type="button"
                role="menuitem"
                className={styles.gitSyncMenuItem}
                disabled={item.disabled}
                onClick={() => void runAction(item.action)}
              >
                <span className={styles.gitSyncMenuLabel}>{item.label}</span>
                <span className={styles.gitSyncMenuHint}>{item.hint}</span>
              </button>
            ))}
          </div>
        </AnchoredPopover>
      )}
    </div>
  )
}
