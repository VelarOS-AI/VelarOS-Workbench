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
import { createCoalescedRefresh } from '../support/coalescedRefresh'
import { useLatest } from '../support/genericHooks'
import { useWorkspaceFilesChangedRefresh } from '../support/useWorkspaceFilesChangedRefresh'
import { useWorkspaceGitLineStats } from '../support/useWorkspaceGitLineStats'
import { useWorkspaceGitSummaries } from '../support/useWorkspaceGitSummaries'

/**
 * 工作区改动后 Git 状态合并刷新的窗口：第一次触发后这么久刷一次，一次落盘的几批文件事件、Agent 连着改的
 * 几个文件都并进这一次。
 */
export const WorkbenchGitWorkspaceChangeRefreshDelayMs = 600

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
 * 刷新时机都在这里：挂载与 workspace 绑定完成、Git 界面打开、`refresh`（Git 操作之后、手动刷新、一轮 Agent
 * 结束），以及工作区一有改动就合并刷新一次——顶栏 +/- 总是跟，完整快照只在 Git 界面开着时跟（界面打开
 * 那一刻会补拉一次）。工作区改动有两路：文件监听（用户在编辑器、终端里的改动，也包括 Agent 的）与 Agent
 * 写入信号（workbenchAgentProjectWrites，主 Agent 与子 Agent 的写工具一出结果就到，不等监听那一拍）。
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
    createCoalescedRefresh({
      delayMs: WorkbenchGitWorkspaceChangeRefreshDelayMs,
      run: async () => {
        await Promise.all([
          refreshLineStatsLatest.current(),
          gitSurfacesActiveLatest.current ? refreshSummaryLatest.current() : undefined,
        ])
      },
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

  useEffect(() => {
    if (!activeProject || workspaceBindingVersion <= 0) return

    void refreshLineStatsLatest.current()
    if (gitSurfacesActive) void refreshSummaryLatest.current()
  }, [
    activeProject?.id,
    gitSurfacesActive,
    refreshLineStatsLatest,
    refreshSummaryLatest,
    workspaceBindingVersion,
  ])

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
