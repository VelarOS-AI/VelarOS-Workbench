import { readFile, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'

import { execa } from 'execa'

import { AppError } from '@velaros/core/error'
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
} from '@velaros/core/types'
import {
  getRelativePathInsideRoot,
  toPortableRelativePath,
} from '@velaros/core/utils/PathContainmentHelper'

const DefaultDiffMaxChars = 20_000
const MaxDiffChars = 1_000_000
const DefaultLogLimit = 60
const MaxLogLimit = 200
const MaxUntrackedStatBytes = 1024 * 1024
const MaxUntrackedStatFiles = 100
const CommitSubjectMaxChars = 72
const GitOutputMaxBytes = 4 * 1024 * 1024

interface GitRunOptions extends WorkspaceGitRemoteActionOptions {
  allowFailure?: boolean
}

interface GitRunResult {
  stdout: string
  stderr: string
  failed: boolean
}

const EmptyLineStats: WorkspaceGitLineStats = {
  additions: 0,
  deletions: 0,
  changedFiles: 0,
  binaryFiles: 0,
}

export class WorkbenchGitService {
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
      ? ['show', '--format=', '--patch', this.assertRevision(options.commitSha)]
      : ['diff', ...(options.staged ? ['--cached'] : [])]
    if (pathspecs.length > 0) args.push('--', ...pathspecs)
    const output = (await this.runGit(rootPath, args)).stdout
    const maxChars = Math.min(
      Math.max(options.maxChars ?? DefaultDiffMaxChars, 500),
      MaxDiffChars
    )
    return {
      rootPath,
      scope: options.commitSha ? 'commit' : options.staged ? 'staged' : 'working',
      ...(options.path ? { path: options.path } : {}),
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
    const content = (await this.runGit(rootPath, ['show', `${revision}:${relativePath}`])).stdout
    return { rootPath, content }
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
        await this.runGit(rootPath, [
          'diff',
          '--cached',
          '--numstat',
          '--',
          ...commitPaths,
        ])
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
    const args =
      action === 'fetch'
        ? ['fetch', '--prune']
        : action === 'update'
          ? ['pull', '--ff-only', '--autostash']
          : status.upstream
            ? ['push']
            : ['push', '--set-upstream', 'origin', status.branch]
    if (action === 'update' && !status.upstream)
      throw new AppError('VALIDATION', `当前分支 ${status.branch} 没有关联的远程跟踪分支。`)
    const output = (await this.runGit(rootPath, args, options)).stdout.trim()
    const remoteAction: WorkspaceGitRemoteActionResult = {
      action,
      branch: status.branch,
      upstream: status.upstream ?? (action === 'upload' ? `origin/${status.branch}` : null),
      output,
    }
    return { rootPath, action: remoteAction, summary: await this.getSummary(rootPath) }
  }

  private async getStatus(rootPath: string): Promise<WorkspaceGitStatusResult> {
    const output = (await this.runGit(rootPath, ['status', '--porcelain=v1', '--branch', '-z']))
      .stdout
    return this.parseStatus(output)
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
    const tracked = head.failed
      ? this.mergeLineStats(
          this.parseNumstat(
            (await this.runGit(rootPath, ['diff', '--cached', '--numstat', '--'])).stdout
          ),
          this.parseNumstat(
            (await this.runGit(rootPath, ['diff', '--numstat', '--'])).stdout
          )
        )
      : this.parseNumstat(
          (await this.runGit(rootPath, ['diff', '--numstat', 'HEAD', '--'])).stdout
        )
    const untrackedOutput = (
      await this.runGit(rootPath, ['ls-files', '--others', '--exclude-standard', '-z'])
    ).stdout
    const untracked = await Promise.all(
      untrackedOutput
        .split('\0')
        .filter(Boolean)
        .slice(0, MaxUntrackedStatFiles)
        .map((path) => this.getUntrackedLineStats(rootPath, path))
    )
    return untracked.reduce(
      (stats, current) => this.mergeLineStats(stats, current),
      tracked
    )
  }

  private async getUntrackedLineStats(
    rootPath: string,
    path: string
  ): Promise<WorkspaceGitLineStats> {
    try {
      const relativePath = this.normalizePathspec(rootPath, path)
      const absolutePath = resolve(rootPath, relativePath)
      const fileStat = await stat(absolutePath)
      if (!fileStat.isFile()) return { ...EmptyLineStats }
      if (fileStat.size > MaxUntrackedStatBytes)
        return { ...EmptyLineStats, changedFiles: 1, binaryFiles: 1 }
      const content = await readFile(absolutePath)
      if (content.includes(0))
        return { ...EmptyLineStats, changedFiles: 1, binaryFiles: 1 }
      const text = content.toString('utf8')
      const lines = text ? text.split(/\r\n|\r|\n/).length - (text.endsWith('\n') ? 1 : 0) : 0
      return { ...EmptyLineStats, additions: lines, changedFiles: 1 }
    } catch {
      return { ...EmptyLineStats }
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
        ...(originalPath ? { originalPath } : {}),
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

  private parseNumstat(raw: string): WorkspaceGitLineStats {
    return raw
      .split(/\r?\n/)
      .filter(Boolean)
      .reduce<WorkspaceGitLineStats>((stats, line) => {
        const [additions = '0', deletions = '0'] = line.split(/\s+/, 3)
        const binary = additions === '-' || deletions === '-'
        return {
          additions: stats.additions + (binary ? 0 : Number(additions) || 0),
          deletions: stats.deletions + (binary ? 0 : Number(deletions) || 0),
          changedFiles: stats.changedFiles + 1,
          binaryFiles: stats.binaryFiles + (binary ? 1 : 0),
        }
      }, { ...EmptyLineStats })
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
    return toPortableRelativePath(relativePath)
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
    const result = await execa('git', args, {
      cwd: rootPath,
      env: this.buildGitEnvironment(options),
      maxBuffer: GitOutputMaxBytes,
      reject: false,
    })
    const output = {
      stdout: result.stdout,
      stderr: result.stderr,
      failed: result.failed,
    }
    if (result.failed && !options.allowFailure)
      this.throwGitFailure(args, output, options.githubToken)
    return output
  }

  private throwGitFailure(
    args: string[],
    result: GitRunResult,
    githubToken?: string
  ): never {
    const output = this.redactGitOutput(
      (result.stderr || result.stdout).trim(),
      githubToken
    )
    if (output.toLowerCase().includes('not a git repository'))
      throw new AppError('VALIDATION', '当前工作区不是 Git 仓库。')
    throw new AppError(
      'PLATFORM',
      output ? `Git 命令执行失败：${output.slice(0, 500)}` : `Git 命令执行失败：git ${args[0]}`
    )
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

  private buildGitEnvironment(options: WorkspaceGitRemoteActionOptions): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0' }
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
}
