import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { AppError } from '@velaros-ai/velaros/core/error'

import {
  type SystemWorkspaceGitOperationResult,
  type WorkspaceGitStatusResult,
} from '@shared/contracts/system'
import {
  type WorkspaceGitOperationAction,
  type WorkspaceGitOperationKind,
  type WorkspaceGitOperationRequest,
  type WorkspaceGitOperationResult,
  type WorkspaceGitOperationState,
} from '@shared/contracts/workspaceGit'
import { isWorkspaceGitConflictEntry, isWorkspaceGitOperationKind } from '@shared/workbenchGit'

import { type WorkbenchMainMessageKey, workbenchMainText } from '../../i18n/workbenchMainMessages'

import type { GitRepository, GitRunResult, WorkbenchGitAccess } from './WorkbenchGitAccess'

/** 各个操作在文案表里的名字（「正在合并」「Git 没有开始变基」里的那个词）。 */
export const WorkbenchGitOperationLabels: Record<
  WorkspaceGitOperationKind,
  WorkbenchMainMessageKey
> = {
  merge: 'git.operationMerge',
  rebase: 'git.operationRebase',
  'cherry-pick': 'git.operationCherryPick',
  revert: 'git.operationRevert',
}

/**
 * 这些命令都不开编辑器：合并说明、变基的步骤单、拣选与撤销的提交说明，一律用 git 备好的那份。
 * 编辑器开不出来（没有终端），命令会一直挂着。
 */
const NonInteractiveEnvironment = {
  GIT_MERGE_AUTOEDIT: 'no',
  GIT_EDITOR: ':',
  GIT_SEQUENCE_EDITOR: ':',
}

/** 转告 git 的说明时最多这么长。 */
const OutputMaxChars = 800
/** 拣选、撤销出来的是个空提交：那个提交的改动当前分支里已经有了（或者已经没了）。 */
const EmptyResultPattern = /is now empty|nothing to commit/iu
const UpToDatePattern = /already up to date|is up to date/iu

type ResumeAction = Exclude<WorkspaceGitOperationAction, WorkspaceGitOperationKind>

/**
 * 合并、变基、拣选、撤销，以及它们停在半路之后的继续、放弃、跳过。
 *
 * - 同一时刻只有一个操作：已经有一个停在半路、或者还有没解决的冲突时，不再开始新的。
 * - 开始时 git 发现会覆盖没提交的改动或未跟踪的文件就不动手，把它的说明（哪些文件）原样转告；
 *   放弃（`--abort`）只还原被这次操作动过的已跟踪文件，未跟踪的文件不碰。
 * - 出了冲突不算失败：结果里列出冲突文件，操作停在那里（摘要里的 `operation`），用户在编辑器里解决、
 *   标记为已解决，再继续。变基每继续一步都可能停在下一个冲突上。
 * - 不做交互式变基：步骤单照 git 默认的来。
 */
export class WorkbenchGitOperations {
  constructor(private readonly git: WorkbenchGitAccess) {}

  /**
   * 仓库里进行到一半的操作，从 git 目录里的标记读（不起 git 进程，摘要每次刷新都要问）：
   * `rebase-merge/`、`rebase-apply/`（变基）、`MERGE_HEAD`、`CHERRY_PICK_HEAD`、`REVERT_HEAD`。
   */
  public async readState(repository: GitRepository): Promise<Nullable<WorkspaceGitOperationState>> {
    const read = (name: string): Promise<Nullable<string>> =>
      readFile(join(repository.gitDirectory, name), 'utf8').then(
        (text) => text.trim(),
        () => null
      )
    const readNumber = async (name: string): Promise<Nullable<number>> => {
      const value = Number.parseInt((await read(name)) ?? '', 10)
      return Number.isFinite(value) ? value : null
    }

    // 变基最先看：它停下来的那一步本身是一次拣选，CHERRY_PICK_HEAD 这时也在。
    for (const [directory, step, total] of [
      ['rebase-merge', 'msgnum', 'end'],
      ['rebase-apply', 'next', 'last'],
    ] as const) {
      const headName = await read(`${directory}/head-name`)
      if (headName === null) continue
      // `rebase-apply/` 也是 `git am` 用的目录：没有 rebasing 标记的不是变基。
      if (directory === 'rebase-apply' && (await read('rebase-apply/rebasing')) === null) continue
      return {
        kind: 'rebase',
        step: await readNumber(`${directory}/${step}`),
        total: await readNumber(`${directory}/${total}`),
        detail: headName.startsWith('refs/heads/') ? headName.slice('refs/heads/'.length) : null,
      }
    }
    if ((await read('MERGE_HEAD')) !== null)
      return {
        kind: 'merge',
        step: null,
        total: null,
        detail: (await read('MERGE_MSG'))?.split('\n')[0]?.trim() || null,
      }
    for (const [marker, kind] of [
      ['CHERRY_PICK_HEAD', 'cherry-pick'],
      ['REVERT_HEAD', 'revert'],
    ] as const) {
      const sha = await read(marker)
      if (sha !== null) return { kind, step: null, total: null, detail: sha.slice(0, 7) || null }
    }
    return null
  }

