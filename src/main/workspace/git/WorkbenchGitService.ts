import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFile, realpath, rm, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { promisify } from 'node:util'

import { execa } from 'execa'

import { optionalWhen, toOptional } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import type {
  AppLocale,
  SystemWorkspaceGitActionResult,
  SystemWorkspaceGitCommitMessageResult,
  SystemWorkspaceGitCommitResult,
  SystemWorkspaceGitCreateBranchResult,
  SystemWorkspaceGitDiffResult,
  SystemWorkspaceGitFileActionResult,
  SystemWorkspaceGitFileAtCommitResult,
  SystemWorkspaceGitInitializeRepositoryResult,
  SystemWorkspaceGitLineStatsSnapshot,
  SystemWorkspaceGitLogResult,
  SystemWorkspaceGitSummary,
  SystemWorkspaceGitSwitchBranchResult,
  WorkspaceGitBranch,
  WorkspaceGitCommitResult,
  WorkspaceGitDiffOptions,
  WorkspaceGitFileAction,
  WorkspaceGitFileStatusEntry,
  WorkspaceGitLineStats,
  WorkspaceGitLogEntry,
  WorkspaceGitLogOptions,
  WorkspaceGitRemoteAction,
  WorkspaceGitRemoteActionOptions,
  WorkspaceGitRemoteActionResult,
  WorkspaceGitStatusResult,
} from '@shared/contracts'
import { isWorkspaceGitConflictEntry } from '@shared/workbenchGit'

import {
  getRelativePathInsideRoot,
  toPortableRelativePath,
} from '../PathContainmentHelper'
import { decodeWorkbenchTextContent } from '../TextCodec'

const DefaultDiffMaxChars = 20_000
const MaxDiffChars = 1_000_000
const DefaultLogLimit = 60
const MaxLogLimit = 200
const MaxUntrackedStatBytes = 1024 * 1024
const MaxUntrackedStatFiles = 100
const CommitSubjectMaxChars = 72
const GitOutputMaxBytes = 4 * 1024 * 1024
const execFileAsync = promisify(execFile)
/**
 * 逐个文件列出的输出（status、numstat、未跟踪文件）的上限：项目里有没被忽略的 node_modules、venv 时，
 * 一个个文件列出来远不止 4 MB。
 */
const GitListingMaxBytes = 32 * 1024 * 1024
/** 未跟踪文件多过这个数时按目录列（一个目录一行），面板不用逐行渲染几万个文件。 */
const MaxExpandedUntrackedFiles = 5_000
/** 获取远端、推送的时限：网络卡住、远端等着输入凭据时不一直挂着。 */
const RemoteActionTimeoutMs = 120_000
/** 标记冲突已解决前检查冲突标记，最多读这么大的文件；更大的不查。 */
const MaxConflictMarkerScanBytes = 16 * 1024 * 1024
/** 冲突标记：行首 7 个 `<` 或 `>`，后面是空格（分支名）或行尾。 */
const ConflictMarkerPattern = /^(?:<{7}|>{7})(?: |\r?$)/m
/** 日志的每个提交以 \x1e 开头，字段之间是 \x1f。 */
const LogFormat = '--format=%x1e%H%x1f%h%x1f%s%x1f%an%x1f%ae%x1f%ct%x1f%D'

/**
 * 每条 git 命令都带上的配置。输出要拿来解析，不能跟着用户的 git 配置变：中文文件名被转成八进制转义、
 * diff 头不带 a/ b/ 前缀或换成别的前缀、只列当前目录下的改动、log 里夹着签名校验结果……
 */
const GitOutputConfig = [
  'core.quotePath=false',
  'color.ui=false',
  'diff.noprefix=false',
  'diff.mnemonicPrefix=false',
  'diff.srcPrefix=a/',
  'diff.dstPrefix=b/',
  'diff.relative=false',
  'log.showSignature=false',
].flatMap((setting) => ['-c', setting])

/** 要带上一起完成的操作：进行中时 git 不许只提交一部分文件。 */
const InProgressOperations = [
  { ref: 'MERGE_HEAD', label: '合并' },
  { ref: 'CHERRY_PICK_HEAD', label: '拣选提交' },
] as const

interface GitRunOptions extends WorkspaceGitRemoteActionOptions {
  allowFailure?: boolean
  /** 写进标准输入的内容（`--pathspec-from-file=-`）。 */
  input?: string
  /** 这条命令额外的环境变量（临时索引 GIT_INDEX_FILE 之类）；盖不过安全设置。 */
  env?: NodeJS.ProcessEnv
  /** 输出上限，默认 GitOutputMaxBytes。 */
  maxBuffer?: number
  /** 输出超过上限时不报错，结果标成 truncated，调用方换个问法。 */
  allowTruncated?: boolean
  /** 超过这么久就结束 git 进程，报超时。 */
  timeoutMs?: number
}

interface GitRunResult {
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
interface GitRepository {
  rootPath: string
  /** 项目根相对仓库根的前缀，如 `packages/app/`；项目就是仓库根时为空串。 */
  prefix: string
}

interface GitBranchUpstream {
  /** 如 `origin/main`。 */
  name: string
  remote: string
  /** 远端那边的分支引用，如 `refs/heads/main`。 */
  remoteRef: string
}

const EmptyLineStats: WorkspaceGitLineStats = {
  additions: 0,
  deletions: 0,
  changedFiles: 0,
  binaryFiles: 0,
}

export interface WorkbenchGitServiceOptions {
  /**
   * git 命令的基础环境，提交钩子（husky、lint-staged）和 git-lfs 也跑在里面。应用给的是登录 shell 的
   * 环境：从程序坞启动时应用自己的环境只有系统默认的 PATH，钩子找不到 node，git-lfs 也找不到。
   * 不给时用应用自己的环境。
   */
  environment?: () => Promise<NodeJS.ProcessEnv>
  /** 获取远端、推送的时限，默认 RemoteActionTimeoutMs。 */
  remoteActionTimeoutMs?: number
}

export class WorkbenchGitService {
  private readonly readEnvironment: () => Promise<NodeJS.ProcessEnv>
  private readonly remoteActionTimeoutMs: number

  constructor(options: WorkbenchGitServiceOptions = {}) {
    this.readEnvironment = options.environment ?? (() => Promise.resolve(process.env))
    this.remoteActionTimeoutMs = options.remoteActionTimeoutMs ?? RemoteActionTimeoutMs
  }

  public async getSummary(workspaceRoot: string): Promise<SystemWorkspaceGitSummary> {
    const rootPath = await this.resolveRoot(workspaceRoot)
    try {
      const repository = await this.openRepository(rootPath)
      const [status, branches, lineStats] = await Promise.all([
        this.getStatus(repository),
        this.listBranches(rootPath),
        this.getLineStatsForRoot(repository),
      ])
      return {
        rootPath,
        repository: true,
        checkedAt: Date.now(),
        status,
        branches,
        lineStats,
      }
    } catch (error) {
      if (this.isNotRepositoryError(error)) return this.emptySummary(rootPath)
      throw error
    }
  }

  public async getLineStats(
    workspaceRoot: string
  ): Promise<SystemWorkspaceGitLineStatsSnapshot> {
    const rootPath = await this.resolveRoot(workspaceRoot)
    try {
      const repository = await this.openRepository(rootPath)
      const [lineStats, branch] = await Promise.all([
        this.getLineStatsForRoot(repository),
        this.getCurrentBranch(rootPath),
      ])
      return { rootPath, repository: true, checkedAt: Date.now(), lineStats, branch }
    } catch (error) {
      if (this.isNotRepositoryError(error))
        return {
          rootPath,
          repository: false,
          checkedAt: Date.now(),
          lineStats: { ...EmptyLineStats },
          branch: null,
        }
      throw error
    }
  }

