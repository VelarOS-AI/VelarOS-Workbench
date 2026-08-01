import { useEffect, useMemo } from 'react'
import {
  buildWorkbenchGitChangeItems,
  buildWorkbenchGitDecorationMap,
  EMPTY_WORKBENCH_GIT_DECORATIONS,
} from '@workbench/models/git/workbenchGitModel'
import {
  buildWorkbenchGitTopBarSummary,
  resolveWorkbenchCanShowGitBranchControl,
  resolveWorkbenchHasGitRepository,
} from '@workbench/models/git/workbenchGitTopBarModel'
import type { WorkbenchProject } from '@workbench/models/project/workbenchProjects'

import { useLatest } from '../support/genericHooks'
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
 * - 顶栏 +/-：`useWorkspaceGitLineStats`（文件监听防抖，轻量 IPC）
 * - Git 面板 / 变更树：完整 `useWorkspaceGitSummaries`（按需拉取，不监听文件）
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
    watchFileChanges: false,
    watchSessionWorkspace: false,
  })

  const {
    snapshot: lineStatsSnapshot,
    isLoading: isLineStatsLoading,
    error: lineStatsError,
    refresh: refreshLineStats,
  } = useWorkspaceGitLineStats(workspaceRoot, {
    enabled: projectEnabled,
    refreshOnMount: true,
    watchFileChanges: true,
  })

  const refreshSummaryLatest = useLatest(refreshSummary)
  const refreshLineStatsLatest = useLatest(refreshLineStats)
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
