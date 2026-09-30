import type { WorkspaceGitLogEntry } from '@shared/contracts'

/**
 * 按文件查 Git 历史时，文件在这个提交里的路径与现在不一样（改名、挪位置之前的提交）：返回当时的路径，
 * 历史列表里要写出来，否则看不出这一条说的是另一个名字下的同一个文件。路径没变时为 null。
 */
export function resolveWorkbenchGitHistoryFormerPath(
  commit: Pick<WorkspaceGitLogEntry, 'path'>,
  currentPath: string
): Nullable<string> {
  return commit.path && commit.path !== currentPath ? commit.path : null
}