  public async getDiff(
    workspaceRoot: string,
    options: WorkspaceGitDiffOptions = {}
  ): Promise<SystemWorkspaceGitDiffResult> {
    const rootPath = await this.resolveRoot(workspaceRoot)
    const pathspecs = this.normalizePathspecs(rootPath, [
      options.originalPath,
      options.path,
    ]).map((path) => this.toLiteralPathspec(path))
    const args = options.commitSha
      ? [
          'show',
          '--format=',
          '--patch',
          '--no-ext-diff',
          '--no-color',
          this.assertRevision(options.commitSha),
        ]
      : [
          // 工作区相对 HEAD：提交带走的是工作区里的文件（暂存了一半的也按整份），差异要跟它一致。
          // `--relative`：路径相对项目根，项目外面的改动不列。
          'diff',
          '--no-ext-diff',
          '--no-color',
          '--no-textconv',
          '--find-renames',
          '--relative',
          await this.resolveDiffBase(rootPath),
        ]
    if (pathspecs.length > 0) args.push('--', ...pathspecs)
    const output = (await this.runGit(rootPath, args)).stdout
    const maxChars = Math.min(
      Math.max(options.maxChars ?? DefaultDiffMaxChars, 500),
      MaxDiffChars
    )
    return {
      rootPath,
      scope: options.commitSha ? 'commit' : 'working',
      path: optionalWhen(!!options.path, options.path),
      diff: output.slice(0, maxChars),
      truncated: output.length > maxChars,
    }
  }

  public async getFileAtCommit(
    workspaceRoot: string,
    commitSha: string,
    path: string
  ): Promise<SystemWorkspaceGitFileAtCommitResult> {
    const rootPath = await this.resolveRoot(workspaceRoot)
    const revision = this.assertRevision(commitSha)
    const relativePath = this.normalizePathspec(rootPath, path)
    // `./`：路径相对项目根而不是仓库根（项目可能是仓库里的一个子目录）。
    const blob = await this.showGitBlob(rootPath, `${revision}:./${relativePath}`)
    // 按编辑器读盘的方式解码（认 GB18030 / UTF-16、去 BOM、换行统一为 LF）：拿它跟编辑器里的
    // 正文比时，编码与换行符的差别才不会被算成改动。
    return { rootPath, content: decodeWorkbenchTextContent(blob) }
  }

  public async getLog(
    workspaceRoot: string,
    options: WorkspaceGitLogOptions = {}
  ): Promise<SystemWorkspaceGitLogResult> {
    const rootPath = await this.resolveRoot(workspaceRoot)
    const limit = Math.min(Math.max(Math.floor(options.limit ?? DefaultLogLimit), 1), MaxLogLimit)
    const args = ['log', `--max-count=${limit}`, '--date-order', '--no-color', LogFormat]
    if (options.branch) args.push(this.assertRevision(options.branch))
    else if (!options.path) args.push('--all')
    let file: Nullable<{ path: string; prefix: string }> = null
    if (options.path) {
      file = {
        path: this.normalizePathspec(rootPath, options.path),
        prefix: (await this.openRepository(rootPath)).prefix,
      }
      // 跟着改名往回找，并列出每个提交里这个文件叫什么：改名之前的提交要按旧路径读内容。
      args.push('--follow', '--name-status', '-z', '--', this.toLiteralPathspec(file.path))
    }

    const result = await this.runGit(rootPath, args, { allowFailure: true })
    const output = `${result.stderr}\n${result.stdout}`.toLowerCase()
    if (
      result.failed &&
      !output.includes('does not have any commits') &&
      !output.includes('bad revision') &&
      !output.includes('unknown revision')
    ) {
      this.throwGitFailure(args, result)
    }
    const commits = result.failed
      ? []
      : file
        ? this.parseFileLog(result.stdout, file.prefix, `${file.prefix}${file.path}`)
        : this.parseLog(result.stdout)
    return { rootPath, checkedAt: Date.now(), commits }
  }

  public async generateCommitMessage(
    workspaceRoot: string,
    locale: AppLocale = 'zh-CN',
    paths?: readonly string[]
  ): Promise<SystemWorkspaceGitCommitMessageResult> {
    const rootPath = await this.resolveRoot(workspaceRoot)
    const repository = await this.openRepository(rootPath)
    const status = this.scopeStatus(
      await this.getStatus(repository),
      paths?.length ? this.normalizePathspecs(rootPath, paths) : undefined
    )
    return {
      rootPath,
      message: status.isClean ? null : this.createCommitMessage(status, locale),
    }
  }

  /**
   * 提交。给了路径就只提交这些文件在工作区里的样子，暂存区里别的文件原样留着；没给就是项目里的全部改动
   * （项目是仓库的子目录时不碰项目外面的文件）。还有没解决的冲突时拒绝。
   */
  public async commit(
    workspaceRoot: string,
    locale: AppLocale = 'zh-CN',
    message?: string,
    paths?: readonly string[]
  ): Promise<SystemWorkspaceGitCommitResult> {
    const rootPath = await this.resolveRoot(workspaceRoot)
    const repository = await this.openRepository(rootPath)
    const status = await this.readCommittableStatus(repository)
    const selection = paths?.length
      ? this.scopeStatus(status, this.normalizePathspecs(rootPath, paths))
      : status
    if (selection.isClean) throw new AppError('VALIDATION', '当前选择没有可提交的改动。')
    const operation = await this.getInProgressOperation(rootPath)
    if (operation && selection.changedFiles < status.changedFiles)
      throw new AppError(
        'VALIDATION',
        `正在${operation}：这次提交会一并完成${operation}，必须包含全部改动。请不勾选文件直接提交全部，或勾选全部文件。`
      )

    const parent = await this.readHeadCommit(rootPath)
    const userMessage = message?.trim()
    let commitMessage: Nullable<string> = userMessage || null
    if (operation) {
      // 合并提交收下暂存区里的全部内容：工作区里还没暂存的改动先暂存上。没写说明就用 git 备好的那条。
      await this.stagePaths(
        rootPath,
        selection.entries.filter((entry) => entry.workTreeStatus !== ' ').map((entry) => entry.path)
      )
      await this.runCommit(
        rootPath,
        commitMessage ? ['commit', '-m', commitMessage] : ['commit', '--no-edit']
      )
    } else {
      // `commit --only` 提交的是这些路径在工作区里的样子，不看暂存区；它只认 git 已知的路径，未跟踪的先加进去。
      commitMessage ??= this.createCommitMessage(selection, locale)
      await this.stagePaths(
        rootPath,
        selection.entries.filter((entry) => entry.indexStatus === '?').map((entry) => entry.path)
      )
      await this.runCommit(
        rootPath,
        ['commit', '-m', commitMessage, '--only', '--pathspec-from-file=-', '--pathspec-file-nul'],
        { paths: this.entryPaths(selection.entries) }
      )
    }
    return this.finishCommit(rootPath, parent, commitMessage)
  }

