import { lstat } from 'node:fs/promises'
import { join } from 'node:path'

import { AppError } from '@velaros-ai/core/error'

import type {
  SystemWorkspaceGitStashActionResult,
  SystemWorkspaceGitStashListResult,
  SystemWorkspaceGitStashResult,
  WorkspaceGitStash,
  WorkspaceGitStashAction,
  WorkspaceGitStashOptions,
  WorkspaceGitStatusResult,
} from '@shared/contracts'
import { isWorkspaceGitConflictEntry } from '@shared/workbenchGit'

import { workbenchMainText } from '../../i18n/workbenchMainMessages'

import type { GitRepository, WorkbenchGitAccess } from './WorkbenchGitAccess'

/** 贮藏列表的每一条以 \x1e 开头，字段之间是 \x1f：贮藏提交、reflog 里的说明、提交时间、父提交。 */
const StashListFormat = '--format=%x1e%H%x1f%gs%x1f%ct%x1f%P'
/** reflog 里的说明：没写说明的是 `WIP on main: 1a2b3c4 提交主题`，写了的是 `On main: 说明`。 */
const StashSubjectPattern = /^(WIP on|On) (.+?): ([\s\S]*)$/u
/** 分离的 HEAD 上贮藏的，分支那一栏是它。 */
const NoBranchLabel = '(no branch)'
/** 贮藏提交的对象名：SHA-1 40 位，SHA-256 64 位。 */
const ObjectNamePattern = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u
const StashMessageMaxChars = 200
/** 取不回贮藏时转告 git 的说明，最多这么长。 */
const RefusalOutputMaxChars = 800
/** 文件清单的输出上限：连着没被忽略的依赖目录一起贮藏时，清单远不止默认的 4 MB。 */
const NameListingMaxBytes = 32 * 1024 * 1024
/** 挡着取回的文件最多点名这么多个。 */
const BlockingNamesShown = 5
const StashDiffArgs = ['diff', '--no-ext-diff', '--no-color', '--no-textconv', '--find-renames']

/**
 * 贮藏（`git stash`）：把没提交的改动收起来、列出来、取回、删掉。
 *
 * - 贮藏凭贮藏提交的对象名认，不凭 `stash@{n}`：每来一条新贮藏，旧的序号都往后挪，界面上列着的序号
 *   转眼就可能指向另一条；动手之前按对象名重新找它此刻的序号。
 * - 项目是仓库里的子目录时只贮藏项目里的改动（`-- .`）；贮藏列表是整个仓库的。
 * - 取回时 git 不覆盖工作区里没提交的改动，也不覆盖同名的未跟踪文件：那时它什么都不动（或只取回一部分），
 *   把它的说明原样转告。与已提交的内容冲突时文件里留下冲突标记，走合并冲突的那套流程，贮藏不删。
 */
export class WorkbenchGitStashes {
  constructor(private readonly git: WorkbenchGitAccess) {}

  public async list(workspaceRoot: string): Promise<SystemWorkspaceGitStashListResult> {
    const rootPath = await this.git.resolveRoot(workspaceRoot)
    await this.git.openRepository(rootPath)
    return { rootPath, stashes: await this.readStashes(rootPath) }
  }

  /** 贮藏项目里没提交的改动（已暂存的、没暂存的；要求的话连未跟踪的文件）。 */
  public async stash(
    workspaceRoot: string,
    options: WorkspaceGitStashOptions = {}
  ): Promise<SystemWorkspaceGitStashResult> {
    const rootPath = await this.git.resolveRoot(workspaceRoot)
    const repository = await this.git.openRepository(rootPath)
    const status = await this.assertWorkingTreeSettled(repository)
    const untracked = status.entries.filter(
      (entry) => entry.indexStatus === '?' && entry.workTreeStatus === '?'
    )
    const stashable = options.includeUntracked
      ? status.entries.length
      : status.entries.length - untracked.length
    if (stashable === 0)
      throw new AppError(
        'VALIDATION',
        workbenchMainText(
          untracked.length > 0 ? 'git.nothingToStashOnlyUntracked' : 'git.nothingToStash'
        )
      )

    const message = this.normalizeMessage(options.message)
    const args = ['stash', 'push']
    if (options.includeUntracked) args.push('--include-untracked')
    if (message) args.push('--message', message)
    // `-- .`：只收项目里的改动（项目可能是仓库里的一个子目录）。
    args.push('--', '.')
    const result = await this.git.run(rootPath, args)
    // 状态读完之后改动又没了（别处刚提交、刚贮藏过）：git 照样退出 0，只说没有可存的。
    if (/no local changes to save/iu.test(`${result.stdout}\n${result.stderr}`))
      throw new AppError('VALIDATION', workbenchMainText('git.nothingToStash'))

    const stashes = await this.readStashes(rootPath)
    const [stash] = stashes
    if (!stash) throw new AppError('PLATFORM', workbenchMainText('git.stashMissing'))
    return { rootPath, stash, stashes, summary: await this.git.getSummary(rootPath) }
  }