  public async perform(
    workspaceRoot: string,
    request: WorkspaceGitOperationRequest
  ): Promise<SystemWorkspaceGitOperationResult> {
    const rootPath = await this.git.resolveRoot(workspaceRoot)
    const repository = await this.git.openRepository(rootPath)
    const state = await this.readState(repository)
    const { action } = request
    const operation = isWorkspaceGitOperationKind(action)
      ? await this.start(repository, state, action, request.target)
      : await this.resume(repository, state, action)
    return { rootPath, operation, summary: await this.git.getSummary(rootPath) }
  }

  private async start(
    repository: GitRepository,
    state: Nullable<WorkspaceGitOperationState>,
    action: WorkspaceGitOperationKind,
    target: string | undefined
  ): Promise<WorkspaceGitOperationResult> {
    const { rootPath } = repository
    const operation = workbenchMainText(WorkbenchGitOperationLabels[action])
    if (state)
      throw new AppError(
        'VALIDATION',
        workbenchMainText('git.operationInProgress', {
          operation: workbenchMainText(WorkbenchGitOperationLabels[state.kind]),
        })
      )
    const status = await this.assertNoConflicts(repository, 'git.conflictsBlockOperation')
    // 合并是并到当前分支里，变基是挪当前分支：分离的 HEAD 上没有当前分支，做出来的提交不挂在任何分支上。
    if ((action === 'merge' || action === 'rebase') && !status.branch)
      throw new AppError('VALIDATION', workbenchMainText('git.operationNeedsBranch', { operation }))
    if (!target?.trim())
      throw new AppError(
        'VALIDATION',
        workbenchMainText('git.operationTargetRequired', { operation })
      )
    const revision = await this.shortestName(rootPath, this.git.assertRevision(target))
    const resolved = await this.git.run(
      rootPath,
      ['rev-list', '--parents', '--max-count=1', `${revision}^{commit}`],
      { allowFailure: true }
    )
    // `rev-list --parents` 一行：提交自己，后面跟着各个父提交。
    const [sha, ...parents] = resolved.stdout.trim().split(' ').filter(Boolean)
    if (resolved.failed || !sha)
      throw new AppError('VALIDATION', workbenchMainText('git.revisionMissing', { revision }))

    // 拣选、撤销一个合并提交要说相对哪个父提交算它的改动：按主线（第一个父提交），也就是它合并进来的那些。
    const mainline = parents.length > 1 ? ['-m', '1'] : []
    const args =
      action === 'merge'
        ? // 给名字不给提交号：合并说明里写的是分支名。
          ['merge', '--no-edit', revision]
        : action === 'rebase'
          ? ['rebase', revision]
          : action === 'cherry-pick'
            ? ['cherry-pick', ...mainline, sha]
            : ['revert', '--no-edit', ...mainline, sha]
    const result = await this.git.run(rootPath, args, {
      allowFailure: true,
      env: NonInteractiveEnvironment,
    })
    const settled = await this.settle(repository, action, result)
    if (settled) return settled

    // 没成，也没有冲突。拣选、撤销出来的是空提交时 git 停在半路等人决定：替它收掉，说明白。
    const output = this.git.readOutput(result)
    if (
      (action === 'cherry-pick' || action === 'revert') &&
      EmptyResultPattern.test(`${result.stdout}\n${result.stderr}`)
    ) {
      if (await this.readState(repository))
        await this.git.run(rootPath, [action, '--abort'], { allowFailure: true })
      throw new AppError(
        'VALIDATION',
        workbenchMainText(action === 'cherry-pick' ? 'git.cherryPickEmpty' : 'git.revertEmpty')
      )
    }
    // 项目里没有冲突文件，操作却停在了半路：冲突在项目之外（项目是仓库里的子目录时），或者被提交钩子拦下了。
    // 这时它确实开始了，不能说「没有开始」。
    throw new AppError(
      'VALIDATION',
      workbenchMainText(
        (await this.readState(repository)) ? 'git.operationStopped' : 'git.operationRefused',
        { operation, output: output.slice(0, OutputMaxChars) }
      )
    )
  }

