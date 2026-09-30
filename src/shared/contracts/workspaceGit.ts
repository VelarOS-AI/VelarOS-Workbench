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

/**
 * 分离的 HEAD：HEAD 没有指着分支（检出的是某个提交或标签，或者变基停在半路），这是它指着的提交。
 */
export interface WorkspaceGitDetachedHead {
  sha: string
  shortSha: string
}

export interface WorkspaceGitStatusResult {
  /** 当前分支；HEAD 是分离的时为 null，这时看 `detachedHead`。 */
  branch: Nullable<string>
  /** HEAD 指着分支时为 null。 */
  detachedHead: Nullable<WorkspaceGitDetachedHead>
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

/**
 * 指着一个提交的引用：
 * - `branch`：本地分支，`name` 如 `feature/login`；`current` 是 HEAD 指着的那个。
 * - `remote`：远端分支，`name` 如 `origin/main`。
 * - `tag`：标签。
 * - `head`：分离的 HEAD（HEAD 直接指着这个提交，不经过分支），`name` 就是 `HEAD`。
 */
export type WorkspaceGitRefKind = 'branch' | 'remote' | 'tag' | 'head'

export interface WorkspaceGitRef {
  kind: WorkspaceGitRefKind
  name: string
  /** 当前分支（只有 `branch` 有）。 */
  current?: boolean
}

export interface WorkspaceGitLogEntry {
  sha: string
  shortSha: string
  subject: string
  authorName: string
  authorEmail: Nullable<string>
  authoredAt: number
  /** 父提交，主线（第一个父提交）在前；根提交为空，合并提交有两个以上。提交图按它连线。 */
  parents: string[]
  refs: WorkspaceGitRef[]
  /**
   * 按文件查历史时，文件在这个提交里的路径（相对项目根）：改名之前的提交是旧路径，读那时的内容要用它。
   * 不按文件查时没有。
   */
  path?: string
}

export interface WorkspaceGitLogOptions {
  /**
   * 只看这个分支（或别的引用、提交）到得了的提交。不给时是全部本地分支和远端分支，加上 HEAD（分离的
   * HEAD 停在哪个分支都到不了的提交上时也列得出）；贮藏、内部引用不算。
   */
  branch?: string
  limit?: number
  /** 跳过最前面的这么多个提交：接着上一页往下读。 */
  skip?: number
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

/**
 * - `fetch`：获取远端。
 * - `pull`：拉取当前分支的上游并合入；没配置过 `pull.rebase`（及 `branch.<分支>.rebase`、`pull.ff`）时合并，
 *   配置了就照配置来。
 * - `sync`：同步，先拉取再推送；拉取出了冲突就不推送。
 * - `upload`：推送。
 */
export type WorkspaceGitRemoteAction = 'fetch' | 'pull' | 'sync' | 'upload'

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
  /** 这次操作的编号，发起方自己起；给了之后凭它中途取消这次操作。 */
  operationId?: string
}

export interface WorkspaceGitRemoteActionResult {
  action: WorkspaceGitRemoteAction
  /** 这次操作的分支；在分离的 HEAD 上获取远端时没有分支，为 null。 */
  branch: Nullable<string>
  upstream: Nullable<string>
  output: string
  /**
   * 拉取（同步）合入时冲突了的文件（相对项目根）：合并或变基停在冲突处，等用户解决；这时不推送。
   * 别的情况为空。
   */
  conflicts: string[]
  /** 冲突出在变基里（`pull.rebase`）：解决后要「继续」变基（提交面板上方的提示条），不是提交。 */
  rebasing: boolean
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

/** 会停在半路等用户接着处理的操作：合并、变基、拣选提交、撤销提交。 */
export type WorkspaceGitOperationKind = 'merge' | 'rebase' | 'cherry-pick' | 'revert'

/**
 * 进行到一半的操作（出了冲突停下来的，或者在终端里起了头的）。冲突解决完之后「继续」，不想要了「放弃」，
 * 变基、拣选、撤销还能「跳过」停在的那个提交。
 */
export interface WorkspaceGitOperationState {
  kind: WorkspaceGitOperationKind
  /** 变基：停在第几个提交上、一共几个；别的操作为 null。 */
  step: Nullable<number>
  total: Nullable<number>
  /**
   * 操作的对象，给界面上看的：合并是 git 备好的合并说明（`Merge branch 'feature'`），变基是正在被
   * 变基的分支名，拣选、撤销是那个提交的短号。读不出来为 null。
   */
  detail: Nullable<string>
}

/**
 * - `merge`：把 `target`（分支或提交）合并到当前分支。
 * - `rebase`：把当前分支变基到 `target` 上。
 * - `cherry-pick`：把提交 `target` 的改动拣选到当前分支。
 * - `revert`：新做一个提交，撤销提交 `target` 的改动。
 * - `continue` / `abort` / `skip`：接着做、放弃、跳过进行到一半的那个操作（`skip` 对合并没有意义）。
 */
export type WorkspaceGitOperationAction =
  | 'merge'
  | 'rebase'
  | 'cherry-pick'
  | 'revert'
  | 'continue'
  | 'abort'
  | 'skip'

export interface WorkspaceGitOperationRequest {
  action: WorkspaceGitOperationAction
  /** 开始一个操作时的对象（分支名、提交）；`continue` / `abort` / `skip` 不用给。 */
  target?: string
}

export interface WorkspaceGitOperationResult {
  action: WorkspaceGitOperationAction
  /**
   * 这一步之后还没解决的冲突文件（相对项目根）：操作停在那里，等用户解决后继续。别的情况为空。
   * 操作还在不在进行看摘要里的 `operation`。
   */
  conflicts: string[]
  /** 什么都没变：要合并、变基的对象当前分支里已经有了。 */
  upToDate: boolean
  output: string
}

/** 一条贮藏（`git stash`）。贮藏是整个仓库的：项目是仓库里的子目录时，列出的也是仓库里全部的贮藏。 */
export interface WorkspaceGitStash {
  /** 贮藏提交的对象名。它是这条贮藏的身份，操作都凭它：`stash@{n}` 的序号每来一条新贮藏就往后挪。 */
  sha: string
  /** 此刻的序号（`stash@{index}`），最新的是 0。 */
  index: number
  /** 贮藏时写的说明；没写时是它基于的提交（`1a2b3c4 提交主题`），见 `autoMessage`。 */
  message: string
  /** 说明是 git 自己拟的（贮藏时没写）。 */
  autoMessage: boolean
  /** 贮藏时所在的分支；分离的 HEAD 上贮藏的为 null。 */
  branch: Nullable<string>
  createdAt: number
  /** 连未跟踪的文件一起贮藏了。 */
  includesUntracked: boolean
}

export interface WorkspaceGitStashOptions {
  message?: string
  /** 连未跟踪的文件一起贮藏（被 .gitignore 忽略的不算）：它们会从工作区里拿走，收在这条贮藏里。 */
  includeUntracked?: boolean
}

/**
 * - `apply`：把贮藏的改动取回工作区，贮藏留着。
 * - `pop`：取回之后删掉这条贮藏；取回时冲突了就不删。
 * - `drop`：直接删掉这条贮藏，里面的改动不再能取回。
 */
export type WorkspaceGitStashAction = 'apply' | 'pop' | 'drop'

export interface WorkspaceGitStashActionResult {
  action: WorkspaceGitStashAction
  stash: WorkspaceGitStash
  /**
   * 取回时与工作区里现有内容冲突了的文件（相对项目根）：文件里留着冲突标记，等用户解决后标记为已解决。
   * 别的情况为空。
   */
  conflicts: string[]
  /** 这条贮藏还在（`apply` 之后，或 `pop` 冲突了没删）。 */
  kept: boolean
}

/** 看哪一侧的改动：`staged` 暂存区相对 HEAD，`unstaged` 工作区相对暂存区。 */
export type WorkspaceGitDiffSide = 'staged' | 'unstaged'

export interface WorkspaceGitDiffOptions {
  /**
   * 给了是这个提交的改动；不给时看 `side`，也没给 `side` 是工作区相对 HEAD 的改动（合并冲突看的就是它：
   * HEAD 那一版对照工作区里带冲突标记的那一版）。
   */
  commitSha?: string
  /**
   * 给了是这条贮藏里的改动（贮藏提交的对象名）：相对它基于的提交改了什么，连同贮藏进去的未跟踪文件。
   * 不能与 `commitSha` 同时给。
   */
  stashSha?: string
  side?: WorkspaceGitDiffSide
  path?: string
  originalPath?: string
  maxChars?: number
}

export interface WorkspaceGitDiffResult {
  scope: 'commit' | 'stash' | 'working' | WorkspaceGitDiffSide
  path?: string
  diff: string
  truncated: boolean
}
