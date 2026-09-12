import { useEffect, useMemo, useState } from 'react'
import {
  buildWorkbenchGitChangeItems,
  buildWorkbenchGitDecorationMap,
  EMPTY_WORKBENCH_GIT_DECORATIONS,
} from '@renderer/models/git/workbenchGitModel'
import {
  isWorkbenchAgentProjectWriteResult,
  WorkbenchGitWorkspaceChangeRefreshDelayMs,
} from '@renderer/models/git/workbenchGitRefreshTriggers'
import {
  buildWorkbenchGitTopBarSummary,
  resolveWorkbenchCanShowGitBranchControl,
  resolveWorkbenchHasGitRepository,
} from '@renderer/models/git/workbenchGitTopBarModel'
import type { WorkbenchProject } from '@renderer/models/project/workbenchProjects'

import { createCoalescedRefresh } from '../support/coalescedRefresh'
import { useLatest } from '../support/genericHooks'
import { useWorkspaceFilesChangedRefresh } from '../support/useWorkspaceFilesChangedRefresh'
import { useWorkspaceGitLineStats } from '../support/useWorkspaceGitLineStats'
import { useWorkspaceGitSummaries } from '../support/useWorkspaceGitSummaries'

interface UseWorkbenchGitStateOptions {
  activeProject: Nullable<WorkbenchProject>
  /** Git 相关 UI 可见时为 true（底部 Git 面板、Agent 变更预览等），触发完整快照拉取。 */
  gitSurfacesActive: boolean
  /** 项目 workspace 绑定完成版本；用于修复首次进入时 Git 刷新早于 root 注册的竞态。 */
  workspaceBindingVersion?: number
}

export function isWorkbenchGitSnapshotForProjectRoot(
  snapshot: Nullable<{ rootPath: Nullable<string> }>,
  activeProject: Nullable<Pick<WorkbenchProject, 'rootPath'>>
): boolean {
  return !!activeProject && snapshot?.rootPath === activeProject.rootPath
}

/**
 * Workbench Git 状态：
 * - 顶栏 +/-：`useWorkspaceGitLineStats`（轻量 IPC）
 * - Git 面板 / 变更树：完整 `useWorkspaceGitSummaries`
 *
 * 刷新时机都在这里：挂载与 workspace 绑定完成、Git 界面打开、Git 操作之后、一轮 Agent 结束，以及工作区
 * 一有改动（文件监听事件、Agent 的项目写工具回执）就合并刷新一次——顶栏 +/- 总是跟，完整快照只在 Git
 * 界面开着时跟（界面打开那一刻会补拉一次）。
 */
