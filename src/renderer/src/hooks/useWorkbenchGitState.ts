import { useEffect, useMemo, useState } from 'react'
import {
  buildWorkbenchGitChangeItems,
  buildWorkbenchGitDecorationMap,
  EMPTY_WORKBENCH_GIT_DECORATIONS,
} from '@renderer/models/git/workbenchGitModel'
import {
  buildWorkbenchGitTopBarSummary,
  resolveWorkbenchCanShowGitBranchControl,
  resolveWorkbenchHasGitRepository,
} from '@renderer/models/git/workbenchGitTopBarModel'
import type { WorkbenchProject } from '@renderer/models/project/workbenchProjects'

import { subscribeWorkbenchAgentProjectWrites } from '../runtime/workbenchAgentProjectWrites'
import { type CoalescedRefresh, createCoalescedRefresh } from '../support/coalescedRefresh'
import { useLatest } from '../support/genericHooks'
import { useWorkspaceFilesChangedRefresh } from '../support/useWorkspaceFilesChangedRefresh'
import { useWorkspaceGitLineStats } from '../support/useWorkspaceGitLineStats'
import { useWorkspaceGitSummaries } from '../support/useWorkspaceGitSummaries'

/**
 * 工作区改动后 Git 状态合并刷新的窗口：第一次触发后这么久刷一次，一次落盘的几批文件事件、Agent 连着改的
 * 几个文件都并进这一次。
 */
export const WorkbenchGitWorkspaceChangeRefreshDelayMs = 600

/**
 * Git 界面没开时，完整快照跟工作区改动的节奏：文件树的 Git 颜色靠它，要跟上，但一次构建、一次装依赖
 * 期间不必每 600ms 跑一遍 `git status`、分支列表。
 */
export const WorkbenchGitTreeDecorationRefreshDelayMs = 2_000

interface WorkbenchGitWorkspaceChangeRefreshOptions {
  refreshLineStats: () => Promise<void>
  refreshSummary: () => Promise<void>
  /** Git 界面（Git 面板、提交面板、聊天里的改动卡）开着没有。 */
  isGitSurfaceActive: () => boolean
  lineStatsDelayMs?: number
  treeDecorationDelayMs?: number
}

/**
 * 工作区一有改动就排上的 Git 刷新：顶栏 +/- 总是按
 * {@link WorkbenchGitWorkspaceChangeRefreshDelayMs} 跟；完整快照在 Git 界面开着时同一节奏，
 * 没开时也跟——文件树的 Git 颜色靠它——只是放慢到 {@link WorkbenchGitTreeDecorationRefreshDelayMs}。
 */
export function createWorkbenchGitWorkspaceChangeRefresh({
  refreshLineStats,
  refreshSummary,
  isGitSurfaceActive,
  lineStatsDelayMs = WorkbenchGitWorkspaceChangeRefreshDelayMs,
  treeDecorationDelayMs = WorkbenchGitTreeDecorationRefreshDelayMs,
}: WorkbenchGitWorkspaceChangeRefreshOptions): CoalescedRefresh {
  const topBarAndSurfaces = createCoalescedRefresh({
    delayMs: lineStatsDelayMs,
    run: async () => {
      await Promise.all([refreshLineStats(), isGitSurfaceActive() ? refreshSummary() : undefined])
    },
  })
  const treeDecorations = createCoalescedRefresh({
    delayMs: treeDecorationDelayMs,
    run: refreshSummary,
  })

  return {
    schedule: () => {
      topBarAndSurfaces.schedule()
      if (!isGitSurfaceActive()) treeDecorations.schedule()
    },
    cancel: () => {
      topBarAndSurfaces.cancel()
      treeDecorations.cancel()
    },
  }
}

interface UseWorkbenchGitStateOptions {
  activeProject: Nullable<WorkbenchProject>
  /**
   * Git 相关 UI 可见时为 true（底部 Git 面板、Agent 变更预览等）：打开那一刻补拉完整快照，之后完整快照
   * 跟顶栏同一节奏；为 false 时完整快照也跟（文件树的 Git 颜色靠它），只是放慢。
   */
  gitSurfacesActive: boolean
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
 * 刷新时机都在这里：项目挂载、Git 界面打开、`refresh`（Git 操作之后、手动刷新、一轮 Agent
 * 结束），以及工作区一有改动就合并刷新一次（见 {@link createWorkbenchGitWorkspaceChangeRefresh}）
 * ——顶栏 +/- 与完整快照都跟，文件树的 Git 颜色靠完整快照，打开了项目就要跟上；
 * Git 界面没开时完整快照放慢节奏。
 * 工作区改动有两路：文件监听（用户在编辑器、终端里的改动，也包括 Agent 的）与 Agent 写入信号
 * （workbenchAgentProjectWrites，主 Agent 与子 Agent 的写工具一出结果就到，不等监听那一拍）。
 */
export function useWorkbenchGitState({
  activeProject,
  gitSurfacesActive,
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
    refreshOnMount: true,
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
    createWorkbenchGitWorkspaceChangeRefresh({
      refreshLineStats: () => refreshLineStatsLatest.current(),
      refreshSummary: () => refreshSummaryLatest.current(),
      isGitSurfaceActive: () => gitSurfacesActiveLatest.current,
    })
  )
  // 换项目（或卸载）时撤掉给上一个项目排着的那一次。
  useEffect(() => () => workspaceChangeRefresh.cancel(), [workspaceChangeRefresh, workspaceRoot])

  useWorkspaceFilesChangedRefresh({
    rootPath: workspaceRoot,
    enabled: projectEnabled,
    onChanged: workspaceChangeRefresh.schedule,
  })

  useEffect(() => {
    if (!workspaceRoot) return undefined
    return subscribeWorkbenchAgentProjectWrites(workspaceRoot, workspaceChangeRefresh.schedule)
  }, [workspaceChangeRefresh, workspaceRoot])

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

    void refreshSummaryLatest.current()
  }, [activeProject?.id, gitSurfacesActive, refreshSummaryLatest])

  /** 顶栏 +/- 与完整快照一起重拉：Git 操作之后、手动刷新、一轮 Agent 结束都用它。 */
  const refresh = useMemo(
    () => async (): Promise<void> => {
      await Promise.all([refreshSummary(), refreshLineStats()])
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
    refresh,
    workspaceRoot,
    summary: scopedSummary,
    topBarSummary,
  }
}
