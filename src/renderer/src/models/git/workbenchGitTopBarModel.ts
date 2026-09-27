import type {
  SystemWorkspaceGitLineStatsSnapshot,
  SystemWorkspaceGitSummary,
} from '@shared/contracts'

function buildPartialTopBarStatus(
  snapshot: SystemWorkspaceGitLineStatsSnapshot
): NonNullable<SystemWorkspaceGitSummary['status']> {
  const changedFiles = snapshot.lineStats.changedFiles

  return {
    branch: snapshot.branch,
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
  if (!lineStatsSnapshot.branch) return null

  const status = buildPartialTopBarStatus(lineStatsSnapshot)
  const branch = status.branch

  return {
    rootPath: lineStatsSnapshot.rootPath,
    repository: true,
    checkedAt: lineStatsSnapshot.checkedAt,
    lineStats: lineStatsSnapshot.lineStats,
    branches: branch ? [{ name: branch, current: true, upstream: null }] : [],
    status,
  }
}

export function resolveWorkbenchHasGitRepository(
  fullSummary: Nullable<SystemWorkspaceGitSummary>,
  lineStatsSnapshot: Nullable<SystemWorkspaceGitLineStatsSnapshot>
): boolean {
  return !!(fullSummary?.repository || lineStatsSnapshot?.repository)
}

export function resolveWorkbenchCanShowGitBranchControl(
  fullSummary: Nullable<SystemWorkspaceGitSummary>,
  lineStatsSnapshot: Nullable<SystemWorkspaceGitLineStatsSnapshot>
): boolean {
  const summary = buildWorkbenchGitTopBarSummary(fullSummary, lineStatsSnapshot)
  return !!(summary?.repository && summary.status?.branch)
}
