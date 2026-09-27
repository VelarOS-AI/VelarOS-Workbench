import { execFile } from 'node:child_process'
import { readFile, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { promisify } from 'node:util'

import { execa } from 'execa'

import { optionalWhen } from '@velaros-ai/core'
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

interface GitRunOptions extends WorkspaceGitRemoteActionOptions {
  allowFailure?: boolean
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
      const [status, branches, lineStats] = await Promise.all([
        this.getStatus(rootPath),
        this.listBranches(rootPath),
        this.getLineStatsForRoot(rootPath),
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
      const [lineStats, branch] = await Promise.all([
        this.getLineStatsForRoot(rootPath),
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
    ])
    const args = options.commitSha
      ? [
          'show',
          '--format=',
          '--patch',
          '--no-ext-diff',
          '--no-color',
          this.assertRevision(options.commitSha),
        ]
      : ['diff', '--no-ext-diff', '--no-color', ...(options.staged ? ['--cached'] : [])]
    if (pathspecs.length > 0) args.push('--', ...pathspecs)
    const output = (await this.runGit(rootPath, args)).stdout
    const maxChars = Math.min(
      Math.max(options.maxChars ?? DefaultDiffMaxChars, 500),
      MaxDiffChars
    )
    return {
      rootPath,
      scope: options.commitSha ? 'commit' : options.staged ? 'staged' : 'working',
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
    const args = [
      'log',
      `--max-count=${limit}`,
      '--date-order',
      '--no-color',
      '--format=%H%x1f%h%x1f%s%x1f%an%x1f%ae%x1f%ct%x1f%D%x1e',
    ]
    if (options.branch) args.push(this.assertRevision(options.branch))
    else if (!options.path) args.push('--all')
    if (options.path) args.push('--follow', '--', this.normalizePathspec(rootPath, options.path))

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
    return {
      rootPath,
      checkedAt: Date.now(),
      commits: result.failed ? [] : this.parseLog(result.stdout),
    }
  }

  public async generateCommitMessage(
    workspaceRoot: string,
    locale: AppLocale = 'zh-CN',
    paths?: readonly string[]
  ): Promise<SystemWorkspaceGitCommitMessageResult> {
    const rootPath = await this.resolveRoot(workspaceRoot)
    const status = this.scopeStatus(await this.getStatus(rootPath), paths)
    return {
      rootPath,
      message: status.isClean ? null : this.createCommitMessage(status, locale),
    }
  }

  public async commit(
    workspaceRoot: string,
    locale: AppLocale = 'zh-CN',
    message?: string,
    paths?: readonly string[]
  ): Promise<SystemWorkspaceGitCommitResult> {
    const rootPath = await this.resolveRoot(workspaceRoot)
    const beforeStatus = await this.getStatus(rootPath)
    if (beforeStatus.isClean) throw new AppError('VALIDATION', '当前工作区没有可提交的改动。')

    const commitPaths = this.normalizePathspecs(rootPath, paths ?? [])
    if (commitPaths.length > 0) {
      await this.runGit(rootPath, ['add', '-A', '--', ...commitPaths])
    } else {
      await this.runGit(rootPath, ['add', '-A', '--'])
    }
    const stagedStatus = this.scopeStatus(await this.getStatus(rootPath), commitPaths)
    if (stagedStatus.stagedFiles === 0)
      throw new AppError('VALIDATION', '当前选择没有可提交的改动。')

    const lineStats = this.parseNumstat(
      (
        await this.runGit(
          rootPath,
          ['diff', '--cached', '--numstat', '-z', '--no-ext-diff', '--', ...commitPaths],
          { maxBuffer: GitListingMaxBytes }
        )
      ).stdout
    )
    const commitMessage =
      message?.trim() || this.createCommitMessage(stagedStatus, locale)
    const commitArgs = ['commit', '-m', commitMessage]
    if (commitPaths.length > 0) commitArgs.push('--only', '--', ...commitPaths)
    await this.runGit(rootPath, commitArgs)
    const commitSha = (
      await this.runGit(rootPath, ['rev-parse', '--verify', 'HEAD'])
    ).stdout.trim()
    const commit: WorkspaceGitCommitResult = {
      commitSha,
      message: commitMessage,
      changedFiles: stagedStatus.stagedFiles,
      lineStats,
    }
    return { rootPath, commit, summary: await this.getSummary(rootPath) }
  }

  public async performFileAction(
    workspaceRoot: string,
    path: string,
    action: WorkspaceGitFileAction
  ): Promise<SystemWorkspaceGitFileActionResult> {
    const rootPath = await this.resolveRoot(workspaceRoot)
    const relativePath = this.normalizePathspec(rootPath, path)
    const before = await this.getStatus(rootPath)
    const entry = before.entries.find((candidate) => candidate.path === relativePath)
    const pathspecs = [
      ...(entry?.originalPath ? [entry.originalPath] : []),
      relativePath,
    ]

    if (action === 'stage') {
      await this.runGit(rootPath, ['add', '-A', '--', ...pathspecs])
    } else if (action === 'unstage') {
      await this.unstage(rootPath, pathspecs)
    } else if (action === 'discard') {
      await this.discard(rootPath, entry, pathspecs)
    } else {
      throw new AppError('VALIDATION', '不支持的 Git 文件操作。')
    }

    const status = await this.getStatus(rootPath)
    return {
      rootPath,
      fileAction: { action, path: relativePath, status },
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

  public async switchBranch(
    workspaceRoot: string,
    branch: string,
    options: { create?: boolean; startPoint?: string } = {}
  ): Promise<SystemWorkspaceGitSwitchBranchResult> {
    const rootPath = await this.resolveRoot(workspaceRoot)
    const targetBranch = this.assertBranch(branch)
    const status = await this.getStatus(rootPath)
    if (!status.isClean)
      throw new AppError('VALIDATION', '切换分支前请先提交或丢弃当前改动。')
    const previousBranch = status.branch
    const args = options.create
      ? ['switch', '--create', targetBranch]
      : ['switch', targetBranch]
    if (options.create && options.startPoint)
      args.push(this.assertRevision(options.startPoint))
    await this.runGit(rootPath, args)
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
    const status = await this.getStatus(rootPath)
    if (!status.branch)
      throw new AppError('VALIDATION', '当前 Git 工作区没有可识别的本地分支。')
    const actionBranch =
      action === 'upload' && options.branch
        ? this.assertBranch(options.branch)
        : status.branch
    if (action === 'upload' && actionBranch !== status.branch) {
      await this.runGit(rootPath, ['rev-parse', '--verify', `refs/heads/${actionBranch}`])
    }
    const actionUpstream =
      action === 'upload' && actionBranch !== status.branch
        ? await this.getLocalBranchUpstream(rootPath, actionBranch)
        : status.upstream
    const args =
      action === 'fetch'
        ? ['fetch', '--prune']
        : action === 'update'
          ? ['pull', '--ff-only', '--autostash']
          : actionUpstream
            ? this.buildBranchPushArgs(actionBranch, actionUpstream)
            : [
                'push',
                '--set-upstream',
                'origin',
                `refs/heads/${actionBranch}:refs/heads/${actionBranch}`,
              ]
    if (action === 'update' && !status.upstream)
      throw new AppError('VALIDATION', `当前分支 ${status.branch} 没有关联的远程跟踪分支。`)
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
      upstream: actionUpstream ?? (action === 'upload' ? `origin/${actionBranch}` : null),
      output,
    }
    return { rootPath, action: remoteAction, summary: await this.getSummary(rootPath) }
  }

  private buildBranchPushArgs(branch: string, upstream: string): string[] {
    const separatorIndex = upstream.indexOf('/')
    if (separatorIndex <= 0 || separatorIndex === upstream.length - 1)
      return ['push', '--set-upstream', 'origin', `refs/heads/${branch}:refs/heads/${branch}`]

    const remote = upstream.slice(0, separatorIndex)
    const remoteBranch = upstream.slice(separatorIndex + 1)
    return ['push', remote, `refs/heads/${branch}:refs/heads/${remoteBranch}`]
  }

  private async getLocalBranchUpstream(
    rootPath: string,
    branch: string
  ): Promise<Nullable<string>> {
    const output = (
      await this.runGit(rootPath, [
        'for-each-ref',
        '--format=%(upstream:short)',
        `refs/heads/${branch}`,
      ])
    ).stdout.trim()
    return output || null
  }

  /**
   * 工作区里的改动。未跟踪文件逐个列出；太多（多半是没被忽略的 node_modules、venv）时改按目录列，
   * 一个目录一行。
   */
  private async getStatus(rootPath: string): Promise<WorkspaceGitStatusResult> {
    const expanded = await this.readStatus(rootPath, '--untracked-files=all')
    if (expanded && expanded.untrackedFiles <= MaxExpandedUntrackedFiles) return expanded
    const collapsed = await this.readStatus(rootPath, '--untracked-files=normal')
    if (collapsed) return collapsed
    throw new AppError(
      'LIMIT',
      `项目里的改动太多，Git 状态超过 ${GitListingMaxBytes / 1024 / 1024} MB，无法显示。请检查 .gitignore 是否漏掉了 node_modules、构建产物这类目录。`
    )
  }

  /** 输出超过上限时为 null。 */
  private async readStatus(
    rootPath: string,
    untrackedFiles: '--untracked-files=all' | '--untracked-files=normal'
  ): Promise<Nullable<WorkspaceGitStatusResult>> {
    // `--no-optional-locks`：只读的 status 不顺手刷新并重写 .git/index。否则工作区每改一次，这次刷新
    // 写下的 .git/index 又被文件监听报回来（监听要放行它：终端里 git add / commit 之后面板得跟上），
    // 平白多一次全量刷新。用户自己的 git 命令照常写 index，照常被监听到。
    const result = await this.runGit(
      rootPath,
      ['--no-optional-locks', 'status', '--porcelain=v1', '--branch', untrackedFiles, '-z'],
      { maxBuffer: GitListingMaxBytes, allowTruncated: true }
    )
    return result.truncated ? null : this.parseStatus(result.stdout)
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

  private async getLineStatsForRoot(rootPath: string): Promise<WorkspaceGitLineStats> {
    await this.runGit(rootPath, ['rev-parse', '--is-inside-work-tree'])
    const head = await this.runGit(rootPath, ['rev-parse', '--verify', 'HEAD'], {
      allowFailure: true,
    })
    const readNumstat = async (args: string[]): Promise<WorkspaceGitLineStats> =>
      this.parseNumstat(
        (
          await this.runGit(rootPath, ['diff', '--numstat', '-z', '--no-ext-diff', ...args], {
            maxBuffer: GitListingMaxBytes,
          })
        ).stdout
      )
    const tracked = head.failed
      ? this.mergeLineStats(await readNumstat(['--cached', '--']), await readNumstat(['--']))
      : await readNumstat(['HEAD', '--'])
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

  /** 未跟踪文件（相对项目根）；太多时跟状态一样按目录算。 */
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

  private async unstage(rootPath: string, pathspecs: string[]): Promise<void> {
    const head = await this.runGit(rootPath, ['rev-parse', '--verify', 'HEAD'], {
      allowFailure: true,
    })
    if (head.failed) {
      await this.runGit(rootPath, ['rm', '--cached', '--ignore-unmatch', '--', ...pathspecs])
      return
    }
    await this.runGit(rootPath, ['restore', '--staged', '--', ...pathspecs])
  }

  private async discard(
    rootPath: string,
    entry: WorkspaceGitFileStatusEntry | undefined,
    pathspecs: string[]
  ): Promise<void> {
    if (!entry) return
    if (entry.indexStatus !== '?' && entry.indexStatus !== ' ') {
      await this.unstage(rootPath, pathspecs)
    }
    if (entry.originalPath) {
      await this.runGit(rootPath, ['clean', '-fd', '--', entry.path])
      await this.runGit(rootPath, ['restore', '--worktree', '--', entry.originalPath])
      return
    }
    const nextStatus = await this.getStatus(rootPath)
    const nextEntry = nextStatus.entries.find((candidate) => candidate.path === entry.path)
    if (!nextEntry) return
    if (nextEntry.indexStatus === '?' && nextEntry.workTreeStatus === '?') {
      await this.runGit(rootPath, ['clean', '-fd', '--', entry.path])
      return
    }
    await this.runGit(rootPath, ['restore', '--worktree', '--', ...pathspecs])
  }

  private parseStatus(raw: string): WorkspaceGitStatusResult {
    const tokens = raw.split('\0')
    const header = tokens.shift() ?? ''
    const { branch, upstream, ahead, behind } = this.parseBranchHeader(
      header.startsWith('## ') ? header.slice(3) : ''
    )
    const entries: WorkspaceGitFileStatusEntry[] = []
    for (let index = 0; index < tokens.length; index += 1) {
      const token = tokens[index]
      if (!token) continue
      const indexStatus = token[0] ?? ' '
      const workTreeStatus = token[1] ?? ' '
      const path = token.slice(3)
      const renamed = ['R', 'C'].includes(indexStatus) || ['R', 'C'].includes(workTreeStatus)
      const originalPath = renamed ? tokens[++index] : undefined
      entries.push({
        path,
        indexStatus,
        workTreeStatus,
        originalPath: optionalWhen(!!originalPath, originalPath),
      })
    }
    return {
      branch,
      upstream,
      ahead,
      behind,
      isClean: entries.length === 0,
      changedFiles: entries.length,
      stagedFiles: entries.filter(
        (entry) => entry.indexStatus !== ' ' && entry.indexStatus !== '?'
      ).length,
      unstagedFiles: entries.filter(
        (entry) => entry.workTreeStatus !== ' ' && entry.workTreeStatus !== '?'
      ).length,
      untrackedFiles: entries.filter(
        (entry) => entry.indexStatus === '?' && entry.workTreeStatus === '?'
      ).length,
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
      .map((record) => {
        const [
          sha = '',
          shortSha = '',
          subject = '',
          authorName = '',
          authorEmail = '',
          timestamp = '',
          refs = '',
        ] = record.split('\x1f')
        return {
          sha,
          shortSha,
          subject,
          authorName,
          authorEmail: authorEmail || null,
          authoredAt: Number(timestamp) * 1000 || 0,
          refs: refs.split(',').map((ref) => ref.trim()).filter(Boolean),
        }
      })
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

  private mergeLineStats(
    left: WorkspaceGitLineStats,
    right: WorkspaceGitLineStats
  ): WorkspaceGitLineStats {
    return {
      additions: left.additions + right.additions,
      deletions: left.deletions + right.deletions,
      changedFiles: left.changedFiles + right.changedFiles,
      binaryFiles: left.binaryFiles + right.binaryFiles,
    }
  }

  private scopeStatus(
    status: WorkspaceGitStatusResult,
    paths?: readonly string[]
  ): WorkspaceGitStatusResult {
    if (!paths?.length) return status
    const pathSet = new Set(paths)
    const entries = status.entries.filter(
      (entry) => pathSet.has(entry.path) || (!!entry.originalPath && pathSet.has(entry.originalPath))
    )
    return {
      ...status,
      entries,
      isClean: entries.length === 0,
      changedFiles: entries.length,
      stagedFiles: entries.filter(
        (entry) => entry.indexStatus !== ' ' && entry.indexStatus !== '?'
      ).length,
      unstagedFiles: entries.filter(
        (entry) => entry.workTreeStatus !== ' ' && entry.workTreeStatus !== '?'
      ).length,
      untrackedFiles: entries.filter(
        (entry) => entry.indexStatus === '?' && entry.workTreeStatus === '?'
      ).length,
    }
  }

  private createCommitMessage(status: WorkspaceGitStatusResult, locale: AppLocale): string {
    const entry = status.entries[0]
    const target =
      status.entries.length === 1
        ? entry?.path.split('/').at(-1) ?? 'workspace'
        : locale === 'zh-CN'
          ? `${status.entries.length} 个文件`
          : `${status.entries.length} files`
    const action =
      entry?.indexStatus === 'A' || entry?.indexStatus === '?'
        ? locale === 'zh-CN'
          ? '新增'
          : 'Add'
        : entry?.indexStatus === 'D'
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

  private async buildGitEnvironment(
    options: WorkspaceGitRemoteActionOptions
  ): Promise<NodeJS.ProcessEnv> {
    // git 的 porcelain 输出与错误正文都吃 locale：宿主装了中文 gettext 目录时
    // "not a git repository" 会变成「不是 Git 仓库」，把 VALIDATION 误判成 PLATFORM。
    // 解析 git 输出必须钉死 C locale，这是解析方的责任，不是用户环境的责任。
    const env: NodeJS.ProcessEnv = {
      ...(await this.readBaseEnvironment()),
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