  public async performAction(
    workspaceRoot: string,
    sha: string,
    action: WorkspaceGitStashAction
  ): Promise<SystemWorkspaceGitStashActionResult> {
    const rootPath = await this.git.resolveRoot(workspaceRoot)
    const repository = await this.git.openRepository(rootPath)
    const stash = await this.requireStash(rootPath, sha)
    if (action !== 'drop') {
      await this.assertWorkingTreeSettled(repository)
      await this.assertNothingInTheWay(rootPath, stash)
    }

    const args = ['stash', action, `stash@{${stash.index}}`]
    const result = await this.git.run(rootPath, args, { allowFailure: true })
    let conflicts: string[] = []
    if (result.failed) {
      if (action === 'drop') this.git.fail(args, result)
      // 取回时与已提交的内容冲突了：文件里留着冲突标记，不当失败，交给合并冲突的流程。
      conflicts = (await this.git.getStatus(repository)).entries
        .filter((entry) => isWorkspaceGitConflictEntry(entry))
        .map((entry) => entry.path)
      if (conflicts.length === 0)
        throw new AppError(
          'VALIDATION',
          workbenchMainText('git.stashApplyRefused', {
            output: this.git.readOutput(result).slice(0, RefusalOutputMaxChars),
          })
        )
    }

    const stashes = await this.readStashes(rootPath)
    return {
      rootPath,
      stashAction: {
        action,
        stash,
        conflicts,
        kept: stashes.some((candidate) => candidate.sha === stash.sha),
      },
      stashes,
      summary: await this.git.getSummary(rootPath),
    }
  }

  /**
   * 一条贮藏里的改动：相对它基于的提交改了什么，加上贮藏进去的未跟踪文件（它们在贮藏的第三个父提交里，
   * 整个都是新增）。`pathspecs` 非空时只看这些路径。
   */
  public async readDiff(
    rootPath: string,
    sha: string,
    pathspecs: readonly string[]
  ): Promise<string> {
    const stash = await this.requireStash(rootPath, sha)
    const limit = pathspecs.length > 0 ? ['--', ...pathspecs] : []
    const tracked = (await this.git.run(rootPath, [...StashDiffArgs, `${sha}^1`, sha, ...limit]))
      .stdout
    if (!stash.includesUntracked) return tracked
    const untracked = (
      await this.git.run(rootPath, [
        ...StashDiffArgs,
        await this.git.getEmptyTree(rootPath),
        `${sha}^3`,
        ...limit,
      ])
    ).stdout
    return [tracked, untracked].filter(Boolean).join('\n')
  }

  /**
   * 能不能动工作区：还有没解决的冲突、合并或变基进行到一半时，贮藏会把它们丢掉（贮藏完工作区是
   * `reset --hard` 过的样子），取回贮藏会搅进去；都先拦下。
   */
  private async assertWorkingTreeSettled(
    repository: GitRepository
  ): Promise<WorkspaceGitStatusResult> {
    const status = await this.git.getStatus(repository)
    const conflicts = status.entries.filter((entry) => isWorkspaceGitConflictEntry(entry))
    if (conflicts.length > 0)
      throw new AppError(
        'VALIDATION',
        workbenchMainText('git.conflictsBlockStash', {
          paths: this.git.describePaths(conflicts),
        })
      )
    const operation = await this.git.readOperationInProgress(repository)
    if (operation)
      throw new AppError(
        'VALIDATION',
        workbenchMainText('git.stashDuringOperation', { operation: workbenchMainText(operation) })
      )
    return status
  }

