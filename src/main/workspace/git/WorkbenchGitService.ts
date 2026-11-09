import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFile, realpath, rm, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { promisify } from 'node:util'

import { execa } from 'execa'

import { type AppLocale } from '@velaros-ai/ui/conversation/contracts'
import { optionalWhen, toOptional } from '@velaros-ai/velaros/core'
import { AppError } from '@velaros-ai/velaros/core/error'

import {
  type SystemWorkspaceGitActionResult,
  type SystemWorkspaceGitBlameResult,
  type SystemWorkspaceGitCommitMessageResult,
  type SystemWorkspaceGitCommitResult,
  type SystemWorkspaceGitCreateBranchResult,
  type SystemWorkspaceGitDiffResult,
  type SystemWorkspaceGitFileActionResult,
  type SystemWorkspaceGitFileAtCommitResult,
  type SystemWorkspaceGitHunkActionResult,
  type SystemWorkspaceGitInitializeRepositoryResult,
  type SystemWorkspaceGitLineStatsSnapshot,
  type SystemWorkspaceGitLogResult,
  type SystemWorkspaceGitOperationResult,
  type SystemWorkspaceGitStashActionResult,
  type SystemWorkspaceGitStashListResult,
  type SystemWorkspaceGitStashResult,
  type SystemWorkspaceGitSummary,
  type SystemWorkspaceGitSwitchBranchResult,
  type WorkspaceGitBranch,
  type WorkspaceGitCommitResult,
  type WorkspaceGitDiffOptions,
  type WorkspaceGitFileAction,
  type WorkspaceGitFileStatusEntry,
  type WorkspaceGitLineStats,
  type WorkspaceGitLogEntry,
  type WorkspaceGitLogOptions,
  type WorkspaceGitRemoteAction,
  type WorkspaceGitRemoteActionResult,
  type WorkspaceGitStatusResult,
} from '@shared/contracts/system'
import {
  type WorkspaceGitDetachedHead,
  type WorkspaceGitHunkActionOptions,
  type WorkspaceGitOperationRequest,
  type WorkspaceGitRef,
  type WorkspaceGitRemoteActionOptions,
  type WorkspaceGitStashAction,
  type WorkspaceGitStashOptions,
} from '@shared/contracts/workspaceGit'
import {
  hasWorkspaceGitConflictMarkers,
  isWorkspaceGitConflictEntry,
  type WorkbenchGitBlameRequest,
} from '@shared/workbenchGit'
import { parseWorkbenchGitBlame } from '@shared/workbenchGitBlame'
import {
  buildWorkbenchGitHunkPatch,
  isSameWorkbenchGitHunk,
  isWorkbenchGitWholeFilePatch,
  parseWorkbenchGitFilePatches,
  type WorkbenchGitPatchHunk,
} from '@shared/workbenchGitPatch'
import { DefaultWorkbenchTextFormat, type WorkbenchTextFormat } from '@shared/workbenchTextFormat'

import {
  type WorkbenchMainMessageKey,
  workbenchMainText,
  workbenchMainTextIn,
} from '../../i18n/workbenchMainMessages'
import { getRelativePathInsideRoot, toPortableRelativePath } from '../PathContainmentHelper'
import { listWorkbenchProcessTree, signalWorkbenchProcesses } from '../terminal/WorkbenchProcessTree'
import { decodeWorkbenchTextContent, encodeWorkbenchText } from '../TextCodec'

import type {
  GitRepository,
  GitRunOptions,
  GitRunResult,
  WorkbenchGitAccess,
} from './WorkbenchGitAccess'
import { WorkbenchGitOperationLabels, WorkbenchGitOperations } from './WorkbenchGitOperations'
import { WorkbenchGitStashes } from './WorkbenchGitStashes'

const DefaultDiffMaxChars = 20_000
const MaxDiffChars = 1_000_000
const DefaultLogLimit = 60
/**
 * 一次最多读这么多个提交。提交图一页一页往下读（每页几百个），仓库有了新提交时要把已经读过的那一段
 * 整个重读一遍，所以上限给到整段的长度。
 */
const MaxLogLimit = 10_000
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
/**
 * 连远端的命令（获取、拉取、推送）这么久没有任何输出就算卡住了，结束它：网络断在半路、远端不再应答时不
 * 一直挂着。只看有没有动静，不限总时长——仓库大、网络慢的传输要多久都行，git 的进度（`--progress`）就是动静。
 * 给得宽：推送之后远端跑钩子可以好一阵不出声，用户等不及还能自己取消。
 */
const RemoteInactivityTimeoutMs = 5 * 60_000
/** 结束 git 进程时先发 SIGTERM（git 会收拾掉自己的锁文件），这么久还没退出再强杀。 */
const GitTerminateGraceMs = 2_000
/**
 * git 的进度行：`Receiving objects:  45% (450/1000)`、`remote: Counting objects: 100% (5/5), done.`、
 * `Total 3 (delta 0), reused 0`……加了 `--progress` 才有，给用户看的说明里不要它们。
 */
