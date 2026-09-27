/**
 * Git 服务与 Git 面板共用的数据形状。原先借 Platform 项目包的 `ProjectGit*`；Platform 的项目能力并进
 * `@velaros-ai/velaros` 后不再带 Git 合同，Workbench 自己的 Git 服务与面板是它们唯一的生产方和消费方，
 * 定义收回这里（Desktop 同样收进了自己的合同）。
 */

export interface WorkspaceGitFileStatusEntry {
  /** 相对项目根（项目可能是仓库里的一个子目录）。 */
  path: string
  originalPath?: string
  indexStatus: string
  workTreeStatus: string
}

export interface WorkspaceGitStatusResult {
  branch: Nullable<string>
  upstream: Nullable<string>
  ahead: number
  behind: number
  isClean: boolean
  changedFiles: number
  stagedFiles: number
  unstagedFiles: number
  untrackedFiles: number
  entries: WorkspaceGitFileStatusEntry[]
}

export interface WorkspaceGitBranch {
  name: string
  current: boolean
  upstream: Nullable<string>
  /** 本地分支或远程跟踪引用；没给时按本地分支处理。 */
  kind?: 'local' | 'remote'
  /** 最近一次提交时间，让分支菜单保持稳定、常用分支优先。 */
  lastCommitAt?: number
}

export interface WorkspaceGitLogEntry {
  sha: string
  shortSha: string
  subject: string
  authorName: string
  authorEmail: Nullable<string>
  authoredAt: number
  refs: string[]
}

export interface WorkspaceGitLogOptions {
  branch?: string
  limit?: number
  /** 限定为某个文件的历史（`git log --follow -- <path>`），用于「查看 Git 历史」。 */
  path?: string
}

export interface WorkspaceGitLineStats {
  additions: number
  deletions: number
  changedFiles: number
  binaryFiles: number
}

export interface WorkspaceGitCommitResult {
  commitSha: string
  message: string
  changedFiles: number
  lineStats: WorkspaceGitLineStats
}

export type WorkspaceGitRemoteAction = 'fetch' | 'update' | 'upload'

export type WorkspaceGitFileAction = 'discard' | 'stage' | 'unstage'

export interface WorkspaceGitRemoteActionOptions {
  githubToken?: string
  privateKeyPath?: string
  sshKeyPath?: string
  /** 上传时指定本地分支；不给就是当前分支。 */
  branch?: string
}

export interface WorkspaceGitRemoteActionResult {
  action: WorkspaceGitRemoteAction
  branch: string
  upstream: Nullable<string>
  output: string
}

export interface WorkspaceGitFileActionResult {
  action: WorkspaceGitFileAction
  path: string
  status: WorkspaceGitStatusResult
}

export interface WorkspaceGitRestoreResult {
  commitSha: string
  changedFiles: number
}

export interface WorkspaceGitDiffOptions {
  /**
   * 给了是这个提交的改动；不给是工作区相对 HEAD 的改动——提交面板提交的就是工作区里的文件，
   * 暂存了一半的文件也按整份算，差异要跟提交的内容一致。
   */
  commitSha?: string
  path?: string
  originalPath?: string
  maxChars?: number
}

export interface WorkspaceGitDiffResult {
  scope: 'commit' | 'working'
  path?: string
  diff: string
  truncated: boolean
}
