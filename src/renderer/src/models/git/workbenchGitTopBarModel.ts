import { type SystemWorkspaceGitLineStatsSnapshot, type SystemWorkspaceGitSummary, type WorkspaceGitStatusResult } from '@shared/contracts/system'

import { type WorkbenchI18nContextValue } from '../../i18n/WorkbenchLocalizationProvider'

type WorkbenchGitHead = Pick<WorkspaceGitStatusResult, 'branch' | 'detachedHead'>

/** HEAD 有得显示：在分支上，或者是分离的 HEAD。顶栏的 Git 控件出不出现看它，不只认分支。 */
export function hasWorkbenchGitHead(head: LooseOptional<WorkbenchGitHead>): boolean {
  return !!(head?.branch || head?.detachedHead)
}

/**
 * 顶栏 Git 控件上写的 HEAD：在分支上是分支名；分离的 HEAD 是「分离的 HEAD · 1a2b3c4」（不带 `/`，
 * 分支菜单只显示名字里最后一个 `/` 后面的部分）。两样都没有（还没读到、不是仓库）为 null。
 */
export function describeWorkbenchGitHead(
  head: WorkbenchGitHead,
  t: WorkbenchI18nContextValue['t']
): Nullable<string> {
  if (head.branch) return head.branch
  return head.detachedHead
    ? t('workbench.gitDetachedHead', { sha: head.detachedHead.shortSha })
    : null
}

function buildPartialTopBarStatus(
  snapshot: SystemWorkspaceGitLineStatsSnapshot
): NonNullable<SystemWorkspaceGitSummary['status']> {
  const changedFiles = snapshot.lineStats.changedFiles

  return {
    branch: snapshot.branch,
    detachedHead: snapshot.detachedHead,
    upstream: null,
    ahead: 0,
    behind: 0,
    isClean: changedFiles === 0,
    changedFiles,
    stagedFiles: 0,
    unstagedFiles: 0,
    untrackedFiles: 0,
    conflictedFiles: 0,
    entries: [],
  }
}

/**
 * 合并完整 Git 快照与轻量 lineStats：顶栏 +/- 始终跟 lineStats，分支/提交态优先用完整快照。
 */
export function buildWorkbenchGitTopBarSummary(
  fullSummary: Nullable<SystemWorkspaceGitSummary>,
  lineStatsSnapshot: Nullable<SystemWorkspaceGitLineStatsSnapshot>
): Nullable<SystemWorkspaceGitSummary> {
  if (fullSummary?.repository && fullSummary.status) {
    if (!lineStatsSnapshot?.repository) return fullSummary

    return {
      ...fullSummary,
      checkedAt: lineStatsSnapshot.checkedAt,
      lineStats: lineStatsSnapshot.lineStats,
      status: {
        ...fullSummary.status,
        changedFiles: lineStatsSnapshot.lineStats.changedFiles,
        isClean: lineStatsSnapshot.lineStats.changedFiles === 0,
      },
    }
  }

  if (!lineStatsSnapshot?.repository) return fullSummary
  // HEAD 既不在分支上也读不出提交：还没有可显示的。
  if (!hasWorkbenchGitHead(lineStatsSnapshot)) return null

  const status = buildPartialTopBarStatus(lineStatsSnapshot)
  const branch = status.branch

  return {
    rootPath: lineStatsSnapshot.rootPath,
    repository: true,
    checkedAt: lineStatsSnapshot.checkedAt,
    lineStats: lineStatsSnapshot.lineStats,
    branches: branch ? [{ name: branch, current: true, upstream: null }] : [],
    status,
    // 轻量快照不知道有没有进行到一半的操作：等完整快照来了才有。
    operation: null,
  }
}

export function resolveWorkbenchHasGitRepository(
  fullSummary: Nullable<SystemWorkspaceGitSummary>,
  lineStatsSnapshot: Nullable<SystemWorkspaceGitLineStatsSnapshot>
): boolean {
  return !!(fullSummary?.repository || lineStatsSnapshot?.repository)
}

/** 顶栏的 Git 控件出不出现：是仓库，并且 HEAD 有得显示（在分支上，或者是分离的 HEAD）。 */
export function resolveWorkbenchCanShowGitBranchControl(
  fullSummary: Nullable<SystemWorkspaceGitSummary>,
  lineStatsSnapshot: Nullable<SystemWorkspaceGitLineStatsSnapshot>
): boolean {
  const summary = buildWorkbenchGitTopBarSummary(fullSummary, lineStatsSnapshot)
  return !!summary?.repository && hasWorkbenchGitHead(summary.status)
}