const GitProgressLinePattern =
  /^(?:remote: )?(?:(?:Enumerating|Counting|Compressing|Receiving|Resolving|Writing|Unpacking|Updating|Checking out|Filtering) \w+:|Delta compression using |Total \d+ \(delta )/u
/** 标记冲突已解决前检查冲突标记，最多读这么大的文件；更大的不查。 */
const MaxConflictMarkerScanBytes = 16 * 1024 * 1024
/** 日志的每个提交以 \x1e 开头，字段之间是 \x1f；最后两个字段是父提交（空格隔开）和指着它的引用。 */
const LogFormat = '--format=%x1e%H%x1f%h%x1f%s%x1f%an%x1f%ae%x1f%ct%x1f%P%x1f%D'
/** git 的输出按 UTF-8 读，读不懂的字节变成它。 */
const ReplacementCharacter = String.fromCodePoint(0xfffd)

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

/** 「不是 Git 仓库」：调用方据此把项目当作还没初始化 Git，而不是出错（按类型认，不看提示文字）。 */
class WorkbenchGitNotRepositoryError extends AppError {
  constructor() {
    super('VALIDATION', workbenchMainText('git.notRepository'))
  }
}

/** 被中途结束的原因：`inactive` 太久没动静，`cancelled` 用户取消。 */
type GitStopReason = 'inactive' | 'cancelled'

/** 连远端的命令：凭据设置，加上取消它的信号。 */
type RemoteCommandOptions = WorkspaceGitRemoteActionOptions & Pick<GitRunOptions, 'signal'>

/** 能被中途结束的 git 子进程，只用得到这几样。 */
interface StoppableGitProcess {
  pid?: number
  stdout?: Nullable<NodeJS.ReadableStream>
  stderr?: Nullable<NodeJS.ReadableStream>
  kill: (signal: NodeJS.Signals) => boolean
  then: (onSettled: () => void, onFailed: () => void) => unknown
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
  /** 连远端的命令多久没动静算卡住，默认 RemoteInactivityTimeoutMs。 */
  remoteInactivityTimeoutMs?: number
}

export class WorkbenchGitService {
  private readonly readEnvironment: () => Promise<NodeJS.ProcessEnv>
  private readonly remoteInactivityTimeoutMs: number
  /** 正在跑的远端操作（发起方给了编号的）：凭编号取消。 */
  private readonly remoteOperations = new Map<string, AbortController>()

  /** 交给各功能模块的内部能力：它们跑的 git 与这里同一套环境、输出配置和报错口径。 */
  private readonly access: WorkbenchGitAccess = {
    run: (rootPath, args, options) => this.runGit(rootPath, args, options),
    resolveRoot: (workspaceRoot) => this.resolveRoot(workspaceRoot),
    openRepository: (rootPath) => this.openRepository(rootPath),
    getStatus: (repository) => this.getStatus(repository),
    getSummary: (workspaceRoot) => this.getSummary(workspaceRoot),
    readOutput: (result) => this.readableGitOutput(result),
    fail: (args, result) => this.throwGitFailure(args, result),
    getEmptyTree: (rootPath) => this.getEmptyTree(rootPath),
    toProjectPath: (prefix, repositoryPath) => this.toProjectPath(prefix, repositoryPath),
    describePaths: (entries) => this.describePaths(entries),
    readOperationInProgress: async (repository) => {
      const operation = await this.operations.readState(repository)
      return operation ? WorkbenchGitOperationLabels[operation.kind] : null
    },
    assertRevision: (revision) => this.assertRevision(revision),
  }
  private readonly operations = new WorkbenchGitOperations(this.access)
  private readonly stashes = new WorkbenchGitStashes(this.access)

  constructor(options: WorkbenchGitServiceOptions = {}) {
    this.readEnvironment = options.environment ?? (() => Promise.resolve(process.env))
    this.remoteInactivityTimeoutMs = options.remoteInactivityTimeoutMs ?? RemoteInactivityTimeoutMs
  }

  /** 仓库里的贮藏，最新的在前。 */
  public listStashes(workspaceRoot: string): Promise<SystemWorkspaceGitStashListResult> {
    return this.stashes.list(workspaceRoot)
  }

  /** 贮藏项目里没提交的改动，见 {@link WorkbenchGitStashes}。 */
  public stash(
    workspaceRoot: string,
    options: WorkspaceGitStashOptions = {}
  ): Promise<SystemWorkspaceGitStashResult> {
    return this.stashes.stash(workspaceRoot, options)
  }

  /** 取回（`apply` 留着贮藏、`pop` 取回后删掉）或删掉（`drop`）一条贮藏，凭贮藏提交的对象名。 */
  public performStashAction(
    workspaceRoot: string,
    sha: string,
    action: WorkspaceGitStashAction
  ): Promise<SystemWorkspaceGitStashActionResult> {
    return this.stashes.performAction(workspaceRoot, sha, action)
  }

  /**
   * 合并、变基、拣选、撤销，以及进行到一半之后的继续、放弃、跳过，见 {@link WorkbenchGitOperations}。
   * 停在冲突上不算失败：冲突文件列在结果里，摘要里的 `operation` 说明停在哪个操作上。
   */
  public performOperation(
    workspaceRoot: string,
    request: WorkspaceGitOperationRequest
  ): Promise<SystemWorkspaceGitOperationResult> {
    return this.operations.perform(workspaceRoot, request)
  }

  public async getSummary(workspaceRoot: string): Promise<SystemWorkspaceGitSummary> {
    const rootPath = await this.resolveRoot(workspaceRoot)
    try {
      const repository = await this.openRepository(rootPath)
      const [status, branches, lineStats, operation] = await Promise.all([
        this.getStatus(repository),
        this.listBranches(rootPath),
        this.getLineStatsForRoot(repository),
        this.operations.readState(repository),
      ])
      return {
        rootPath,
        repository: true,
        checkedAt: Date.now(),
        status,
        branches,
        lineStats,
        operation,
      }
    } catch (error) {
      if (this.isNotRepositoryError(error)) return this.emptySummary(rootPath)
      throw error
    }
  }

  public async getLineStats(workspaceRoot: string): Promise<SystemWorkspaceGitLineStatsSnapshot> {
    const rootPath = await this.resolveRoot(workspaceRoot)
    try {
      const repository = await this.openRepository(rootPath)
      const [lineStats, branch] = await Promise.all([
        this.getLineStatsForRoot(repository),
        this.getCurrentBranch(rootPath),
      ])
      return {
        rootPath,
        repository: true,
        checkedAt: Date.now(),
        lineStats,
        branch,
        detachedHead: branch ? null : await this.readDetachedHead(rootPath),
      }
    } catch (error) {
      if (this.isNotRepositoryError(error))
        return {
          rootPath,
          repository: false,
          checkedAt: Date.now(),
          lineStats: { ...EmptyLineStats },
          branch: null,
          detachedHead: null,
        }
      throw error
    }
  }

  public async getDiff(
    workspaceRoot: string,
    options: WorkspaceGitDiffOptions = {}
  ): Promise<SystemWorkspaceGitDiffResult> {
    const rootPath = await this.resolveRoot(workspaceRoot)
    const paths = this.normalizePathspecs(rootPath, [options.originalPath, options.path])
    const output = options.commitSha
      ? (
          await this.runGit(rootPath, [
            'show',
            '--format=',
            '--patch',
            '--no-ext-diff',
            '--no-color',
            this.assertRevision(options.commitSha),
            ...(paths.length > 0
              ? ['--', ...paths.map((path) => this.toLiteralPathspec(path))]
              : []),
          ])
        ).stdout
      : options.stashSha
        ? await this.stashes.readDiff(
            rootPath,
            options.stashSha,
            paths.map((path) => this.toLiteralPathspec(path))
          )
        : await this.readWorkingDiff(rootPath, options.side, paths)
    const maxChars = Math.min(Math.max(options.maxChars ?? DefaultDiffMaxChars, 500), MaxDiffChars)
    return {
      rootPath,
      scope: options.commitSha
        ? 'commit'
        : options.stashSha
          ? 'stash'
          : (options.side ?? 'working'),
      path: optionalWhen(!!options.path, options.path),
      diff: output.slice(0, maxChars),
      truncated: output.length > maxChars,
    }
  }

  /**
   * 没提交的改动的补丁，路径相对项目根，项目外面的改动不列（`--relative`）。`staged`：暂存区相对 HEAD（还没有
   * 提交时相对空树）；`unstaged`：工作区相对暂存区；都不是：工作区相对 HEAD。
   */
  private async readWorkingDiff(
    rootPath: string,
    side: WorkspaceGitDiffOptions['side'],
    paths: readonly string[]
  ): Promise<string> {
    const args = [
      'diff',
      '--no-ext-diff',
      '--no-color',
      '--no-textconv',
      '--find-renames',
      '--relative',
    ]
    if (side === 'staged') args.push('--cached', await this.resolveDiffBase(rootPath))
    else if (side !== 'unstaged') args.push(await this.resolveDiffBase(rootPath))
    if (paths.length > 0) args.push('--', ...paths.map((path) => this.toLiteralPathspec(path)))
    // 末尾的换行留着：编辑区按块操作时拿回来的块，要跟这里重读的一模一样。
    return (await this.runGit(rootPath, args, { keepFinalNewline: true })).stdout
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

  /**
   * 每一行最后是哪个提交改的（`git blame`）。给了 `content` 就按这份正文算（编辑器里还没保存的内容也对得上行），
   * 正文先按文件自己的编码与换行符编码再交给 git，CRLF、GBK 文件才不会整篇都算成改过；没给就按磁盘上的文件。
   * 文件还没纳入版本管理、仓库还没有提交时一行都没有。
   */
  public async getBlame(
    workspaceRoot: string,
    options: Omit<WorkbenchGitBlameRequest, 'workspaceRoot'>
  ): Promise<SystemWorkspaceGitBlameResult> {
    const rootPath = await this.resolveRoot(workspaceRoot)
    const path = this.normalizePathspec(rootPath, options.path)
    const args = ['blame', '--incremental']
    let input: Uint8Array | undefined
    if (options.content !== undefined) {
      input = this.encodeBlameContents(options.content, {
        encoding: options.encoding ?? DefaultWorkbenchTextFormat.encoding,
        eol: options.eol ?? DefaultWorkbenchTextFormat.eol,
      })
      args.push('--contents', '-')
    }
    args.push('--', path)
    const result = await this.runGit(rootPath, args, { allowFailure: true, input })
    if (result.failed) {
      const output = this.readableGitOutput(result)
      if (/no such path|no such ref|does not have any commits|bad revision 'HEAD'/i.test(output))
        return { rootPath, commits: [], lines: [] }
      this.throwGitFailure(args, result)
    }
    return { rootPath, ...parseWorkbenchGitBlame(result.stdout) }
  }

  /** 正文里有这种编码写不出的字符（保存时也会被拦下）时按 UTF-8 给 git：那些行本来也算没提交的改动。 */
  private encodeBlameContents(content: string, format: WorkbenchTextFormat): Uint8Array {
    try {
      return encodeWorkbenchText(content, format)
    } catch {
      // arch-guard:silent-catch-ok 见上：编码不了就退回 UTF-8，不让追溯整个失败。
      return encodeWorkbenchText(content, { encoding: 'utf-8', eol: format.eol })
    }
  }

  public async getLog(
    workspaceRoot: string,
    options: WorkspaceGitLogOptions = {}
  ): Promise<SystemWorkspaceGitLogResult> {
    const rootPath = await this.resolveRoot(workspaceRoot)
    const limit = Math.min(Math.max(Math.floor(options.limit ?? DefaultLogLimit), 1), MaxLogLimit)
    const skip = Math.max(Math.floor(options.skip ?? 0), 0)
    // 多要一个：要到了就是后面还有。`--date-order`：子提交一定排在父提交前面（提交图靠这个顺序），
    // 其余按时间。`--decorate=full`：引用写全名，分得清分支、远端分支和标签。
    const args = [
      'log',
      `--max-count=${limit + 1}`,
      `--skip=${skip}`,
      '--date-order',
      '--no-color',
      '--decorate=full',
      LogFormat,
    ]
    if (options.branch) args.push(this.assertRevision(options.branch))
    else if (!options.path) {
      // 全部本地分支和远端分支。不用 `--all`：它连贮藏、AI 改动的影子检查点这些内部引用也算上。
      args.push('--branches', '--remotes')
      // 分离的 HEAD 可能停在哪个分支都到不了的提交上；还没有提交时 HEAD 解析不出来，不能带。
      if (await this.readHeadCommit(rootPath)) args.push('HEAD')
    }
    let file: Nullable<{ path: string; prefix: string }> = null
    if (options.path) {
      file = {
        path: this.normalizePathspec(rootPath, options.path),
        prefix: (await this.openRepository(rootPath)).prefix,
      }
      // 跟着改名往回找，并列出每个提交里这个文件叫什么：改名之前的提交要按旧路径读内容。
      args.push('--follow', '--name-status', '-z', '--', this.toLiteralPathspec(file.path))
    }

    const result = await this.runGit(rootPath, args, {
      allowFailure: true,
      maxBuffer: GitListingMaxBytes,
    })
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
    return {
      rootPath,
      checkedAt: Date.now(),
      commits: commits.slice(0, limit),
      hasMore: commits.length > limit,
    }
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
    if (selection.isClean)
      throw new AppError('VALIDATION', workbenchMainText('git.nothingSelectedToCommit'))
    const operation = await this.readOperationToCommit(repository)
    if (operation && selection.changedFiles < status.changedFiles)
      throw new AppError(
        'VALIDATION',
        workbenchMainText('git.partialCommitDuringOperation', {
          operation: workbenchMainText(operation),
        })
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
      throw new AppError('VALIDATION', workbenchMainText('git.nothingStaged'))

    const parent = await this.readHeadCommit(rootPath)
    let commitMessage: Nullable<string> = message?.trim() || null
    if (await this.readOperationToCommit(repository)) {
      // 合并、拣选、撤销只能整个暂存区一起提交；没写说明就用 git 备好的那条。
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
    const commitSha = (await this.runGit(rootPath, ['rev-parse', '--verify', 'HEAD'])).stdout.trim()
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
    if (relativePaths.length === 0)
      throw new AppError('VALIDATION', workbenchMainText('git.noFilesGiven'))
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
        throw new AppError(
          'VALIDATION',
          workbenchMainText('git.noConflictToResolve', { path: unresolvable })
        )
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
          workbenchMainText(
            action === 'discard' ? 'git.conflictsBlockDiscard' : 'git.conflictsBlockUnstage',
            { paths: this.describePaths(conflicts) }
          )
        )
      if (action === 'unstage')
        await this.unstage(
          rootPath,
          this.entryPaths(entries.filter((entry) => this.isStagedEntry(entry)))
        )
      else for (const entry of entries) await this.discard(repository, entry)
    } else {
      throw new AppError('VALIDATION', workbenchMainText('git.unsupportedFileAction'))
    }

    const status = await this.getStatus(repository)
    return {
      rootPath,
      fileAction: { action, paths: relativePaths, status },
      summary: await this.getSummary(rootPath),
    }
  }

  /**
   * 按块暂存、取消暂存、回滚。要的块从这一侧的补丁里重新读出来（暂存、回滚看工作区相对暂存区，取消暂存看暂存区
   * 相对 HEAD），一块块原样认，认出来的拼成只改这个文件内容的补丁交给 `git apply`；认不出（显示之后文件又
   * 变了）就拒绝，不拿显示的内容去猜。
   */
  public async applyHunks(
    workspaceRoot: string,
    options: WorkspaceGitHunkActionOptions
  ): Promise<SystemWorkspaceGitHunkActionResult> {
    const rootPath = await this.resolveRoot(workspaceRoot)
    const repository = await this.openRepository(rootPath)
    const path = this.normalizePathspec(rootPath, options.path)
    if (options.hunks.length === 0)
      throw new AppError('VALIDATION', workbenchMainText('git.noHunksGiven'))
    const entry = (await this.getStatus(repository)).entries.find(
      (candidate) => candidate.path === path
    )
    if (!entry)
      throw new AppError('VALIDATION', workbenchMainText('git.fileHasNoChanges', { path }))
    if (isWorkspaceGitConflictEntry(entry))
      throw new AppError('VALIDATION', workbenchMainText('git.hunkConflict', { path }))

    const side = options.action === 'unstage' ? 'staged' : 'unstaged'
    const diff = await this.readWorkingDiff(
      rootPath,
      side,
      side === 'staged'
        ? this.normalizePathspecs(rootPath, [options.originalPath, options.path])
        : [path]
    )
    const patches = parseWorkbenchGitFilePatches(diff)
    const [patch] = patches
    if (!patch || patches.length > 1) throw this.hunksChangedError(path)
    if (isWorkbenchGitWholeFilePatch(patch))
      throw new AppError('VALIDATION', workbenchMainText('git.hunkWholeFileOnly', { path }))
    // 输出里有替换字符：文件不是 UTF-8，照读到的文字拼回补丁会改坏内容。
    if (diff.includes(ReplacementCharacter))
      throw new AppError('VALIDATION', workbenchMainText('git.hunkNotUtf8', { path }))
    const hunks = options.hunks.map((selector) =>
      patch.hunks.find((hunk) => isSameWorkbenchGitHunk(hunk, selector))
    )
    if (hunks.some((hunk) => !hunk)) throw this.hunksChangedError(path)

    const args =
      options.action === 'stage'
        ? ['apply', '--cached', '--whitespace=nowarn', '-']
        : options.action === 'unstage'
          ? ['apply', '--cached', '--reverse', '--whitespace=nowarn', '-']
          : ['apply', '--reverse', '--whitespace=nowarn', '-']
    const result = await this.runGit(rootPath, args, {
      allowFailure: true,
      input: buildWorkbenchGitHunkPatch(
        `${repository.prefix}${path}`,
        hunks.filter((hunk): hunk is WorkbenchGitPatchHunk => !!hunk)
      ),
    })
    if (result.failed) {
      const output = this.readableGitOutput(result)
      if (/patch does not apply|patch failed/i.test(output)) throw this.hunksChangedError(path)
      this.throwGitFailure(args, result)
    }
    return { rootPath, summary: await this.getSummary(rootPath) }
  }

  private hunksChangedError(path: string): AppError {
    return new AppError('VALIDATION', workbenchMainText('git.hunkChanged', { path }))
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
    const args = options.create ? ['switch', '--create', targetBranch] : ['switch', targetBranch]
    if (options.create && options.startPoint) args.push(this.assertRevision(options.startPoint))
    const result = await this.runGit(rootPath, args, { allowFailure: true })
    if (result.failed) {
      const output = this.readableGitOutput(result)
      if (/would be overwritten|untracked working tree files/i.test(output))
        throw new AppError(
          'VALIDATION',
          workbenchMainText('git.switchRefused', { output: output.slice(0, 800) })
        )
      this.throwGitFailure(args, result)
    }
    return {
      rootPath,
      previousBranch,
      branch: targetBranch,
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

  /**
   * 获取、拉取、同步（先拉取再推送）、推送。连远端的每条命令太久没动静（RemoteInactivityTimeoutMs）就结束，
   * 只要还有进度就不限时；给了 `operationId` 的还能中途取消（{@link cancelRemoteAction}）。失败时把 git 的话
   * 换成能看懂的说明（凭据、网络、分叉、本地改动会被覆盖……）。拉取合入时冲突了不算失败：冲突文件列在结果里，
   * 合并或变基停在那里等用户解决，同步这时不推送。
   */
  public async performRemoteAction(
    workspaceRoot: string,
    action: WorkspaceGitRemoteAction,
    options: WorkspaceGitRemoteActionOptions = {}
  ): Promise<SystemWorkspaceGitActionResult> {
    const controller = new AbortController()
    const operationId = options.operationId
    if (operationId) this.remoteOperations.set(operationId, controller)
    try {
      return await this.runRemoteAction(workspaceRoot, action, options, controller.signal)
    } finally {
      if (operationId && this.remoteOperations.get(operationId) === controller)
        this.remoteOperations.delete(operationId)
    }
  }

  /**
   * 取消一个正在跑的远端操作：结束它的 git 进程（连同 ssh），那次 {@link performRemoteAction} 以「已取消」
   * 收场。没有这个编号的操作（已经结束、没开始过）时返回 false。
   */
  public cancelRemoteAction(operationId: string): boolean {
    const controller = this.remoteOperations.get(operationId)
    if (!controller) return false
    controller.abort()
    return true
  }

  private async runRemoteAction(
    workspaceRoot: string,
    action: WorkspaceGitRemoteAction,
    options: WorkspaceGitRemoteActionOptions,
    signal: AbortSignal
  ): Promise<SystemWorkspaceGitActionResult> {
    const rootPath = await this.resolveRoot(workspaceRoot)
    const currentBranch = await this.getCurrentBranch(rootPath)
    const actionBranch =
      action === 'upload' && options.branch ? this.assertBranch(options.branch) : currentBranch
    // `--progress`：输出不是终端时 git 默认不报进度；报了才知道这条命令还在动。
    const remote: RemoteCommandOptions = { ...options, signal }
    const result: WorkspaceGitRemoteActionResult = {
      action,
      branch: actionBranch,
      upstream: null,
      output: '',
      conflicts: [],
      rebasing: false,
    }
    // 获取远端不看分支，分离的 HEAD 上也能做。
    if (action === 'fetch') {
      result.upstream = actionBranch
        ? ((await this.getBranchUpstream(rootPath, actionBranch))?.name ?? null)
        : null
      result.output = await this.runRemoteCommand(
        rootPath,
        action,
        ['fetch', '--prune', '--progress'],
        remote
      )
      return { rootPath, action: result, summary: await this.getSummary(rootPath) }
    }

    // 拉取、同步、推送都要落在一个分支上：分离的 HEAD 上没有当前分支，推送得点名一个分支。
    if (!actionBranch) throw new AppError('VALIDATION', workbenchMainText('git.noLocalBranch'))
    if (actionBranch !== currentBranch) {
      const exists = await this.runGit(
        rootPath,
        ['rev-parse', '-q', '--verify', `refs/heads/${actionBranch}`],
        { allowFailure: true }
      )
      if (exists.failed)
        throw new AppError(
          'VALIDATION',
          workbenchMainText('git.branchMissing', { branch: actionBranch })
        )
    }
    const upstream = await this.getBranchUpstream(rootPath, actionBranch)
    result.upstream = upstream?.name ?? null

    if (action === 'pull' || action === 'sync') {
      if (!upstream)
        throw new AppError(
          'VALIDATION',
          workbenchMainText(action === 'pull' ? 'git.noUpstreamPull' : 'git.noUpstreamSync', {
            branch: actionBranch,
          })
        )
      const pulled = await this.pullBranch(rootPath, actionBranch, remote)
      Object.assign(result, pulled)
      if (action === 'sync' && pulled.conflicts.length === 0) {
        const pushed = await this.runRemoteCommand(
          rootPath,
          action,
          [
            'push',
            '--progress',
            upstream.remote,
            `refs/heads/${actionBranch}:${upstream.remoteRef}`,
          ],
          remote
        )
        result.output = [pulled.output, pushed].filter(Boolean).join('\n')
      }
    } else if (upstream) {
      result.output = await this.runRemoteCommand(
        rootPath,
        action,
        ['push', '--progress', upstream.remote, `refs/heads/${actionBranch}:${upstream.remoteRef}`],
        remote
      )
    } else {
      const pushRemote = await this.resolvePushRemote(rootPath, actionBranch)
      result.output = await this.runRemoteCommand(
        rootPath,
        action,
        [
          'push',
          '--progress',
          '--set-upstream',
          pushRemote,
          `refs/heads/${actionBranch}:refs/heads/${actionBranch}`,
        ],
        remote
      )
      result.upstream = `${pushRemote}/${actionBranch}`
    }
    return { rootPath, action: result, summary: await this.getSummary(rootPath) }
  }

  /**
   * 拉取当前分支的上游。没配置过怎么合（`branch.<分支>.rebase`、`pull.rebase`、`pull.ff`）时合并
   * （`--no-rebase`），配置了就不加参数，照用户的配置来：给了 `--no-rebase` 连 `pull.ff=only` 也会被盖掉。
   * 合并说明不开编辑器，交互式变基按默认的步骤走。
   */
  private async pullBranch(
    rootPath: string,
    branch: string,
    options: RemoteCommandOptions
  ): Promise<Pick<WorkspaceGitRemoteActionResult, 'output' | 'conflicts' | 'rebasing'>> {
    const configured = await Promise.all(
      [`branch.${branch}.rebase`, 'pull.rebase', 'pull.ff'].map((key) =>
        this.readConfig(rootPath, key)
      )
    )
    const args = configured.some(Boolean)
      ? ['pull', '--progress']
      : ['pull', '--progress', '--no-rebase']
    const run = await this.runGit(rootPath, args, {
      ...options,
      allowFailure: true,
      inactivityTimeoutMs: this.remoteInactivityTimeoutMs,
      env: { GIT_MERGE_AUTOEDIT: 'no', GIT_EDITOR: ':', GIT_SEQUENCE_EDITOR: ':' },
    })
    const output = this.withoutProgressLines(`${run.stdout}\n${run.stderr}`)
    if (!run.failed) return { output, conflicts: [], rebasing: false }

    // 这次合入冲突了（git 报了 CONFLICT）：不当失败，把冲突文件交给提交面板的「合并冲突」。
    if (/^CONFLICT \(|could not apply/im.test(output)) {
      const repository = await this.openRepository(rootPath)
      const conflicts = (await this.getStatus(repository)).entries
        .filter((entry) => isWorkspaceGitConflictEntry(entry))
        .map((entry) => entry.path)
      if (conflicts.length > 0)
        return {
          output,
          conflicts,
          rebasing: (await this.operations.readState(repository))?.kind === 'rebase',
        }
    }
    throw this.describeRemoteFailure('pull', run, options.githubToken)
  }

  /** 跑一条连远端的命令（太久没动静就结束，能取消），失败时换成能看懂的说明。 */
  private async runRemoteCommand(
    rootPath: string,
    action: WorkspaceGitRemoteAction,
    args: string[],
    options: RemoteCommandOptions
  ): Promise<string> {
    const run = await this.runGit(rootPath, args, {
      ...options,
      allowFailure: true,
      inactivityTimeoutMs: this.remoteInactivityTimeoutMs,
    })
    if (run.failed) throw this.describeRemoteFailure(action, run, options.githubToken)
    return this.withoutProgressLines(this.readableGitOutput(run))
  }

  /**
   * 去掉 git 的进度行。进度在终端里是原地刷新的（`\r`），收下来是一长串：每行只留最后刷出来的那一截，
   * 再把进度行整行去掉，剩下的才是 git 真正说的话。
   */
  private withoutProgressLines(output: string): string {
    return output
      .split(/\r?\n/u)
      .map((line) => line.slice(line.lastIndexOf('\r') + 1))
      .filter((line) => !GitProgressLinePattern.test(line))
      .join('\n')
      .trim()
  }

  /** 连远端失败时的说明：认得出的情况说清楚怎么办，认不出的照 git 的原话。 */
  private describeRemoteFailure(
    action: WorkspaceGitRemoteAction,
    run: GitRunResult,
    githubToken?: string
  ): AppError {
    const output = this.redactGitOutput(`${run.stderr}\n${run.stdout}`.trim(), githubToken)
    const detail = this.redactGitOutput(
      this.withoutProgressLines(this.readableGitOutput(run)),
      githubToken
    ).slice(0, 500)
    if (
      /permission denied \(publickey|authentication failed|could not read (?:username|password)|terminal prompts disabled|invalid username or password|access denied|returned error: 40[13]/i.test(
        output
      )
    )
      return new AppError('PERMISSION', workbenchMainText('git.authFailed', { detail }))
    if (
      /could not resolve host|failed to connect|connection (?:timed out|refused|reset)|network is unreachable|operation timed out|could not read from remote repository/i.test(
        output
      )
    )
      return new AppError('NETWORK', workbenchMainText('git.networkFailed', { detail }))
    if (/\[rejected\]|non-fast-forward|\(fetch first\)|updates were rejected/i.test(output))
      return new AppError('VALIDATION', workbenchMainText('git.pushRejected'))
    if (/not possible to fast-forward|diverging branches can't be fast-forwarded/i.test(output))
      return new AppError('VALIDATION', workbenchMainText('git.pullDiverged'))
    const overwritten = /would be overwritten by (?:merge|checkout)/i.test(output)
    if (overwritten) {
      const files = output
        .split('\n')
        .filter((line) => line.startsWith('\t'))
        .map((line) => line.trim())
        .slice(0, 5)
      return new AppError(
        'VALIDATION',
        files.length
          ? workbenchMainText('git.pullWouldOverwriteFiles', {
              files: files.join(workbenchMainText('git.listSeparator')),
            })
          : workbenchMainText('git.pullWouldOverwrite')
      )
    }
    if (/cannot (?:pull with rebase|rebase)|your index contains uncommitted changes/i.test(output))
      return new AppError('VALIDATION', workbenchMainText('git.rebasePullDirty'))
    if (/unmerged files|not concluded your merge|merge_head exists/i.test(output))
      return new AppError('VALIDATION', workbenchMainText('git.mergeUnfinished'))
    return new AppError(
      'PLATFORM',
      detail
        ? workbenchMainText('git.commandFailedDetail', { detail })
        : workbenchMainText('git.commandFailed', { command: action === 'upload' ? 'push' : action })
    )
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
    if (remotes.length === 0) throw new AppError('VALIDATION', workbenchMainText('git.noRemote'))
    throw new AppError(
      'VALIDATION',
      workbenchMainText('git.ambiguousRemote', {
        count: remotes.length,
        remotes: remotes.join(workbenchMainText('git.listSeparator')),
        branch,
      })
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
      workbenchMainText('git.statusTooLarge', { size: GitListingMaxBytes / 1024 / 1024 })
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
    if (result.truncated) return null
    const status = this.parseStatus(result.stdout, repository.prefix)
    // 状态头只说「HEAD (no branch)」，不说停在哪个提交上：分离的 HEAD 另问一句。
    if (!status.branch) status.detachedHead = await this.readDetachedHead(repository.rootPath)
    return status
  }

  /** 分离的 HEAD 指着的提交；HEAD 还没有提交可指（刚初始化的仓库）时为 null。 */
  private async readDetachedHead(rootPath: string): Promise<Nullable<WorkspaceGitDetachedHead>> {
    const result = await this.runGit(rootPath, ['log', '-1', '--format=%H%x1f%h', 'HEAD'], {
      allowFailure: true,
    })
    const [sha = '', shortSha = ''] = result.stdout.trim().split('\x1f')
    return !result.failed && sha && shortSha ? { sha, shortSha } : null
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

  /**
   * 进行到一半、这次提交要一并完成的操作（合并、拣选、撤销）在文案表里的名字：进行中时 git 不许只提交
   * 一部分文件，提交就是把它做完。没有为 null；变基不在这里，变基中不提交（见 readCommittableStatus）。
   */
  private async readOperationToCommit(
    repository: GitRepository
  ): Promise<Nullable<WorkbenchMainMessageKey>> {
    const operation = await this.operations.readState(repository)
    return operation && operation.kind !== 'rebase'
      ? WorkbenchGitOperationLabels[operation.kind]
      : null
  }

  /** 要提交时的项目状态：没有改动、还有没解决的冲突、正在变基时拒绝。 */
  private async readCommittableStatus(
    repository: GitRepository
  ): Promise<WorkspaceGitStatusResult> {
    // 变基停在冲突处时提交会把这一步的改动提交到分离的 HEAD 上，打乱变基；要用「继续」接着变基，或者放弃它。
    if ((await this.operations.readState(repository))?.kind === 'rebase')
      throw new AppError('VALIDATION', workbenchMainText('git.rebaseInProgress'))
    const status = await this.getStatus(repository)
    if (status.isClean) throw new AppError('VALIDATION', workbenchMainText('git.nothingToCommit'))
    const conflicts = status.entries.filter((entry) => isWorkspaceGitConflictEntry(entry))
    if (conflicts.length > 0)
      throw new AppError(
        'VALIDATION',
        workbenchMainText('git.conflictsBlockCommit', { paths: this.describePaths(conflicts) })
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
    const kept = new Set(
      staged.filter((change) => change.status !== 'D').map((change) => change.path)
    )
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
    if (!topLevel || !gitDirectory)
      throw new AppError('PLATFORM', workbenchMainText('git.repositoryLocationUnknown'))
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
      await this.runGit(rootPath, ['diff', '--cached', '--name-only', '-z', '--no-renames', base], {
        maxBuffer: GitListingMaxBytes,
      })
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
      throw new AppError('VALIDATION', workbenchMainText('git.nothingSelectedToCommit'))
    this.throwGitFailure(args, result)
  }

  private async unstage(rootPath: string, paths: readonly string[]): Promise<void> {
    if (paths.length === 0) return
    const args = (await this.readHeadCommit(rootPath))
      ? ['restore', '--staged']
      : ['rm', '--cached', '--ignore-unmatch']
    await this.runGit(rootPath, [...args, '--pathspec-from-file=-', '--pathspec-file-nul'], {
      input: paths.map((path) => this.toLiteralPathspec(path)).join('\0'),
    })
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
        workbenchMainText('git.conflictMarkersLeft', { path: entry.path })
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
    return hasWorkspaceGitConflictMarkers(content.toString('utf8'))
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
        originalPath: toOptional(originalToken ? this.toProjectPath(prefix, originalToken) : null),
      })
    }
    return this.summarizeStatus(branchInfo, entries)
  }

  private summarizeStatus(
    branchInfo: Pick<
      WorkspaceGitStatusResult,
      'branch' | 'detachedHead' | 'upstream' | 'ahead' | 'behind'
    >,
    entries: WorkspaceGitFileStatusEntry[]
  ): WorkspaceGitStatusResult {
    const settled = entries.filter((entry) => !isWorkspaceGitConflictEntry(entry))
    return {
      ...branchInfo,
      isClean: entries.length === 0,
      changedFiles: entries.length,
      stagedFiles: settled.filter((entry) => entry.indexStatus !== ' ' && entry.indexStatus !== '?')
        .length,
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

  /**
   * 状态头（`## main...origin/main [ahead 1]`）。分离的 HEAD 是 `HEAD (no branch)`：分支为 null，它指着的
   * 提交由 {@link readStatus} 另外读出来补上。
   */
  private parseBranchHeader(
    raw: string
  ): Pick<WorkspaceGitStatusResult, 'branch' | 'detachedHead' | 'upstream' | 'ahead' | 'behind'> {
    const normalized = raw.replace(/^No commits yet on /i, '').replace(/^Initial commit on /i, '')
    const [branchPart = '', meta = ''] = normalized.split(' [', 2)
    const [branchName = '', upstream = ''] = branchPart.split('...', 2)
    return {
      branch: branchName && !branchName.startsWith('HEAD ') ? branchName : null,
      detachedHead: null,
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
  private parseFileLog(raw: string, prefix: string, currentPath: string): WorkspaceGitLogEntry[] {
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
      parents = '',
      refs = '',
    ] = header.split('\x1f')
    return {
      sha,
      shortSha,
      subject,
      authorName,
      authorEmail: authorEmail || null,
      authoredAt: Number(timestamp) * 1000 || 0,
      parents: parents.split(' ').filter(Boolean),
      refs: this.parseLogRefs(refs),
    }
  }

  /**
   * `%D` 在 `--decorate=full` 下的样子：`HEAD -> refs/heads/main, tag: refs/tags/v1, refs/remotes/origin/main`。
   * 引用名里不能有空格，所以按「逗号加空格」拆不会拆错带逗号的名字。只认分支、远端分支、标签和 HEAD：
   * 贮藏、`origin/HEAD` 这种指向别的分支的符号引用、内部引用都不算。
   */
  private parseLogRefs(raw: string): WorkspaceGitRef[] {
    const refs: WorkspaceGitRef[] = []
    for (const token of raw.split(', ')) {
      const current = token.startsWith('HEAD -> ')
      const name = (current ? token.slice('HEAD -> '.length) : token).replace(/^tag: /u, '').trim()
      if (name === 'HEAD') refs.push({ kind: 'head', name })
      else if (name.startsWith('refs/heads/'))
        refs.push({
          kind: 'branch',
          name: name.slice('refs/heads/'.length),
          current: optionalWhen(current, true),
        })
      else if (name.startsWith('refs/remotes/') && !name.endsWith('/HEAD'))
        refs.push({ kind: 'remote', name: name.slice('refs/remotes/'.length) })
      else if (name.startsWith('refs/tags/'))
        refs.push({ kind: 'tag', name: name.slice('refs/tags/'.length) })
    }
    return refs
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

  /** 没写说明时代拟的提交说明，按请求带来的界面语言写（它要写进仓库，不跟 main 此刻的界面语言走）。 */
  private createCommitMessage(status: WorkspaceGitStatusResult, locale: AppLocale): string {
    const entry = status.entries[0]
    const target =
      status.entries.length === 1
        ? (entry?.path.split('/').findLast(Boolean) ?? 'workspace')
        : workbenchMainTextIn(locale, 'git.commitMessageFiles', { count: status.entries.length })
    const key: WorkbenchMainMessageKey =
      entry?.indexStatus === 'A' || entry?.indexStatus === '?'
        ? 'git.commitMessageAdd'
        : entry?.indexStatus === 'D' || entry?.workTreeStatus === 'D'
          ? 'git.commitMessageRemove'
          : 'git.commitMessageUpdate'
    const subject = workbenchMainTextIn(locale, key, { target })
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
      operation: null,
    }
  }

  /** 报错时点名的文件：最多列 5 个，其余说个数。 */
  private describePaths(entries: readonly WorkspaceGitFileStatusEntry[]): string {
    const names = entries
      .slice(0, 5)
      .map((entry) => workbenchMainText('git.quotedPath', { path: entry.path }))
      .join(workbenchMainText('git.listSeparator'))
    return entries.length > 5
      ? workbenchMainText('git.pathsMore', {
          names,
          count: entries.length,
          rest: entries.length - 5,
        })
      : names
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

  private normalizePathspecs(rootPath: string, paths: ReadonlyArray<string | undefined>): string[] {
    return [
      ...new Set(
        paths
          .filter((path): path is string => !!path)
          .map((path) => this.normalizePathspec(rootPath, path))
      ),
    ]
  }

  private normalizePathspec(rootPath: string, path: string): string {
    if (!path.trim() || path.includes('\0'))
      throw new AppError('VALIDATION', workbenchMainText('git.invalidPath'))
    const absolutePath = isAbsolute(path) ? resolve(path) : resolve(rootPath, path)
    const relativePath = getRelativePathInsideRoot(rootPath, absolutePath)
    if (!relativePath || relativePath === '.')
      throw new AppError('PERMISSION', workbenchMainText('git.pathOutsideProject'))
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
      throw new AppError('VALIDATION', workbenchMainText('git.invalidRef'))
    }
    return normalized
  }

  private assertBranch(branch: string): string {
    const normalized = this.assertRevision(branch)
    if (normalized.includes('..') || normalized.endsWith('.') || normalized.endsWith('/'))
      throw new AppError('VALIDATION', workbenchMainText('git.invalidBranch'))
    return normalized
  }

  private async resolveRoot(workspaceRoot: string): Promise<string> {
    if (!workspaceRoot.trim())
      throw new AppError('VALIDATION', workbenchMainText('git.rootRequired'))
    const rootPath = await realpath(resolve(workspaceRoot))
    const rootStat = await stat(rootPath)
    if (!rootStat.isDirectory())
      throw new AppError('VALIDATION', workbenchMainText('git.rootMissing'))
    return rootPath
  }

  /** 项目在仓库里的位置；不是 Git 仓库时抛「不是 Git 仓库」。 */
  private async openRepository(rootPath: string): Promise<GitRepository> {
    // 一条命令问两样，各占一行：项目在仓库里的前缀（项目就是仓库根时是空行）、这个工作区的 git 目录。
    const [prefix = '', gitDirectory = ''] = (
      await this.runGit(rootPath, ['rev-parse', '--show-prefix', '--absolute-git-dir'])
    ).stdout.split(/\r?\n/u)
    return { rootPath, prefix, gitDirectory }
  }

  private async runGit(
    rootPath: string,
    args: string[],
    options: GitRunOptions = {}
  ): Promise<GitRunResult> {
    const maxBuffer = options.maxBuffer ?? GitOutputMaxBytes
    const env = await this.buildGitEnvironment(options)
    // 还没起进程就已经取消了（同步时拉取完、推送前取消的）：不再起。
    if (options.signal?.aborted) throw this.cancelledError(args)
    // 会被中途结束的命令（太久没动静、用户取消）单独成一个进程组：结束时连同 git 起的 ssh 一起，不留下还
    // 连着远端的进程。
    const stoppable = !!options.inactivityTimeoutMs || !!options.signal
    const ownProcessGroup = stoppable && process.platform !== 'win32'
    const subprocess = execa('git', [...GitOutputConfig, ...args], {
      cwd: rootPath,
      env,
      input: options.input,
      maxBuffer,
      stripFinalNewline: !options.keepFinalNewline,
      detached: ownProcessGroup,
      reject: false,
    })
    const readStopReason = stoppable
      ? this.watchGitProcess(subprocess, ownProcessGroup, options)
      : null
    const result = await subprocess.catch(async (error: unknown) => {
      await readStopReason?.()
      throw error
    })
    const stopped = (await readStopReason?.()) ?? null
    const output: GitRunResult = {
      stdout: result.stdout,
      stderr: result.stderr,
      failed: result.failed,
      truncated: result.isMaxBuffer,
    }
    if (stopped === 'cancelled') throw this.cancelledError(args)
    if (stopped === 'inactive')
      throw new AppError(
        'TIMEOUT',
        workbenchMainText('git.noProgress', {
          command: this.describeCommand(args),
          seconds: Math.round((options.inactivityTimeoutMs ?? 0) / 1000),
        })
      )
    if (result.isMaxBuffer) {
      if (options.allowTruncated) return output
      throw new AppError(
        'LIMIT',
        workbenchMainText('git.outputTooLarge', {
          command: this.describeCommand(args),
          size: Math.round(maxBuffer / 1024 / 1024),
        })
      )
    }
    if (result.failed && !options.allowFailure)
      this.throwGitFailure(args, output, options.githubToken)
    return output
  }

  /**
   * 盯着一个会被中途结束的 git 进程：太久没有任何输出、或者取消信号来了，就结束它（连同它的进程组）。
   * 返回的函数在进程收场后调用：撤掉计时与监听，说出它是不是被结束的、为什么。
   */
  private watchGitProcess(
    subprocess: StoppableGitProcess,
    ownProcessGroup: boolean,
    options: Pick<GitRunOptions, 'inactivityTimeoutMs' | 'signal'>
  ): () => Promise<Nullable<GitStopReason>> {
    const { inactivityTimeoutMs, signal } = options
    let stopped: Nullable<GitStopReason> = null
    let inactivityTimer: Nullable<ReturnType<typeof setTimeout>> = null
    let termination: Promise<void> | null = null
    const terminationErrors: unknown[] = []
    const stop = (reason: GitStopReason): void => {
      if (stopped) return
      stopped = reason
      termination = this.terminateGitProcess(subprocess, ownProcessGroup).catch((error: unknown) => {
        terminationErrors.push(error)
      })
    }
    const armInactivityTimer = (): void => {
      if (inactivityTimer) clearTimeout(inactivityTimer)
      inactivityTimer = setTimeout(() => stop('inactive'), inactivityTimeoutMs)
    }
    const cancel = (): void => stop('cancelled')

    if (inactivityTimeoutMs) {
      armInactivityTimer()
      // 进度（`--progress`）写在 stderr 上，结果写在 stdout 上：哪边有动静都重新计时。
      subprocess.stdout?.on('data', armInactivityTimer)
      subprocess.stderr?.on('data', armInactivityTimer)
    }
    if (signal?.aborted) cancel()
    else signal?.addEventListener('abort', cancel, { once: true })

    return async () => {
      if (inactivityTimer) clearTimeout(inactivityTimer)
      signal?.removeEventListener('abort', cancel)
      subprocess.stdout?.removeListener('data', armInactivityTimer)
      subprocess.stderr?.removeListener('data', armInactivityTimer)
      await termination
      if (terminationErrors.length > 0)
        throw new AggregateError(terminationErrors, 'Failed to terminate Git process tree')
      return stopped
    }
  }

  /**
   * 结束 git 进程：先 SIGTERM，git 收到会删掉自己的锁文件再退出；它退出了、或者过了 GitTerminateGraceMs
   * 还没退出，再强杀整个进程组，把 git 起的 ssh 一并带走。Windows 复用系统进程树清理并等待完成。
   */
  private async terminateGitProcess(
    subprocess: StoppableGitProcess,
    ownProcessGroup: boolean
  ): Promise<void> {
    const { pid } = subprocess
    if (!pid) return
    if (process.platform === 'win32') {
      // Git/SSH 不是 Windows 进程组；根仍活着时取树，等待系统终止它的全部子孙。
      const tree = await listWorkbenchProcessTree(pid)
      try {
        await signalWorkbenchProcesses(tree, 'SIGTERM')
      } catch (error) {
        try {
          subprocess.kill('SIGKILL')
        } catch (killError) {
          throw new AggregateError([error, killError], 'Git process tree and root termination failed')
        }
        throw error
      }
      return
    }
    const send = (signal: NodeJS.Signals): void => {
      try {
        if (ownProcessGroup) process.kill(-pid, signal)
        else subprocess.kill(signal)
      } catch {
        // arch-guard:silent-catch-ok 进程（组）已经不在了。
      }
    }
    let graceTimer: Nullable<ReturnType<typeof setTimeout>> = null
    let killed = false
    const kill = (): void => {
      if (killed) return
      killed = true
      if (graceTimer) clearTimeout(graceTimer)
      send('SIGKILL')
    }
    send('SIGTERM')
    graceTimer = setTimeout(kill, GitTerminateGraceMs)
    subprocess.then(kill, kill)
  }

  private cancelledError(args: readonly string[]): AppError {
    return new AppError(
      'CANCELLED',
      workbenchMainText('git.cancelled', { command: this.describeCommand(args) })
    )
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

  private throwGitFailure(args: string[], result: GitRunResult, githubToken?: string): never {
    const output = this.redactGitOutput(this.readableGitOutput(result), githubToken)
    if (output.toLowerCase().includes('not a git repository'))
      throw new WorkbenchGitNotRepositoryError()
    throw new AppError(
      'PLATFORM',
      output
        ? workbenchMainText('git.commandFailedDetail', { detail: output.slice(0, 500) })
        : workbenchMainText('git.commandFailed', { command: this.describeCommand(args) })
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
    return error instanceof WorkbenchGitNotRepositoryError
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
      const index = Number.isFinite(Number(env.GIT_CONFIG_COUNT)) ? Number(env.GIT_CONFIG_COUNT) : 0
      env.GIT_CONFIG_COUNT = String(index + 1)
      env[`GIT_CONFIG_KEY_${index}`] =
        `url.https://x-access-token:${encodeURIComponent(token)}@github.com/.insteadOf`
      env[`GIT_CONFIG_VALUE_${index}`] = 'https://github.com/'
    }
    const keyPath = options.privateKeyPath?.trim()
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
