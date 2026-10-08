import { type SystemWorkspaceGitOperationResult, type WorkspaceGitBranch, type WorkspaceGitLogEntry } from '@shared/contracts/system'
import { type WorkspaceGitOperationAction, type WorkspaceGitOperationKind, type WorkspaceGitOperationRequest, type WorkspaceGitOperationState, type WorkspaceGitRef } from '@shared/contracts/workspaceGit'

import { type WorkbenchI18nContextValue } from '../../i18n/WorkbenchLocalizationProvider'

type Translate = WorkbenchI18nContextValue['t']

/** 要合并进来的分支，或者要把当前分支变基到它上面的分支。 */
export interface WorkbenchGitOperationBranch {
  /** 界面上显示的名字：`feature/login`、`origin/main`。 */
  name: string
  /** 交给 git 的名字：说得清是哪一个引用，同名的标签不会被当成它。 */
  revision: string
}

type WorkbenchGitOperationCommit = Pick<WorkspaceGitLogEntry, 'sha' | 'shortSha' | 'subject'>

/** 用户要做的那一步：开始一个操作（带着对象），或者对进行到一半的那个说继续、放弃、跳过。 */
export type WorkbenchGitOperationIntent =
  | { action: 'merge' | 'rebase'; branch: WorkbenchGitOperationBranch }
  | { action: 'cherry-pick' | 'revert'; commit: WorkbenchGitOperationCommit }
  | { action: 'continue' | 'abort' | 'skip' }

export interface WorkbenchGitOperationContext {
  /** 当前 HEAD 在界面上的名字：分支名，或者「分离的 HEAD · 1a2b3c4」。 */
  current: string
  /** 这一步属于哪种操作：开始的就是它自己；继续、放弃、跳过的是进行到一半的那个。 */
  kind: WorkspaceGitOperationKind
}

export interface WorkbenchGitOperationNotice {
  tone: 'success' | 'info' | 'warning'
  title: string
  description?: string
  /** 停在冲突上了：提示挂久一点，并把提交面板（冲突文件列在那里）打开。 */
  conflicts: boolean
}

export interface WorkbenchGitOperationBannerText {
  title: string
  /** 操作的对象与进度；读不出来为 null。 */
  detail: Nullable<string>
  /** 接下来该做什么。 */
  hint: string
  /** 冲突都解决了才能继续。 */
  canContinue: boolean
  /** 合并没有「跳过」：它只有一步。 */
  canSkip: boolean
}

const OperationNameKeys: Record<WorkspaceGitOperationKind, string> = {
  merge: 'workbench.gitOperationMerge',
  rebase: 'workbench.gitOperationRebase',
  'cherry-pick': 'workbench.gitOperationCherryPick',
  revert: 'workbench.gitOperationRevert',
}

const SuccessTitleKeys: Record<WorkspaceGitOperationKind, string> = {
  merge: 'workbench.gitMergeSuccessTitle',
  rebase: 'workbench.gitRebaseSuccessTitle',
  'cherry-pick': 'workbench.gitCherryPickSuccessTitle',
  revert: 'workbench.gitRevertSuccessTitle',
}

/** 确认框里引用提交说明时最多这么长，再长的截断。 */
const SubjectMaxChars = 72

function shortenSubject(subject: string): string {
  return subject.length > SubjectMaxChars ? `${subject.slice(0, SubjectMaxChars - 1)}…` : subject
}

/** 操作在句子里的名字：「合并」「变基」「拣选」「撤销提交」。 */
export function getWorkbenchGitOperationName(kind: WorkspaceGitOperationKind, t: Translate): string {
  return t(OperationNameKeys[kind])
}

/**
 * 日志里引用标签指的分支。标签上的名字是从完整引用名上截下来的（`feature`），仓库里有同名的标签时光凭
 * 它 git 会认成标签，所以连同种类拼回完整的引用名。标签、分离的 HEAD 不是分支，为 null。
 */
export function resolveWorkbenchGitRefBranch(
  ref: WorkspaceGitRef
): Nullable<WorkbenchGitOperationBranch> {
  if (ref.kind === 'branch') return { name: ref.name, revision: `refs/heads/${ref.name}` }
  if (ref.kind === 'remote') return { name: ref.name, revision: `refs/remotes/${ref.name}` }
  return null
}

/** 分支列表里的分支：名字是 git 自己给的最短而不含糊的写法，原样交回去。 */
export function resolveWorkbenchGitListedBranch(
  branch: Pick<WorkspaceGitBranch, 'name'>
): WorkbenchGitOperationBranch {
  return { name: branch.name, revision: branch.name }
}

export function toWorkspaceGitOperationRequest(
  intent: WorkbenchGitOperationIntent
): WorkspaceGitOperationRequest {
  if (intent.action === 'merge' || intent.action === 'rebase')
    return { action: intent.action, target: intent.branch.revision }
  if (intent.action === 'cherry-pick' || intent.action === 'revert')
    return { action: intent.action, target: intent.commit.sha }
  return { action: intent.action }
}

/**
 * 动手之前问用户的那句话；「继续」不用问，为 null。开始一个操作会在当前分支上多出提交、或者改写它的
 * 提交，是从右键菜单里点的，手滑一下就做了，所以问；放弃、跳过会丢掉已经做的东西，也问。
 */