  /**
   * 取回之前先看有没有挡着的：git 不会覆盖工作区里没提交的改动，也不会覆盖同名的未跟踪文件，但它取回
   * 贮藏分两步——已跟踪文件的改动、贮藏里的未跟踪文件——哪一步被挡住了，另一步照做：取回了一半，贮藏
   * 又没删，再取回时先前放回去的文件自己又成了挡路的。所以动手之前两样都查，有挡着的就一点都不动。
   */
  private async assertNothingInTheWay(rootPath: string, stash: WorkspaceGitStash): Promise<void> {
    const listNames = async (args: string[]): Promise<string[]> =>
      (await this.git.run(rootPath, args, { maxBuffer: NameListingMaxBytes })).stdout
        .split('\0')
        .filter(Boolean)

    // 贮藏要改的已跟踪文件里，工作区还有没暂存的改动的（路径都相对仓库根，整个仓库都看）。
    const touched = new Set(
      await listNames(['diff', '--name-only', '-z', '--no-renames', `${stash.sha}^1`, stash.sha])
    )
    const overwritten = (await listNames(['diff', '--name-only', '-z', '--no-renames'])).filter(
      (name) => touched.has(name)
    )
    if (overwritten.length > 0)
      throw new AppError(
        'VALIDATION',
        workbenchMainText('git.stashWouldOverwrite', { files: this.describeNames(overwritten) })
      )

    if (!stash.includesUntracked) return
    const topLevel = (await this.git.run(rootPath, ['rev-parse', '--show-toplevel'])).stdout.trim()
    const collisions: string[] = []
    for (const name of await listNames(['ls-tree', '-r', '--name-only', '-z', `${stash.sha}^3`])) {
      // lstat：指向不存在目标的符号链接也算占着这个名字。
      if (await lstat(join(topLevel, name)).catch(() => null)) collisions.push(name)
      if (collisions.length > BlockingNamesShown) break
    }
    if (collisions.length > 0)
      throw new AppError(
        'VALIDATION',
        workbenchMainText('git.stashUntrackedCollision', { files: this.describeNames(collisions) })
      )
  }

  /** 报错时点名的文件：最多 BlockingNamesShown 个，再多的用省略号带过。 */
  private describeNames(names: readonly string[]): string {
    return (
      names.slice(0, BlockingNamesShown).join(workbenchMainText('git.listSeparator')) +
      (names.length > BlockingNamesShown ? workbenchMainText('git.listEllipsis') : '')
    )
  }

  /** 按对象名找到这条贮藏此刻的序号；不在了（取回过、删过）就说明白，不去碰别的贮藏。 */
  private async requireStash(rootPath: string, sha: string): Promise<WorkspaceGitStash> {
    const stash = ObjectNamePattern.test(sha)
      ? (await this.readStashes(rootPath)).find((candidate) => candidate.sha === sha)
      : undefined
    if (!stash) throw new AppError('VALIDATION', workbenchMainText('git.stashMissing'))
    return stash
  }

  private async readStashes(rootPath: string): Promise<WorkspaceGitStash[]> {
    const output = (await this.git.run(rootPath, ['stash', 'list', StashListFormat])).stdout
    return output
      .split('\x1e')
      .map((record) => record.trim())
      .filter(Boolean)
      .map((record, index) => {
        const [sha = '', subject = '', timestamp = '', parents = ''] = record.split('\x1f')
        const [, kind = '', branch = '', message = subject] = StashSubjectPattern.exec(subject) ?? []
        return {
          sha,
          index,
          message,
          autoMessage: kind !== 'On',
          branch: branch && branch !== NoBranchLabel ? branch : null,
          createdAt: Number(timestamp) * 1000 || 0,
          includesUntracked: parents.split(' ').filter(Boolean).length > 2,
        }
      })
  }

  /** 说明写成一行：换行、连着的空白收成一个空格，太长的截掉。 */
  private normalizeMessage(message: string | undefined): string {
    return (message ?? '').replace(/\s+/gu, ' ').trim().slice(0, StashMessageMaxChars)
  }
}
