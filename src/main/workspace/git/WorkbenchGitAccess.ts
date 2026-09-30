import type {
  SystemWorkspaceGitSummary,
  WorkspaceGitFileStatusEntry,
  WorkspaceGitRemoteActionOptions,
  WorkspaceGitStatusResult,
} from '@shared/contracts'

import type { WorkbenchMainMessageKey } from '../../i18n/workbenchMainMessages'

export interface GitRunOptions extends WorkspaceGitRemoteActionOptions {
  allowFailure?: boolean
  /** 写进标准输入的内容（`--pathspec-from-file=-`、`blame --contents -`）。 */
  input?: string | Uint8Array
  /** 这条命令额外的环境变量（临时索引 GIT_INDEX_FILE 之类）；盖不过安全设置。 */
  env?: NodeJS.ProcessEnv
  /**
   * 保留输出末尾的换行。补丁要原样拼回去交给 `git apply`：默认会连 `\r\n` 一起去掉，CRLF 文件的
   * 最后一行就对不上了。
   */
  keepFinalNewline?: boolean
  /** 输出上限，默认 GitOutputMaxBytes。 */
  maxBuffer?: number
  /** 输出超过上限时不报错，结果标成 truncated，调用方换个问法。 */
  allowTruncated?: boolean
  /** 这么久没有任何输出（进度也算）就结束 git 进程，报超时。 */
  inactivityTimeoutMs?: number
  /** 取消：结束 git 进程（连同它起的 ssh），报已取消。 */
  signal?: AbortSignal
}

export interface GitRunResult {
  stdout: string
  stderr: string
  failed: boolean
  /** 输出超过上限，git 进程已被结束，stdout 不完整。 */
  truncated: boolean
}

/**
 * 项目所在的仓库。项目可以是仓库里的一个子目录：git 命令都在项目根下跑，pathspec 相对项目根；
 * status、log 列出的路径却相对仓库根，要去掉前缀才是项目里的路径。
 */
export interface GitRepository {
  rootPath: string
  /** 项目根相对仓库根的前缀，如 `packages/app/`；项目就是仓库根时为空串。 */
  prefix: string
}

/**
 * Git 服务交给各功能模块（贮藏……）的内部能力。模块只经它碰仓库：环境、输出配置、报错口径、
 * 「项目是仓库里的子目录」的处理都跟服务本体同一套，不各起各的 git。
 */
export interface WorkbenchGitAccess {
  run(rootPath: string, args: string[], options?: GitRunOptions): Promise<GitRunResult>
  /** 工作区根目录的真实路径；不存在、不是目录时抛错。 */
  resolveRoot(workspaceRoot: string): Promise<string>
  /** 项目在仓库里的位置；不是 Git 仓库时抛「不是 Git 仓库」。 */
  openRepository(rootPath: string): Promise<GitRepository>
  getStatus(repository: GitRepository): Promise<WorkspaceGitStatusResult>
  getSummary(workspaceRoot: string): Promise<SystemWorkspaceGitSummary>
  /** git 的报错正文：优先 stderr。 */
  readOutput(result: GitRunResult): string
  /** 照 git 的原话抛「命令执行失败」。 */
  fail(args: string[], result: GitRunResult): never
  /** 空树的对象名，随仓库的哈希算法。 */
  getEmptyTree(rootPath: string): Promise<string>
  /** git 列出的路径（相对仓库根）换成相对项目根；不在项目里为 null。 */
  toProjectPath(prefix: string, repositoryPath: string): Nullable<string>
  /** 报错时点名的文件：最多列 5 个，其余说个数。 */
  describePaths(entries: readonly WorkspaceGitFileStatusEntry[]): string
  /** 进行到一半的操作（合并、拣选、变基）在文案表里的名字；没有为 null。 */
  readOperationInProgress(rootPath: string): Promise<Nullable<WorkbenchMainMessageKey>>
}