  /**
   * 提交暂存区：提交的是改动在暂存区里的样子，工作区里没暂存的改动留在工作区。项目是仓库的子目录时只提交
   * 项目里暂存的，项目外面暂存的留在暂存区。还有没解决的冲突时拒绝。
   */
  public async commitStaged(
    workspaceRoot: string,
    locale: AppLocale = 'zh-CN',
    message?: string
  ): Promise<SystemWorkspaceGitCommitResult> {
    const rootPath = await this.resolveRoot(workspaceRoot)
    const repository = await this.openRepository(rootPath)
    const status = await this.readCommittableStatus(repository)
    const staged = status.entries.filter((entry) => this.isStagedEntry(entry))
    if (staged.length === 0)
      throw new AppError('VALIDATION', '暂存区里没有可提交的改动。请先暂存要提交的文件。')

    const parent = await this.readHeadCommit(rootPath)
    let commitMessage: Nullable<string> = message?.trim() || null
    if (await this.getInProgressOperation(rootPath)) {
      // 合并、拣选只能整个暂存区一起提交；没写说明就用 git 备好的那条。
      await this.runCommit(
        rootPath,
        commitMessage ? ['commit', '-m', commitMessage] : ['commit', '--no-edit']
      )
    } else {
      commitMessage ??= this.createCommitMessage(this.summarizeStatus(status, staged), locale)
      await this.commitProjectIndex(repository, parent, commitMessage)
    }
    return this.finishCommit(rootPath, parent, commitMessage)
  }

  /** 提交完：读出新提交和它带走的行数，附上最新的摘要。 */
  private async finishCommit(
    rootPath: string,
    parent: Nullable<string>,
    commitMessage: Nullable<string>
  ): Promise<SystemWorkspaceGitCommitResult> {
    const commitSha = (
      await this.runGit(rootPath, ['rev-parse', '--verify', 'HEAD'])
    ).stdout.trim()
    // 行数按提交实际带走的算：提交钩子可能又改了文件。
    const lineStats = this.parseNumstat(
      (
        await this.runGit(
          rootPath,
          [
            'diff',
            '--numstat',
            '-z',
            '--no-ext-diff',
            parent ?? (await this.getEmptyTree(rootPath)),
            commitSha,
          ],
          { maxBuffer: GitListingMaxBytes }
        )
      ).stdout
    )
    const commit: WorkspaceGitCommitResult = {
      commitSha,
      message:
        commitMessage ??
        (await this.runGit(rootPath, ['log', '-1', '--format=%s', commitSha])).stdout.trim(),
      changedFiles: lineStats.changedFiles,
      lineStats,
    }
    return { rootPath, commit, summary: await this.getSummary(rootPath) }
  }

  /** 对一批文件做同一个操作（暂存、取消暂存、回滚、标记冲突已解决）。已经没有改动的路径跳过。 */
  public async performFileAction(
    workspaceRoot: string,
    paths: readonly string[],
    action: WorkspaceGitFileAction
  ): Promise<SystemWorkspaceGitFileActionResult> {
    const rootPath = await this.resolveRoot(workspaceRoot)
    const repository = await this.openRepository(rootPath)
    const relativePaths = this.normalizePathspecs(rootPath, paths)
    if (relativePaths.length === 0) throw new AppError('VALIDATION', '没有要操作的文件。')
    const before = await this.getStatus(repository)
    const entries = relativePaths.flatMap(
      (path) => before.entries.find((candidate) => candidate.path === path) ?? []
    )
    const conflicts = entries.filter((entry) => isWorkspaceGitConflictEntry(entry))
    const settled = entries.filter((entry) => !isWorkspaceGitConflictEntry(entry))

    if (action === 'resolve') {
      const unresolvable = relativePaths.find(
        (path) => !conflicts.some((entry) => entry.path === path)
      )
      if (unresolvable)
        throw new AppError('VALIDATION', `“${unresolvable}”没有待解决的合并冲突。`)
      for (const entry of conflicts) await this.markResolved(rootPath, entry)
    } else if (action === 'stage') {
      // 冲突文件暂存就是标记为已解决（还有冲突标记时拒绝）。
      for (const entry of conflicts) await this.markResolved(rootPath, entry)
      await this.stagePaths(
        rootPath,
        settled.filter((entry) => entry.workTreeStatus !== ' ').map((entry) => entry.path)
      )
    } else if (action === 'unstage' || action === 'discard') {
      if (conflicts.length > 0)
        throw new AppError(
          'VALIDATION',
          `${this.describePaths(conflicts)}还有未解决的合并冲突，不能${action === 'discard' ? '回滚' : '取消暂存'}。请先解决冲突并标记为已解决，或在终端里中止这次合并（git merge --abort）。`
        )
      if (action === 'unstage')
        await this.unstage(
          rootPath,
          this.entryPaths(entries.filter((entry) => this.isStagedEntry(entry)))
        )
      else for (const entry of entries) await this.discard(repository, entry)
    } else {
      throw new AppError('VALIDATION', '不支持的 Git 文件操作。')
    }

    const status = await this.getStatus(repository)
    return {
      rootPath,
      fileAction: { action, paths: relativePaths, status },
      summary: await this.getSummary(rootPath),
    }
  }

  public async initialize(
    workspaceRoot: string
  ): Promise<SystemWorkspaceGitInitializeRepositoryResult> {
    const rootPath = await this.resolveRoot(workspaceRoot)
    await this.runGit(rootPath, ['init'])
    return { rootPath, summary: await this.getSummary(rootPath) }
  }

  /**
   * 切换分支。有没提交的改动不预先拦：git 能把它们带过去就带过去，会被覆盖时 git 自己拒绝，
   * 把它的说明（哪些文件）原样转告。
   */
  public async switchBranch(
    workspaceRoot: string,
    branch: string,
    options: { create?: boolean; startPoint?: string } = {}
  ): Promise<SystemWorkspaceGitSwitchBranchResult> {
    const rootPath = await this.resolveRoot(workspaceRoot)
    const targetBranch = this.assertBranch(branch)
    const previousBranch = await this.getCurrentBranch(rootPath)
    const args = options.create
      ? ['switch', '--create', targetBranch]
      : ['switch', targetBranch]
    if (options.create && options.startPoint)
      args.push(this.assertRevision(options.startPoint))
    const result = await this.runGit(rootPath, args, { allowFailure: true })
    if (result.failed) {
      const output = this.readableGitOutput(result)
      if (/would be overwritten|untracked working tree files/i.test(output))
        throw new AppError('VALIDATION', `Git 拒绝切换分支：${output.slice(0, 800)}`)
      this.throwGitFailure(args, result)
    }
    return {
      rootPath,
      previousBranch,
      branch: targetBranch,
      autoCommit: null,
      restoredAutoCommit: null,
      summary: await this.getSummary(rootPath),
    }
  }

  public async createBranch(
    workspaceRoot: string,
    branch: string
  ): Promise<SystemWorkspaceGitCreateBranchResult> {
    const rootPath = await this.resolveRoot(workspaceRoot)
    const targetBranch = this.assertBranch(branch)
    const currentBranch = await this.getCurrentBranch(rootPath)
    await this.runGit(rootPath, ['branch', targetBranch])
    return {
      rootPath,
      currentBranch,
      branch: targetBranch,
      summary: await this.getSummary(rootPath),
    }
  }

