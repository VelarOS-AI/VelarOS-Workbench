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
  /** 以下三项不含冲突文件。 */
  stagedFiles: number
  unstagedFiles: number
  untrackedFiles: number
  /** 还没解决的合并冲突（状态码 DD AU UD UA DU AA UU）。 */
  conflictedFiles: number
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
  /**
   * 按文件查历史时，文件在这个提交里的路径（相对项目根）：改名之前的提交是旧路径，读那时的内容要用它。
   * 不按文件查时没有。
   */
  path?: string
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

/**
 * - `stage` / `unstage`：暂存、取消暂存（冲突文件暂存即标记为已解决）。
 * - `discard`：回滚。工作区里有没暂存的改动时只回滚它们（回到暂存区里的样子，已暂存的留着），
 *   未跟踪的文件删掉；改动全都暂存了时连暂存的一起回滚到 HEAD。
 * - `resolve`：把合并冲突文件标记为已解决（文件里还有冲突标记时拒绝）。
 */
export type WorkspaceGitFileAction = 'discard' | 'stage' | 'unstage' | 'resolve'

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

/**
 * 按块操作：`stage` 把工作区里的这几块放进暂存区，`unstage` 把暂存区里的这几块退回工作区，`discard` 丢掉
 * 工作区里的这几块（回到暂存区里的样子）。
 */
export type WorkspaceGitHunkAction = 'stage' | 'unstage' | 'discard'

export interface WorkspaceGitHunkActionOptions {
  action: WorkspaceGitHunkAction
  /** 相对项目根。 */
  path: string
  /** 暂存了的改名：改名前的路径（取消暂存时，暂存那一侧的补丁要带上它才认得出改名）。 */
  originalPath?: string
  /** 要操作的块，照差异里拆出来的原样给（块头与各行）：服务按它认出同一块，认不出就是文件已经变了。 */
  hunks: Array<{ header: string; lines: string[] }>
}

export interface WorkspaceGitFileActionResult {
  action: WorkspaceGitFileAction
  /** 相对项目根。 */
  paths: string[]
  status: WorkspaceGitStatusResult
}

export interface WorkspaceGitRestoreResult {
  commitSha: string
  changedFiles: number
}

/** 看哪一侧的改动：`staged` 暂存区相对 HEAD，`unstaged` 工作区相对暂存区。 */
export type WorkspaceGitDiffSide = 'staged' | 'unstaged'

export interface WorkspaceGitDiffOptions {
  /**
   * 给了是这个提交的改动；不给时看 `side`，也没给 `side` 是工作区相对 HEAD 的改动（合并冲突看的就是它：
   * HEAD 那一版对照工作区里带冲突标记的那一版）。
   */
  commitSha?: string
  side?: WorkspaceGitDiffSide
  path?: string
  originalPath?: string
  maxChars?: number
}

export interface WorkspaceGitDiffResult {
  scope: 'commit' | 'working' | WorkspaceGitDiffSide
  path?: string
  diff: string
  truncated: boolean
}