export function buildWorkbenchGitOperationConfirm(
  intent: WorkbenchGitOperationIntent,
  context: WorkbenchGitOperationContext,
  t: Translate
): Nullable<string> {
  const { current } = context
  if (intent.action === 'merge')
    return t('workbench.gitMergeConfirm', { source: intent.branch.name, current })
  if (intent.action === 'rebase')
    return t('workbench.gitRebaseConfirm', { target: intent.branch.name, current })
  if (intent.action === 'cherry-pick' || intent.action === 'revert')
    return t(
      intent.action === 'cherry-pick'
        ? 'workbench.gitCherryPickConfirm'
        : 'workbench.gitRevertConfirm',
      { sha: intent.commit.shortSha, subject: shortenSubject(intent.commit.subject), current }
    )
  if (intent.action === 'abort')
    return t('workbench.gitOperationAbortConfirm', {
      operation: getWorkbenchGitOperationName(context.kind, t),
    })
  if (intent.action === 'skip') return t('workbench.gitOperationSkipConfirm')
  return null
}

function describeSuccess(
  intent: WorkbenchGitOperationIntent,
  current: string,
  t: Translate
): string | undefined {
  if (intent.action === 'merge')
    return t('workbench.gitMergeSuccessDescription', { source: intent.branch.name, current })
  if (intent.action === 'rebase')
    return t('workbench.gitRebaseSuccessDescription', { target: intent.branch.name, current })
  if (intent.action === 'cherry-pick')
    return t('workbench.gitCherryPickSuccessDescription', { sha: intent.commit.shortSha, current })
  if (intent.action === 'revert')
    return t('workbench.gitRevertSuccessDescription', { sha: intent.commit.shortSha, current })
  return undefined
}

/** 一步做完之后告诉用户的话：停在冲突上了、已经是最新、放弃了、跳过了，或者做成了。 */
export function describeWorkbenchGitOperationOutcome(
  intent: WorkbenchGitOperationIntent,
  result: Pick<SystemWorkspaceGitOperationResult, 'operation' | 'summary'>,
  context: WorkbenchGitOperationContext,
  t: Translate
): WorkbenchGitOperationNotice {
  const operation = getWorkbenchGitOperationName(context.kind, t)
  const { conflicts, upToDate } = result.operation
  if (conflicts.length > 0)
    return {
      tone: 'warning',
      title: t('workbench.gitOperationConflictsTitle', { operation }),
      description: t('workbench.gitOperationConflictsDescription', { count: conflicts.length }),
      conflicts: true,
    }
  if (intent.action === 'abort')
    return {
      tone: 'info',
      title: t('workbench.gitOperationAbortedTitle', { operation }),
      conflicts: false,
    }
  // 这一步没有冲突，操作却还没完（被提交钩子拦下了之类）：不说「做成了」，上方的提示条还在。
  if (result.summary.operation)
    return {
      tone: 'info',
      title: t('workbench.gitOperationStillInProgressTitle', { operation }),
      conflicts: false,
    }
  if (intent.action === 'skip')
    return {
      tone: 'success',
      title: t('workbench.gitOperationSkippedTitle'),
      description: t('workbench.gitOperationFinishedDescription', { operation }),
      conflicts: false,
    }
  if (upToDate && (intent.action === 'merge' || intent.action === 'rebase'))
    return {
      tone: 'info',
      title: t('workbench.gitOperationUpToDateTitle'),
      description: t(
        intent.action === 'merge'
          ? 'workbench.gitMergeUpToDateDescription'
          : 'workbench.gitRebaseUpToDateDescription',
        { branch: intent.branch.name, current: context.current }
      ),
      conflicts: false,
    }
  return {
    tone: 'success',
    title: t(SuccessTitleKeys[context.kind]),
    description: describeSuccess(intent, context.current, t),
    conflicts: false,
  }
}

/** 进行到一半的操作在提示条上怎么写：是什么、到哪一步了、接下来该做什么、哪些按钮能按。 */
export function describeWorkbenchGitOperationBanner(
  operation: WorkspaceGitOperationState,
  conflictCount: number,
  t: Translate
): WorkbenchGitOperationBannerText {
  const name = getWorkbenchGitOperationName(operation.kind, t)
  const details: string[] = []
  if (operation.kind === 'merge' || operation.kind === 'rebase') {
    if (operation.detail) details.push(operation.detail)
  } else if (operation.detail) {
    details.push(t('workbench.gitOperationCommit', { sha: operation.detail }))
  }
  if (operation.step !== null && operation.total !== null)
    details.push(
      t('workbench.gitOperationStep', { step: operation.step, total: operation.total })
    )
  return {
    title: t('workbench.gitOperationInProgress', { operation: name }),
    detail: details.length > 0 ? details.join(' · ') : null,
    hint:
      conflictCount > 0
        ? t('workbench.gitOperationConflictsHint', { count: conflictCount })
        : t('workbench.gitOperationReadyHint', { operation: name }),
    canContinue: conflictCount === 0,
    canSkip: operation.kind !== 'merge',
  }
}

/** 每个项目正在跑的那一步。提示条在提交面板和 Git 工具窗里各有一个，哪边点的，两边都看得到它在跑。 */
const pendingActions = new Map<string, WorkspaceGitOperationAction>()
const listeners = new Set<() => void>()

function notify(): void {
  for (const listener of [...listeners]) listener()
}

/** 登记一步要开始了；这个项目已经有一步在跑时为 false（同一时刻只跑一步）。 */
export function beginWorkbenchGitOperation(
  workspaceRoot: string,
  action: WorkspaceGitOperationAction
): boolean {
  if (pendingActions.has(workspaceRoot)) return false
  pendingActions.set(workspaceRoot, action)
  notify()
  return true
}

export function endWorkbenchGitOperation(workspaceRoot: string): void {
  if (pendingActions.delete(workspaceRoot)) notify()
}

export function readWorkbenchGitPendingOperation(
  workspaceRoot: string
): Nullable<WorkspaceGitOperationAction> {
  return pendingActions.get(workspaceRoot) ?? null
}

export function subscribeWorkbenchGitPendingOperations(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