  public async performRemoteAction(
    workspaceRoot: string,
    action: WorkspaceGitRemoteAction,
    options: WorkspaceGitRemoteActionOptions = {}
  ): Promise<SystemWorkspaceGitActionResult> {
    const rootPath = await this.resolveRoot(workspaceRoot)
    const currentBranch = await this.getCurrentBranch(rootPath)
    if (!currentBranch)
      throw new AppError('VALIDATION', '当前 Git 工作区没有可识别的本地分支。')
    const actionBranch =
      action === 'upload' && options.branch ? this.assertBranch(options.branch) : currentBranch
    if (actionBranch !== currentBranch) {
      const exists = await this.runGit(
        rootPath,
        ['rev-parse', '-q', '--verify', `refs/heads/${actionBranch}`],
        { allowFailure: true }
      )
      if (exists.failed) throw new AppError('VALIDATION', `本地没有分支 ${actionBranch}。`)
    }
    const upstream = await this.getBranchUpstream(rootPath, actionBranch)
    if (action === 'update' && !upstream)
      throw new AppError('VALIDATION', `当前分支 ${actionBranch} 没有关联的远程跟踪分支。`)

    let args: string[]
    let resultUpstream = upstream?.name ?? null
    if (action === 'fetch') {
      args = ['fetch', '--prune']
    } else if (action === 'update') {
      args = ['pull', '--ff-only', '--autostash']
    } else if (upstream) {
      args = ['push', upstream.remote, `refs/heads/${actionBranch}:${upstream.remoteRef}`]
    } else {
      const remote = await this.resolvePushRemote(rootPath, actionBranch)
      args = [
        'push',
        '--set-upstream',
        remote,
        `refs/heads/${actionBranch}:refs/heads/${actionBranch}`,
      ]
      resultUpstream = `${remote}/${actionBranch}`
    }
    // 获取与推送有时限，中途结束不伤本地；拉取带着 --autostash，中途结束可能把本地改动留在储藏（stash）
    // 里，不设时限。
    const output = (
      await this.runGit(rootPath, args, {
        ...options,
        timeoutMs: optionalWhen(action !== 'update', this.remoteActionTimeoutMs),
      })
    ).stdout.trim()
    const remoteAction: WorkspaceGitRemoteActionResult = {
      action,
      branch: actionBranch,
      upstream: resultUpstream,
      output,
    }
    return { rootPath, action: remoteAction, summary: await this.getSummary(rootPath) }
  }

  /**
   * 还没有上游的分支第一次推送推到哪个远端：分支自己配置的远端，其次 `remote.pushDefault`，再次仓库里
   * 唯一的远端；有好几个远端又都没配置时不替用户挑。
   */
  private async resolvePushRemote(rootPath: string, branch: string): Promise<string> {
    for (const key of [
      `branch.${branch}.pushRemote`,
      `branch.${branch}.remote`,
      'remote.pushDefault',
    ]) {
      const configured = await this.readConfig(rootPath, key)
      if (configured && configured !== '.') return configured
    }
    const remotes = (await this.runGit(rootPath, ['remote'])).stdout
      .split(/\r?\n/)
      .map((remote) => remote.trim())
      .filter(Boolean)
    if (remotes.length === 1) return remotes[0]
    if (remotes.length === 0)
      throw new AppError(
        'VALIDATION',
        '当前仓库还没有配置远端，无法推送。请先添加远端（git remote add origin <地址>）。'
      )
    throw new AppError(
      'VALIDATION',
      `仓库有 ${remotes.length} 个远端（${remotes.join('、')}），无法确定把分支 ${branch} 推送到哪一个。请在终端里推送一次并指定远端（git push -u <远端> ${branch}），或设置默认推送远端（git config remote.pushDefault <远端>）。`
    )
  }

  private async readConfig(rootPath: string, key: string): Promise<Nullable<string>> {
    const result = await this.runGit(rootPath, ['config', '--get', key], { allowFailure: true })
    return (!result.failed && result.stdout.trim()) || null
  }

  private async getBranchUpstream(
    rootPath: string,
    branch: string
  ): Promise<Nullable<GitBranchUpstream>> {
    const output = (
      await this.runGit(rootPath, [
        'for-each-ref',
        '--format=%(upstream:short)%09%(upstream:remotename)%09%(upstream:remoteref)',
        `refs/heads/${branch}`,
      ])
    ).stdout
    const [name = '', remote = '', remoteRef = ''] = output.split('\t')
    if (!name.trim() || !remote.trim() || !remoteRef.trim()) return null
    return { name: name.trim(), remote: remote.trim(), remoteRef: remoteRef.trim() }
  }

  /**
   * 项目里的改动。未跟踪文件逐个列出；太多（多半是没被忽略的 node_modules、venv）时改按目录列，
   * 一个目录一行。
   */
  private async getStatus(repository: GitRepository): Promise<WorkspaceGitStatusResult> {
    const expanded = await this.readStatus(repository, '--untracked-files=all')
    if (expanded && expanded.untrackedFiles <= MaxExpandedUntrackedFiles) return expanded
    const collapsed = await this.readStatus(repository, '--untracked-files=normal')
    if (collapsed) return collapsed
    throw new AppError(
      'LIMIT',
      `项目里的改动太多，Git 状态超过 ${GitListingMaxBytes / 1024 / 1024} MB，无法显示。请检查 .gitignore 是否漏掉了 node_modules、构建产物这类目录。`
    )
  }

  /** 输出超过上限时为 null。 */
  private async readStatus(
    repository: GitRepository,
    untrackedFiles: '--untracked-files=all' | '--untracked-files=normal'
  ): Promise<Nullable<WorkspaceGitStatusResult>> {
    // `--no-optional-locks`：只读的 status 不顺手刷新并重写 .git/index。否则工作区每改一次，这次刷新
    // 写下的 .git/index 又被文件监听报回来（监听要放行它：终端里 git add / commit 之后面板得跟上），
    // 平白多一次全量刷新。用户自己的 git 命令照常写 index，照常被监听到。
    // `-- .`：只看项目里的改动（项目可能是仓库里的一个子目录）。
    const result = await this.runGit(
      repository.rootPath,
      [
        '--no-optional-locks',
        'status',
        '--porcelain=v1',
        '--branch',
        untrackedFiles,
        '-z',
        '--',
        '.',
      ],
      { maxBuffer: GitListingMaxBytes, allowTruncated: true }
    )
    return result.truncated ? null : this.parseStatus(result.stdout, repository.prefix)
  }