  private async resume(
    repository: GitRepository,
    state: Nullable<WorkspaceGitOperationState>,
    action: ResumeAction
  ): Promise<WorkspaceGitOperationResult> {
    if (!state) throw new AppError('VALIDATION', workbenchMainText('git.noOperationInProgress'))
    if (action === 'skip' && state.kind === 'merge')
      throw new AppError('VALIDATION', workbenchMainText('git.mergeCannotSkip'))
    if (action === 'continue')
      await this.assertNoConflicts(repository, 'git.conflictsBlockContinue')

    // 合并的「继续」就是把它提交掉（`merge --continue` 做的也是这件事）。
    const args =
      action === 'continue' && state.kind === 'merge'
        ? ['commit', '--no-edit']
        : [state.kind, `--${action}`]
    const result = await this.git.run(repository.rootPath, args, {
      allowFailure: true,
      env: NonInteractiveEnvironment,
    })
    const settled = await this.settle(repository, action, result)
    if (settled) return settled
    throw new AppError(
      'VALIDATION',
      workbenchMainText('git.operationStepRefused', {
        output: this.git.readOutput(result).slice(0, OutputMaxChars),
      })
    )
  }

  /**
   * 一步跑完之后的结果：成了，或者停在冲突上（不算失败，冲突文件列出来）。没成又没有冲突时为 null，
   * 由调用方按 git 的说明报错。
   */
  private async settle(
    repository: GitRepository,
    action: WorkspaceGitOperationAction,
    result: GitRunResult
  ): Promise<Nullable<WorkspaceGitOperationResult>> {
    const output = `${result.stdout}\n${result.stderr}`.trim()
    if (!result.failed)
      return { action, conflicts: [], upToDate: UpToDatePattern.test(output), output }
    const conflicts = (await this.git.getStatus(repository)).entries
      .filter((entry) => isWorkspaceGitConflictEntry(entry))
      .map((entry) => entry.path)
    return conflicts.length > 0 ? { action, conflicts, upToDate: false, output } : null
  }

  /**
   * 完整的引用名（`refs/heads/feature`）换成 git 认得出的最短写法（`feature`；有同名标签时是
   * `heads/feature`）。界面上点的是哪个分支就给完整的名字，免得同名的标签被当成它；合并说明里写的却是
   * 交给 git 的那个写法，所以交给它短的。
   */
  private async shortestName(rootPath: string, revision: string): Promise<string> {
    if (!revision.startsWith('refs/')) return revision
    const listed = await this.git.run(
      rootPath,
      ['for-each-ref', '--format=%(refname)%09%(refname:short)', revision],
      { allowFailure: true }
    )
    for (const line of listed.stdout.split(/\r?\n/u)) {
      const [name, short] = line.split('\t')
      if (name === revision && short) return short
    }
    return revision
  }

  /** 项目此刻的状态；里面还有没解决的冲突时抛错，点出是哪些文件。 */
  private async assertNoConflicts(
    repository: GitRepository,
    message: 'git.conflictsBlockOperation' | 'git.conflictsBlockContinue'
  ): Promise<WorkspaceGitStatusResult> {
    const status = await this.git.getStatus(repository)
    const conflicts = status.entries.filter((entry) => isWorkspaceGitConflictEntry(entry))
    if (conflicts.length > 0)
      throw new AppError(
        'VALIDATION',
        workbenchMainText(message, { paths: this.git.describePaths(conflicts) })
      )
    return status
  }
}