export function useWorkbenchGitState({
  activeProject,
  gitSurfacesActive,
  workspaceBindingVersion = 0,
}: UseWorkbenchGitStateOptions) {
  const workspaceRoot = activeProject?.rootPath ?? null
  const projectEnabled = !!activeProject

  const {
    activeSummary: summary,
    isLoading: isSummaryLoading,
    error: summaryError,
    refresh: refreshSummary,
  } = useWorkspaceGitSummaries(workspaceRoot, {
    enabled: projectEnabled,
    refreshOnMount: false,
  })

  const {
    snapshot: lineStatsSnapshot,
    isLoading: isLineStatsLoading,
    error: lineStatsError,
    refresh: refreshLineStats,
  } = useWorkspaceGitLineStats(workspaceRoot, {
    enabled: projectEnabled,
    refreshOnMount: true,
  })

  const refreshSummaryLatest = useLatest(refreshSummary)
  const refreshLineStatsLatest = useLatest(refreshLineStats)
  const gitSurfacesActiveLatest = useLatest(gitSurfacesActive)
  const [workspaceChangeRefresh] = useState(() =>
    createCoalescedRefresh(WorkbenchGitWorkspaceChangeRefreshDelayMs, async () => {
      await Promise.all([
        refreshLineStatsLatest.current({ reason: 'files-changed' }),
        gitSurfacesActiveLatest.current
          ? refreshSummaryLatest.current({ reason: 'files-changed' })
          : undefined,
      ])
    })
  )
  // 换项目（或卸载）时撤掉给上一个项目排着的那一次。
  useEffect(() => () => workspaceChangeRefresh.cancel(), [workspaceChangeRefresh, workspaceRoot])

  useWorkspaceFilesChangedRefresh({
    rootPath: workspaceRoot,
    enabled: projectEnabled,
    onChanged: workspaceChangeRefresh.schedule,
  })

  // 文件监听也会报 Agent 写的文件；回执这一路让写工具一落盘就排上刷新，不等监听那一拍。
  useEffect(() => {
    if (!projectEnabled) return undefined
    return window.velarosWorkbenchKernel.onAgentExecution((envelope) => {
      if (isWorkbenchAgentProjectWriteResult(envelope)) workspaceChangeRefresh.schedule()
    })
  }, [projectEnabled, workspaceChangeRefresh])

  const scopedSummary = isWorkbenchGitSnapshotForProjectRoot(summary, activeProject)
    ? summary
    : null
  const scopedLineStatsSnapshot = isWorkbenchGitSnapshotForProjectRoot(
    lineStatsSnapshot,
    activeProject
  )
    ? lineStatsSnapshot
    : null

  const topBarSummary = useMemo(
    () => buildWorkbenchGitTopBarSummary(scopedSummary, scopedLineStatsSnapshot),
    [scopedLineStatsSnapshot, scopedSummary]
  )
  const canShowGitBranchControl = resolveWorkbenchCanShowGitBranchControl(
    scopedSummary,
    scopedLineStatsSnapshot
  )
  const hasGitRepository = resolveWorkbenchHasGitRepository(scopedSummary, scopedLineStatsSnapshot)
  const changeItems = useMemo(
    () =>
      scopedSummary?.repository
        ? buildWorkbenchGitChangeItems(scopedSummary.status?.entries ?? [])
        : [],
    [scopedSummary?.repository, scopedSummary?.status?.entries]
  )
  const decorations = useMemo(
    () =>
      scopedSummary?.repository
        ? buildWorkbenchGitDecorationMap(changeItems)
        : EMPTY_WORKBENCH_GIT_DECORATIONS,
    [changeItems, scopedSummary?.repository]
  )

  useEffect(() => {
    if (!activeProject || !gitSurfacesActive) return

    void refreshSummaryLatest.current({ reason: 'surface-open' })
  }, [activeProject?.id, gitSurfacesActive, refreshSummaryLatest])

  useEffect(() => {
    if (!activeProject || workspaceBindingVersion <= 0) return

    void refreshLineStatsLatest.current({ reason: 'workspace-bound', force: true })
    if (gitSurfacesActive) {
      void refreshSummaryLatest.current({ reason: 'workspace-bound', force: true })
    }
  }, [
    activeProject?.id,
    gitSurfacesActive,
    refreshLineStatsLatest,
    refreshSummaryLatest,
    workspaceBindingVersion,
  ])

  const refreshAfterGitAction = useMemo(
    () => async (): Promise<void> => {
      await Promise.all([
        refreshSummary({ reason: 'git-action', force: true }),
        refreshLineStats({ reason: 'git-action', force: true }),
      ])
    },
    [refreshLineStats, refreshSummary]
  )

  const refreshAfterAgentRun = useMemo(
    () => async (): Promise<void> => {
      await Promise.all([
        refreshSummary({ reason: 'agent-run-finished' }),
        refreshLineStats({ reason: 'files-changed' }),
      ])
    },
    [refreshLineStats, refreshSummary]
  )

  const refreshGitPanel = useMemo(
    () => async (): Promise<void> => {
      await Promise.all([
        refreshSummary({ reason: 'manual', force: true }),
        refreshLineStats({ reason: 'manual', force: true }),
      ])
    },
    [refreshLineStats, refreshSummary]
  )

  return {
    changeItems,
    canShowGitBranchControl,
    decorations,
    error: summaryError ?? lineStatsError,
    hasGitRepository,
    isLineStatsLoading,
    isLoading: isSummaryLoading,
    isSummaryLoading,
    lineStatsSnapshot: scopedLineStatsSnapshot,
    refresh: refreshGitPanel,
    refreshAfterAgentRun,
    refreshAfterGitAction,
    refreshGitPanel,
    refreshLineStats,
    refreshSummary,
    workspaceRoot,
    summary: scopedSummary,
    topBarSummary,
  }
}