  private async listBranches(rootPath: string): Promise<WorkspaceGitBranch[]> {
    const output = (
      await this.runGit(rootPath, [
        'for-each-ref',
        '--sort=-committerdate',
        '--format=%(refname:short)%09%(refname)%09%(HEAD)%09%(upstream:short)%09%(committerdate:unix)%09%(symref)',
        'refs/heads',
        'refs/remotes',
      ])
    ).stdout
    return output
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        const [name = '', refname = '', head = '', upstream = '', timestamp = '', symref = ''] =
          line.split('\t')
        return {
          name,
          current: head === '*',
          upstream: upstream || null,
          kind: refname.startsWith('refs/remotes/') ? ('remote' as const) : ('local' as const),
          lastCommitAt: Number(timestamp) * 1000 || 0,
          symbolic: !!symref,
        }
      })
      .filter((branch) => !!branch.name && !branch.symbolic)
      .map(({ symbolic: _symbolic, ...branch }) => branch)
  }

  private async getLineStatsForRoot(repository: GitRepository): Promise<WorkspaceGitLineStats> {
    const { rootPath } = repository
    const tracked = this.parseNumstat(
      (
        await this.runGit(
          rootPath,
          [
            'diff',
            '--numstat',
            '-z',
            '--no-ext-diff',
            await this.resolveDiffBase(rootPath),
            '--',
            '.',
          ],
          { maxBuffer: GitListingMaxBytes }
        )
      ).stdout
    )
    const untrackedPaths = await this.listUntrackedPaths(rootPath)
    const counted = await Promise.all(
      untrackedPaths
        .slice(0, MaxUntrackedStatFiles)
        .map((path) => this.readUntrackedFileLines(rootPath, path))
    )
    return counted.reduce(
      (stats, current) => ({
        ...stats,
        additions: stats.additions + current.additions,
        binaryFiles: stats.binaryFiles + (current.binary ? 1 : 0),
      }),
      { ...tracked, changedFiles: tracked.changedFiles + untrackedPaths.length }
    )
  }

  /** 项目里的未跟踪文件（相对项目根）；太多时跟状态一样按目录算。 */
  private async listUntrackedPaths(rootPath: string): Promise<string[]> {
    const expanded = await this.runGit(
      rootPath,
      ['ls-files', '--others', '--exclude-standard', '-z'],
      { maxBuffer: GitListingMaxBytes, allowTruncated: true }
    )
    if (!expanded.truncated) {
      const paths = expanded.stdout.split('\0').filter(Boolean)
      if (paths.length <= MaxExpandedUntrackedFiles) return paths
    }
    return (
      await this.runGit(
        rootPath,
        ['ls-files', '--others', '--exclude-standard', '--directory', '--no-empty-directory', '-z'],
        { maxBuffer: GitListingMaxBytes }
      )
    ).stdout
      .split('\0')
      .filter(Boolean)
  }

  /** 一个未跟踪文件的行数；二进制、太大的文件只记作二进制，目录不计行。 */
  private async readUntrackedFileLines(
    rootPath: string,
    path: string
  ): Promise<{ additions: number; binary: boolean }> {
    try {
      const absolutePath = resolve(rootPath, this.normalizePathspec(rootPath, path))
      const fileStat = await stat(absolutePath)
      if (!fileStat.isFile()) return { additions: 0, binary: false }
      if (fileStat.size > MaxUntrackedStatBytes) return { additions: 0, binary: true }
      const content = await readFile(absolutePath)
      if (content.includes(0)) return { additions: 0, binary: true }
      const text = content.toString('utf8')
      const lines = text ? text.split(/\r\n|\r|\n/).length - (text.endsWith('\n') ? 1 : 0) : 0
      return { additions: lines, binary: false }
    } catch {
      return { additions: 0, binary: false }
    }
  }

  private async getCurrentBranch(rootPath: string): Promise<Nullable<string>> {
    const result = await this.runGit(rootPath, ['branch', '--show-current'], {
      allowFailure: true,
    })
    return result.failed || !result.stdout.trim() ? null : result.stdout.trim()
  }

  private async readHeadCommit(rootPath: string): Promise<Nullable<string>> {
    const result = await this.runGit(rootPath, ['rev-parse', '-q', '--verify', 'HEAD'], {
      allowFailure: true,
    })
    return (!result.failed && result.stdout.trim()) || null
  }

  /** 工作区改动的对照基准：HEAD；还没有任何提交时是空树（第一次提交带上的就是全部内容）。 */
  private async resolveDiffBase(rootPath: string): Promise<string> {
    return (await this.readHeadCommit(rootPath)) ?? (await this.getEmptyTree(rootPath))
  }

  /** 空树的对象名，随仓库的哈希算法（SHA-1 与 SHA-256 不同）。 */
  private async getEmptyTree(rootPath: string): Promise<string> {
    return (
      await this.runGit(rootPath, ['hash-object', '-t', 'tree', '--stdin'], { input: '' })
    ).stdout.trim()
  }

  /** 进行中、这次提交要一并完成的操作（合并、拣选）；没有为 null。 */
  private async getInProgressOperation(rootPath: string): Promise<Nullable<string>> {
    for (const operation of InProgressOperations) {
      const result = await this.runGit(rootPath, ['rev-parse', '-q', '--verify', operation.ref], {
        allowFailure: true,
      })
      if (!result.failed) return operation.label
    }
    return null
  }

  /** 要提交时的项目状态：没有改动、还有没解决的冲突时拒绝。 */
  private async readCommittableStatus(
    repository: GitRepository
  ): Promise<WorkspaceGitStatusResult> {
    const status = await this.getStatus(repository)
    if (status.isClean) throw new AppError('VALIDATION', '当前项目没有可提交的改动。')
    const conflicts = status.entries.filter((entry) => isWorkspaceGitConflictEntry(entry))
    if (conflicts.length > 0)
      throw new AppError(
        'VALIDATION',
        `${this.describePaths(conflicts)}还有未解决的合并冲突。请先解决冲突并标记为已解决，再提交。`
      )
    return status
  }

  /** 暂存区里有这个文件的改动（冲突文件不算）。 */
  private isStagedEntry(entry: WorkspaceGitFileStatusEntry): boolean {
    return (
      !isWorkspaceGitConflictEntry(entry) && entry.indexStatus !== ' ' && entry.indexStatus !== '?'
    )
  }

  /**
   * 提交暂存区里项目的那部分。项目就是仓库根、或项目外面没有暂存的改动时就是 `git commit`；项目外面还有
   * 暂存的改动时用一份临时索引提交（HEAD，换上项目里暂存了的那些文件），项目外面暂存的原样留在暂存区。
   * 提交钩子看到的是这份临时索引，跟 `git commit --only` 一样。
   */
  private async commitProjectIndex(
    repository: GitRepository,
    parent: Nullable<string>,
    message: string
  ): Promise<void> {
    const { rootPath, prefix } = repository
    const base = parent ?? (await this.getEmptyTree(rootPath))
    if (!prefix || !(await this.hasStagedChangesOutsideProject(rootPath, prefix, base))) {
      await this.runCommit(rootPath, ['commit', '-m', message])
      return
    }

    // 项目里暂存了的改动（路径相对仓库根）。只照这张单子搬：`git add -N` 记下的空条目不算暂存，不能搬。
    const staged = this.parseNameStatus(
      (
        await this.runGit(
          rootPath,
          ['diff', '--cached', '--name-status', '-z', '--no-renames', base, '--', '.'],
          { maxBuffer: GitListingMaxBytes }
        )
      ).stdout
    )
    const kept = new Set(staged.filter((change) => change.status !== 'D').map((change) => change.path))
    const indexEntries = (
      await this.runGit(rootPath, ['ls-files', '--stage', '--full-name', '-z', '--', '.'], {
        maxBuffer: GitListingMaxBytes,
      })
    ).stdout
      .split('\0')
      .filter((line) => kept.has(line.slice(line.indexOf('\t') + 1)))
    const removed = staged.filter((change) => change.status === 'D').map((change) => change.path)

    const [topLevel, gitDirectory] = (
      await this.runGit(rootPath, ['rev-parse', '--show-toplevel', '--absolute-git-dir'])
    ).stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
    if (!topLevel || !gitDirectory) throw new AppError('PLATFORM', '读不到项目所在仓库的位置。')
    const env = { GIT_INDEX_FILE: join(gitDirectory, `velaros-commit-${randomUUID()}.index`) }
    try {
      await this.runGit(topLevel, ['read-tree', parent ?? '--empty'], { env })
      // 在仓库根下跑：`--stdin`、`--index-info` 读到的路径都按仓库根算。
      if (removed.length > 0)
        await this.runGit(topLevel, ['update-index', '-z', '--force-remove', '--stdin'], {
          env,
          input: removed.join('\0'),
        })
      if (indexEntries.length > 0)
        await this.runGit(topLevel, ['update-index', '-z', '--index-info'], {
          env,
          input: `${indexEntries.join('\0')}\0`,
        })
      await this.runCommit(rootPath, ['commit', '-m', message], { env })
    } finally {
      await rm(env.GIT_INDEX_FILE, { force: true })
    }
  }

  /** 仓库里项目外面有没有暂存的改动（`prefix` 是项目相对仓库根的前缀，非空）。 */
  private async hasStagedChangesOutsideProject(
    rootPath: string,
    prefix: string,
    base: string
  ): Promise<boolean> {
    const names = (
      await this.runGit(
        rootPath,
        ['diff', '--cached', '--name-only', '-z', '--no-renames', base],
        { maxBuffer: GitListingMaxBytes }
      )
    ).stdout
    return names.split('\0').some((path) => !!path && !path.startsWith(prefix))
  }

  /** `--name-status -z` 的输出：`状态\0路径\0` 一对一对（不找改名时没有第二个路径）。 */
  private parseNameStatus(raw: string): Array<{ status: string; path: string }> {
    const fields = raw.split('\0')
    const changes: Array<{ status: string; path: string }> = []
    for (let index = 0; index + 1 < fields.length; index += 2) {
      const status = fields[index]
      const path = fields[index + 1]
      if (status && path) changes.push({ status: status.charAt(0), path })
    }
    return changes
  }

  /** `git add -A` 这些路径：逐字匹配，路径从标准输入给，文件再多也不会超出命令行长度。 */
  private async stagePaths(rootPath: string, paths: readonly string[]): Promise<void> {
    if (paths.length === 0) return
    await this.runGit(rootPath, ['add', '-A', '--pathspec-from-file=-', '--pathspec-file-nul'], {
      input: paths.map((path) => this.toLiteralPathspec(path)).join('\0'),
    })
  }

  /** 跑一次 `git commit`；`paths` 从标准输入给 `--pathspec-from-file`，`env` 是临时索引之类。 */
  private async runCommit(
    rootPath: string,
    args: string[],
    options: { paths?: readonly string[]; env?: NodeJS.ProcessEnv } = {}
  ): Promise<void> {
    const result = await this.runGit(rootPath, args, {
      allowFailure: true,
      input: options.paths?.map((path) => this.toLiteralPathspec(path)).join('\0'),
      env: options.env,
    })
    if (!result.failed) return
    const output = `${result.stdout}\n${result.stderr}`.toLowerCase()
    if (
      output.includes('nothing to commit') ||
      output.includes('nothing added to commit') ||
      output.includes('no changes added to commit')
    )
      throw new AppError('VALIDATION', '当前选择没有可提交的改动。')
    this.throwGitFailure(args, result)
  }

  private async unstage(rootPath: string, paths: readonly string[]): Promise<void> {
    if (paths.length === 0) return
    const pathspecs = paths.map((path) => this.toLiteralPathspec(path))
    if (!(await this.readHeadCommit(rootPath))) {
      await this.runGit(rootPath, ['rm', '--cached', '--ignore-unmatch', '--', ...pathspecs])
      return
    }
    await this.runGit(rootPath, ['restore', '--staged', '--', ...pathspecs])
  }

  /**
   * 回滚一个文件。未跟踪的删掉；工作区里有没暂存的改动时只把工作区恢复成暂存区里的样子，已暂存的留着；
   * 改动全都暂存了时连暂存的一起回滚到 HEAD（新增的删掉，改名的改回去）。
   */
  private async discard(
    repository: GitRepository,
    entry: WorkspaceGitFileStatusEntry
  ): Promise<void> {
    const { rootPath } = repository
    const literalPath = this.toLiteralPathspec(entry.path)
    if (entry.indexStatus === '?' && entry.workTreeStatus === '?') {
      await this.runGit(rootPath, ['clean', '-fd', '--', literalPath])
      return
    }
    if (entry.workTreeStatus !== ' ') {
      await this.runGit(rootPath, ['restore', '--worktree', '--', literalPath])
      return
    }
    // 改动全都暂存了：取消暂存，再把工作区恢复成 HEAD 里的样子；HEAD 里没有的（新增的）删掉。
    await this.unstage(rootPath, this.entryPaths([entry]))
    if (entry.originalPath) {
      await this.runGit(rootPath, ['clean', '-fd', '--', literalPath])
      await this.runGit(rootPath, [
        'restore',
        '--worktree',
        '--',
        this.toLiteralPathspec(entry.originalPath),
      ])
      return
    }
    const nextStatus = await this.getStatus(repository)
    const nextEntry = nextStatus.entries.find((candidate) => candidate.path === entry.path)
    if (!nextEntry) return
    await this.runGit(
      rootPath,
      nextEntry.indexStatus === '?' && nextEntry.workTreeStatus === '?'
        ? ['clean', '-fd', '--', literalPath]
        : ['restore', '--worktree', '--', literalPath]
    )
  }

  /** 把冲突文件标记为已解决（`git add`）；文件里还留着冲突标记时拒绝。 */
  private async markResolved(rootPath: string, entry: WorkspaceGitFileStatusEntry): Promise<void> {
    if (await this.hasConflictMarkers(resolve(rootPath, entry.path)))
      throw new AppError(
        'VALIDATION',
        `“${entry.path}”里还有冲突标记（<<<<<<< 或 >>>>>>>），请先解决冲突再标记为已解决。`
      )
    // `-A`：两边都删掉了、或解决成删除时文件已经不在，同样记作已解决（删除）。
    await this.stagePaths(rootPath, [entry.path])
  }

  private async hasConflictMarkers(absolutePath: string): Promise<boolean> {
    const fileStat = await stat(absolutePath).catch(() => null)
    if (!fileStat?.isFile() || fileStat.size > MaxConflictMarkerScanBytes) return false
    const content = await readFile(absolutePath)
    // 二进制文件里 git 不写冲突标记。
    if (content.includes(0)) return false
    return ConflictMarkerPattern.test(content.toString('utf8'))
  }

  private parseStatus(raw: string, prefix: string): WorkspaceGitStatusResult {
    const tokens = raw.split('\0')
    const header = tokens.shift() ?? ''
    const branchInfo = this.parseBranchHeader(header.startsWith('## ') ? header.slice(3) : '')
    const entries: WorkspaceGitFileStatusEntry[] = []
    for (let index = 0; index < tokens.length; index += 1) {
      const token = tokens[index]
      if (!token) continue
      const indexStatus = token[0] ?? ' '
      const workTreeStatus = token[1] ?? ' '
      const renamed = ['R', 'C'].includes(indexStatus) || ['R', 'C'].includes(workTreeStatus)
      const originalToken = renamed ? tokens[++index] : undefined
      const path = this.toProjectPath(prefix, token.slice(3))
      if (!path) continue
      entries.push({
        path,
        indexStatus,
        workTreeStatus,
        originalPath: toOptional(
          originalToken ? this.toProjectPath(prefix, originalToken) : null
        ),
      })
    }
    return this.summarizeStatus(branchInfo, entries)
  }

  private summarizeStatus(
    branchInfo: Pick<WorkspaceGitStatusResult, 'branch' | 'upstream' | 'ahead' | 'behind'>,
    entries: WorkspaceGitFileStatusEntry[]
  ): WorkspaceGitStatusResult {
    const settled = entries.filter((entry) => !isWorkspaceGitConflictEntry(entry))
    return {
      ...branchInfo,
      isClean: entries.length === 0,
      changedFiles: entries.length,
      stagedFiles: settled.filter(
        (entry) => entry.indexStatus !== ' ' && entry.indexStatus !== '?'
      ).length,
      unstagedFiles: settled.filter(
        (entry) => entry.workTreeStatus !== ' ' && entry.workTreeStatus !== '?'
      ).length,
      untrackedFiles: settled.filter(
        (entry) => entry.indexStatus === '?' && entry.workTreeStatus === '?'
      ).length,
      conflictedFiles: entries.length - settled.length,
      entries,
    }
  }

  private parseBranchHeader(raw: string): {
    branch: Nullable<string>
    upstream: Nullable<string>
    ahead: number
    behind: number
  } {
    const normalized = raw
      .replace(/^No commits yet on /i, '')
      .replace(/^Initial commit on /i, '')
    const [branchPart = '', meta = ''] = normalized.split(' [', 2)
    const [branchName = '', upstream = ''] = branchPart.split('...', 2)
    return {
      branch: branchName && !branchName.startsWith('HEAD ') ? branchName : null,
      upstream: upstream || null,
      ahead: Number(meta.match(/ahead\s+(\d+)/)?.[1] ?? 0),
      behind: Number(meta.match(/behind\s+(\d+)/)?.[1] ?? 0),
    }
  }

  private parseLog(raw: string): WorkspaceGitLogEntry[] {
    return raw
      .split('\x1e')
      .map((record) => record.trim())
      .filter(Boolean)
      .map((record) => this.parseLogCommit(record))
  }

  /**
   * `log --follow --name-status -z` 的输出：每个提交是 `\x1e<字段>\0\n<状态>\0<路径>\0`，改名是
   * `R<相似度>\0<旧路径>\0<新路径>\0`，路径相对仓库根。从新往旧读，记着文件在更早的提交里叫什么。
   */
  private parseFileLog(
    raw: string,
    prefix: string,
    currentPath: string
  ): WorkspaceGitLogEntry[] {
    const commits: WorkspaceGitLogEntry[] = []
    let pathInCommit = currentPath
    for (const record of raw.split('\x1e')) {
      const headerEnd = record.indexOf('\0')
      const header = (headerEnd < 0 ? record : record.slice(0, headerEnd)).trim()
      if (!header) continue
      const fields = headerEnd < 0 ? [] : record.slice(headerEnd + 1).split('\0')
      let olderPath = pathInCommit
      for (let index = 0; index < fields.length; index += 1) {
        const status = fields[index]?.trim()
        if (!status) continue
        if (status.startsWith('R') || status.startsWith('C')) {
          olderPath = fields[index + 1] || olderPath
          pathInCommit = fields[index + 2] || pathInCommit
          index += 2
        } else {
          pathInCommit = fields[index + 1] || pathInCommit
          olderPath = pathInCommit
          index += 1
        }
      }
      // 从项目外面挪进来的文件：挪进来之前的提交不在项目里，不列。
      const path = this.toProjectPath(prefix, pathInCommit)
      if (path) commits.push({ ...this.parseLogCommit(header), path })
      pathInCommit = olderPath
    }
    return commits
  }

  private parseLogCommit(header: string): WorkspaceGitLogEntry {
    const [
      sha = '',
      shortSha = '',
      subject = '',
      authorName = '',
      authorEmail = '',
      timestamp = '',
      refs = '',
    ] = header.split('\x1f')
    return {
      sha,
      shortSha,
      subject,
      authorName,
      authorEmail: authorEmail || null,
      authoredAt: Number(timestamp) * 1000 || 0,
      refs: refs.split(',').map((ref) => ref.trim()).filter(Boolean),
    }
  }

  /** `--numstat -z`：`增\t删\t路径\0`；改名是 `增\t删\t\0旧路径\0新路径\0`；二进制文件的增删是 `-`。 */
  private parseNumstat(raw: string): WorkspaceGitLineStats {
    const stats = { ...EmptyLineStats }
    const fields = raw.split('\0')
    for (let index = 0; index < fields.length; index += 1) {
      const field = fields[index]
      if (!field?.trim()) continue
      const [additions = '', deletions = '', path = ''] = field.split('\t')
      if (!path) index += 2
      const binary = additions === '-' || deletions === '-'
      stats.additions += binary ? 0 : Number(additions) || 0
      stats.deletions += binary ? 0 : Number(deletions) || 0
      stats.changedFiles += 1
      stats.binaryFiles += binary ? 1 : 0
    }
    return stats
  }

  private scopeStatus(
    status: WorkspaceGitStatusResult,
    paths?: readonly string[]
  ): WorkspaceGitStatusResult {
    if (!paths?.length) return status
    const pathSet = new Set(paths)
    return this.summarizeStatus(
      status,
      status.entries.filter(
        (entry) =>
          pathSet.has(entry.path) || (!!entry.originalPath && pathSet.has(entry.originalPath))
      )
    )
  }

  private createCommitMessage(status: WorkspaceGitStatusResult, locale: AppLocale): string {
    const entry = status.entries[0]
    const target =
      status.entries.length === 1
        ? entry?.path.split('/').findLast(Boolean) ?? 'workspace'
        : locale === 'zh-CN'
          ? `${status.entries.length} 个文件`
          : `${status.entries.length} files`
    const action =
      entry?.indexStatus === 'A' || entry?.indexStatus === '?'
        ? locale === 'zh-CN'
          ? '新增'
          : 'Add'
        : entry?.indexStatus === 'D' || entry?.workTreeStatus === 'D'
          ? locale === 'zh-CN'
            ? '删除'
            : 'Remove'
          : locale === 'zh-CN'
            ? '更新'
            : 'Update'
    const subject = `${action} ${target}`
    return subject.length <= CommitSubjectMaxChars
      ? subject
      : `${subject.slice(0, CommitSubjectMaxChars - 3).trimEnd()}...`
  }

  private emptySummary(rootPath: string): SystemWorkspaceGitSummary {
    return {
      rootPath,
      repository: false,
      checkedAt: Date.now(),
      status: null,
      branches: [],
      lineStats: { ...EmptyLineStats },
    }
  }

  /** 报错时点名的文件：最多列 5 个，其余说个数。 */
  private describePaths(entries: readonly WorkspaceGitFileStatusEntry[]): string {
    const names = entries
      .slice(0, 5)
      .map((entry) => `“${entry.path}”`)
      .join('、')
    return entries.length > 5 ? `${names} 等 ${entries.length} 个文件` : names
  }

  /** 这些改动涉及的路径：改名的新旧路径都算。 */
  private entryPaths(entries: readonly WorkspaceGitFileStatusEntry[]): string[] {
    return [
      ...new Set(
        entries.flatMap((entry) =>
          entry.originalPath ? [entry.originalPath, entry.path] : [entry.path]
        )
      ),
    ]
  }

  /** git 列出的路径（相对仓库根）换成相对项目根；不在项目里为 null。 */
  private toProjectPath(prefix: string, repositoryPath: string): Nullable<string> {
    if (!prefix) return repositoryPath || null
    if (!repositoryPath.startsWith(prefix)) return null
    return repositoryPath.slice(prefix.length) || null
  }

  /** 逐字匹配的 pathspec：文件名里的 `*`、`?`、`[id]` 不当通配符，不会顺带匹配上别的文件。 */
  private toLiteralPathspec(path: string): string {
    return `:(literal)${path}`
  }

  private normalizePathspecs(
    rootPath: string,
    paths: ReadonlyArray<string | undefined>
  ): string[] {
    return [...new Set(paths.filter((path): path is string => !!path).map((path) =>
      this.normalizePathspec(rootPath, path)
    ))]
  }

  private normalizePathspec(rootPath: string, path: string): string {
    if (!path.trim() || path.includes('\0'))
      throw new AppError('VALIDATION', 'Git 文件路径无效。')
    const absolutePath = isAbsolute(path) ? resolve(path) : resolve(rootPath, path)
    const relativePath = getRelativePathInsideRoot(rootPath, absolutePath)
    if (!relativePath || relativePath === '.')
      throw new AppError('PERMISSION', 'Git 文件路径超出项目根目录。')
    const portablePath = toPortableRelativePath(relativePath)
    // 未跟踪文件太多时按目录列（`dir/`），结尾的 `/` 要留着才对得上那一行。
    return /[/\\]$/.test(path) ? `${portablePath}/` : portablePath
  }

  private assertRevision(revision: string): string {
    const normalized = revision.trim()
    if (
      !normalized ||
      normalized !== revision ||
      normalized.startsWith('-') ||
      /[\0-\x20\x7f]/.test(normalized)
    ) {
      throw new AppError('VALIDATION', 'Git 引用名称无效。')
    }
    return normalized
  }

  private assertBranch(branch: string): string {
    const normalized = this.assertRevision(branch)
    if (normalized.includes('..') || normalized.endsWith('.') || normalized.endsWith('/'))
      throw new AppError('VALIDATION', '目标分支名称无效。')
    return normalized
  }

  private async resolveRoot(workspaceRoot: string): Promise<string> {
    if (!workspaceRoot.trim()) throw new AppError('VALIDATION', '工作区根目录不能为空。')
    const rootPath = await realpath(resolve(workspaceRoot))
    const rootStat = await stat(rootPath)
    if (!rootStat.isDirectory()) throw new AppError('VALIDATION', '工作区根目录不存在。')
    return rootPath
  }

  /** 项目在仓库里的位置；不是 Git 仓库时抛「不是 Git 仓库」。 */
  private async openRepository(rootPath: string): Promise<GitRepository> {
    const prefix = (await this.runGit(rootPath, ['rev-parse', '--show-prefix'])).stdout
    return { rootPath, prefix }
  }

  private async runGit(
    rootPath: string,
    args: string[],
    options: GitRunOptions = {}
  ): Promise<GitRunResult> {
    const maxBuffer = options.maxBuffer ?? GitOutputMaxBytes
    // 有时限的命令单独成一个进程组：超时时连同 git 起的 ssh 一起结束，不留下还连着远端的进程。
    const ownProcessGroup = !!options.timeoutMs && process.platform !== 'win32'
    const subprocess = execa('git', [...GitOutputConfig, ...args], {
      cwd: rootPath,
      env: await this.buildGitEnvironment(options),
      input: options.input,
      maxBuffer,
      timeout: options.timeoutMs,
      detached: ownProcessGroup,
      reject: false,
    })
    const result = await subprocess
    const output: GitRunResult = {
      stdout: result.stdout,
      stderr: result.stderr,
      failed: result.failed,
      truncated: result.isMaxBuffer,
    }
    if (result.timedOut) {
      if (ownProcessGroup && subprocess.pid) {
        try {
          process.kill(-subprocess.pid, 'SIGKILL')
        } catch {
          // 进程组里已经没有进程了。
        }
      }
      throw new AppError(
        'TIMEOUT',
        `git ${this.describeCommand(args)} 超过 ${Math.round((options.timeoutMs ?? 0) / 1000)} 秒没有完成，已停止。请检查网络连接和远端凭据后重试。`
      )
    }
    if (result.isMaxBuffer) {
      if (options.allowTruncated) return output
      throw new AppError(
        'LIMIT',
        `git ${this.describeCommand(args)} 的输出超过 ${Math.round(maxBuffer / 1024 / 1024)} MB，已停止读取。`
      )
    }
    if (result.failed && !options.allowFailure)
      this.throwGitFailure(args, output, options.githubToken)
    return output
  }

  /**
   * 原样读出一个 blob 的字节：不按 UTF-8 解码，也不去掉末尾的换行。用 execFile 而不是 execa：
   * execa 的 `encoding: 'buffer'` 在 bun 下（测试、probe）起不来子进程。
   */
  private async showGitBlob(rootPath: string, spec: string): Promise<Uint8Array> {
    const args = ['show', spec]
    try {
      const { stdout } = await execFileAsync('git', [...GitOutputConfig, ...args], {
        cwd: rootPath,
        env: await this.buildGitEnvironment({}),
        encoding: 'buffer',
        maxBuffer: GitOutputMaxBytes,
      })
      return stdout
    } catch (error) {
      const { stderr, code } = error as { stderr?: unknown; code?: unknown }
      return this.throwGitFailure(args, {
        stdout: '',
        stderr: Buffer.isBuffer(stderr) ? stderr.toString('utf8') : AppError.getMessage(error),
        failed: true,
        truncated: code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
      })
    }
  }

  /** 报错里说的是哪条 git 命令：第一个不是选项的参数。 */
  private describeCommand(args: readonly string[]): string {
    return args.find((arg) => !arg.startsWith('-')) ?? ''
  }

  private throwGitFailure(
    args: string[],
    result: GitRunResult,
    githubToken?: string
  ): never {
    const output = this.redactGitOutput(this.readableGitOutput(result), githubToken)
    if (output.toLowerCase().includes('not a git repository'))
      throw new AppError('VALIDATION', '当前工作区不是 Git 仓库。')
    throw new AppError(
      'PLATFORM',
      output
        ? `Git 命令执行失败：${output.slice(0, 500)}`
        : `Git 命令执行失败：git ${this.describeCommand(args)}`
    )
  }

  /** git 的报错正文：优先 stderr；`-z` 输出里的 NUL 换成换行。 */
  private readableGitOutput(result: GitRunResult): string {
    return (result.stderr.trim() || result.stdout.trim()).replaceAll('\0', '\n')
  }

  private redactGitOutput(output: string, githubToken?: string): string {
    const withoutUrlCredentials = output.replace(
      /https:\/\/[^@\s/]+@github\.com/gi,
      'https://***@github.com'
    )
    const token = githubToken?.trim()
    return token ? withoutUrlCredentials.replaceAll(token, '***') : withoutUrlCredentials
  }

  private isNotRepositoryError(error: unknown): boolean {
    return (
      error instanceof AppError &&
      error.code === 'VALIDATION' &&
      error.message.includes('不是 Git 仓库')
    )
  }

  private async buildGitEnvironment(options: GitRunOptions): Promise<NodeJS.ProcessEnv> {
    // git 的 porcelain 输出与错误正文都吃 locale：宿主装了中文 gettext 目录时
    // "not a git repository" 会变成「不是 Git 仓库」，把 VALIDATION 误判成 PLATFORM。
    // 解析 git 输出必须钉死 C locale，这是解析方的责任，不是用户环境的责任。
    const env: NodeJS.ProcessEnv = {
      ...(await this.readBaseEnvironment()),
      ...options.env,
      GIT_TERMINAL_PROMPT: '0',
      LC_ALL: 'C',
      LANG: 'C',
    }
    const token = options.githubToken?.trim()
    if (token) {
      const index = Number.isFinite(Number(env.GIT_CONFIG_COUNT))
        ? Number(env.GIT_CONFIG_COUNT)
        : 0
      env.GIT_CONFIG_COUNT = String(index + 1)
      env[`GIT_CONFIG_KEY_${index}`] =
        `url.https://x-access-token:${encodeURIComponent(token)}@github.com/.insteadOf`
      env[`GIT_CONFIG_VALUE_${index}`] = 'https://github.com/'
    }
    const keyPath = options.privateKeyPath?.trim() || options.sshKeyPath?.trim()
    if (keyPath) {
      const normalized =
        keyPath === '~'
          ? homedir()
          : keyPath.startsWith('~/')
            ? join(homedir(), keyPath.slice(2))
            : keyPath
      env.GIT_SSH_COMMAND = `ssh -i '${normalized.replaceAll("'", "'\\''")}' -o IdentitiesOnly=yes`
    }
    return env
  }

  private async readBaseEnvironment(): Promise<NodeJS.ProcessEnv> {
    try {
      return await this.readEnvironment()
    } catch {
      // 登录环境读不出来（比如应用正在退出）时退回应用自己的环境：git 照样能跑，只是钩子可能缺 PATH。
      return process.env
    }
  }
}
