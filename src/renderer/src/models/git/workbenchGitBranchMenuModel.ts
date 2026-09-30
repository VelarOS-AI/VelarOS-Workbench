import type {
  WorkspaceGitBranch,
  WorkspaceGitOperationState,
  WorkspaceGitRemoteAction,
  WorkspaceGitStatusResult,
} from '@shared/contracts'

import type { WorkbenchI18nContextValue } from '../../i18n'

import { getWorkbenchGitOperationName } from './workbenchGitOperationModel'
import { describeWorkbenchGitHead } from './workbenchGitTopBarModel'

type Translate = WorkbenchI18nContextValue['t']

export type WorkbenchGitBranchNamespace = 'local' | 'remote'

/**
 * 分支列表里的一层：一个分支（没有下一层），或者一个装着下一层的目录（`feature/login` 里的 `feature`）。
 * 不会两样都是：git 不允许 `feature` 和 `feature/login` 同时存在。
 */
export interface WorkbenchGitBranchTreeNode {
  /** 在整个列表里唯一：`local:feature/login`。折叠状态按它记。 */
  key: string
  /** 这一层的名字：`feature/login` 里的 `feature`、`login`。 */
  segment: string
  /** 目录为 null。 */
  branch: Nullable<WorkspaceGitBranch>
  children: WorkbenchGitBranchTreeNode[]
}

type WorkbenchGitBranchControlStatus = Pick<
  WorkspaceGitStatusResult,
  'branch' | 'detachedHead' | 'upstream' | 'ahead' | 'behind'
>

export interface WorkbenchGitRemoteActionItem {
  action: WorkspaceGitRemoteAction
  label: string
  /** 悬停时的说明；按不了时是原因。 */
  hint: string
  disabled: boolean
  /** 按钮上的数字：拉取是落后上游几个提交，推送是领先几个；其余为 0。 */
  count: number
}

export function isWorkbenchGitRemoteBranch(branch: Pick<WorkspaceGitBranch, 'kind'>): boolean {
  return branch.kind === 'remote'
}

/**
 * 菜单里列出来的分支。刚打开项目时只有轻量快照，分支列表还是空的：先把当前分支列上，菜单不至于是空的。
 */
export function listWorkbenchGitMenuBranches(
  branches: readonly WorkspaceGitBranch[],
  status: Pick<WorkspaceGitStatusResult, 'branch' | 'upstream'>
): WorkspaceGitBranch[] {
  if (branches.length > 0 || !status.branch) return [...branches]
  return [{ name: status.branch, current: true, upstream: status.upstream, kind: 'local' }]
}

/** 按搜索词留下名字里含它的分支（不分大小写）；没有搜索词原样返回。 */
export function filterWorkbenchGitBranches(
  branches: readonly WorkspaceGitBranch[],
  search: string
): WorkspaceGitBranch[] {
  const needle = search.trim().toLocaleLowerCase()
  if (!needle) return [...branches]
  return branches.filter((branch) => branch.name.toLocaleLowerCase().includes(needle))
}

function sortBranchTree(nodes: WorkbenchGitBranchTreeNode[]): WorkbenchGitBranchTreeNode[] {
  for (const node of nodes) sortBranchTree(node.children)
  // 目录在前、分支在后，各自按名字排。
  return nodes.sort((left, right) => {
    const leftIsFolder = left.children.length > 0
    const rightIsFolder = right.children.length > 0
    if (leftIsFolder !== rightIsFolder) return leftIsFolder ? -1 : 1
    return left.segment.localeCompare(right.segment)
  })
}

/** 把分支按名字里的 `/` 排成树：`feature/login`、`feature/signup` 收在 `feature` 目录下。 */
export function buildWorkbenchGitBranchTree(
  branches: readonly WorkspaceGitBranch[],
  namespace: WorkbenchGitBranchNamespace
): WorkbenchGitBranchTreeNode[] {
  const roots: WorkbenchGitBranchTreeNode[] = []
  for (const branch of branches) {
    let level = roots
    let path = ''
    const segments = branch.name.split('/').filter(Boolean)
    segments.forEach((segment, index) => {
      path = path ? `${path}/${segment}` : segment
      let node = level.find((candidate) => candidate.segment === segment)
      if (!node) {
        node = { key: `${namespace}:${path}`, segment, branch: null, children: [] }
        level.push(node)
      }
      if (index === segments.length - 1) node.branch = branch
      level = node.children
    })
  }
  return sortBranchTree(roots)
}

/** 签出一个分支要交给 git 的东西。 */
export interface WorkbenchGitBranchSwitchTarget {
  branch: string
  /** 远端分支在本地还没有对应的分支：从它新建一个同名的本地分支再切过去。 */
  options?: { create: true; startPoint: string }
}

/**
 * 点一个分支要切到哪：本地分支就是它自己；远端分支（`origin/feature/x`）切到同名的本地分支
 * （`feature/x`），本地还没有就从远端分支新建。
 */
export function resolveWorkbenchGitBranchSwitch(
  branch: Pick<WorkspaceGitBranch, 'name' | 'kind'>,
  branches: ReadonlyArray<Pick<WorkspaceGitBranch, 'name' | 'kind'>>
): WorkbenchGitBranchSwitchTarget {
  if (!isWorkbenchGitRemoteBranch(branch)) return { branch: branch.name }
  const slash = branch.name.indexOf('/')
  const localName =
    slash >= 0 && slash < branch.name.length - 1 ? branch.name.slice(slash + 1) : branch.name
  const localExists = branches.some(
    (candidate) => !isWorkbenchGitRemoteBranch(candidate) && candidate.name === localName
  )
  return localExists
    ? { branch: localName }
    : { branch: localName, options: { create: true, startPoint: branch.name } }
}

/**
 * 合并、变基、拣选、撤销进行到一半时，分支菜单里为什么按不了：这时该去提交面板继续或放弃，不是切分支、
 * 拉取、推送。没有进行到一半的操作为 null。
 */
export function describeWorkbenchGitOperationBlock(
  operation: Nullable<Pick<WorkspaceGitOperationState, 'kind'>>,
  t: Translate
): Nullable<string> {
  return operation
    ? t('workbench.gitOperationBlocksBranchMenu', {
        operation: getWorkbenchGitOperationName(operation.kind, t),
      })
    : null
}

/**
 * 顶栏按钮上写的 HEAD。变基时 git 把 HEAD 从分支上摘下来，直接写「分离的 HEAD」会让人以为该去切分支：
 * 写成「feature（变基中）」。其余照 {@link describeWorkbenchGitHead}。
 */
export function describeWorkbenchGitBranchControlHead(
  status: Pick<WorkspaceGitStatusResult, 'branch' | 'detachedHead'>,
  operation: Nullable<Pick<WorkspaceGitOperationState, 'kind' | 'detail'>>,
  t: Translate
): Nullable<string> {
  if (!status.branch && operation?.kind === 'rebase' && operation.detail)
    return t('workbench.gitHeadRebasing', { branch: operation.detail })
  return describeWorkbenchGitHead(status, t)
}

/**
 * 分支菜单里的四个远端操作：拉取、推送、同步、获取远端。拉取、同步要有上游；还没有上游时推送会顺便关联
 * 远端分支；分离的 HEAD 上没有当前分支，只有获取远端（它不看分支）还能用，其余写明原因。有操作进行到一半
 * 时（`blocked` 是那句原因）同样只留获取远端。
 */
export function describeWorkbenchGitRemoteActions(
  status: WorkbenchGitBranchControlStatus,
  t: Translate,
  blocked: Nullable<string> = null
): WorkbenchGitRemoteActionItem[] {
  const detached = !status.branch
  // 进行到一半的操作排在前面说：变基时 HEAD 也是分离的，这时讲「先切到一个分支」是错的。
  const unavailable =
    blocked ??
    (detached
      ? t('workbench.gitDetachedHeadReason', { sha: status.detachedHead?.shortSha ?? '' })
      : null)
  const { upstream } = status
  const needsUpstream = (hint: string): string =>
    unavailable ?? (upstream ? hint : t('workbench.gitNoUpstreamHint'))

  return [
    {
      action: 'pull',
      label: t('workbench.gitPull'),
      hint: needsUpstream(t('workbench.gitPullHint', { upstream: upstream ?? '' })),
      disabled: !!unavailable || !upstream,
      count: upstream ? status.behind : 0,
    },
    {
      action: 'upload',
      label: t('workbench.gitUpload'),
      hint:
        unavailable ??
        (upstream ? t('workbench.gitPushHint', { upstream }) : t('workbench.gitPublishHint')),
      disabled: !!unavailable,
      count: upstream ? status.ahead : 0,
    },
    {
      action: 'sync',
      label: t('workbench.gitSync'),
      hint: needsUpstream(t('workbench.gitSyncHint')),
      disabled: !!unavailable || !upstream,
      count: 0,
    },
    {
      action: 'fetch',
      label: t('workbench.gitFetch'),
      hint: t('workbench.gitFetchHint'),
      disabled: false,
      count: 0,
    },
  ]
}

/**
 * 远端操作下面那一行小字：为什么有的按不了。有上游时不用说（数字已经在按钮上了），为 null。
 */
export function describeWorkbenchGitRemoteNote(
  status: WorkbenchGitBranchControlStatus,
  t: Translate,
  blocked: Nullable<string> = null
): Nullable<string> {
  if (blocked) return blocked
  if (!status.branch)
    return t('workbench.gitDetachedHeadReason', { sha: status.detachedHead?.shortSha ?? '' })
  return status.upstream ? null : t('workbench.gitNoUpstreamNote')
}

/**
 * 顶栏按钮悬停时的说明：工作区有没有改动，以及和上游差几个提交（还没有上游、分离的 HEAD 时说这个）。
 */
export function describeWorkbenchGitBranchControl(
  status: Pick<
    WorkspaceGitStatusResult,
    'branch' | 'upstream' | 'ahead' | 'behind' | 'isClean' | 'changedFiles'
  >,
  t: Translate
): string {
  const changes = status.isClean
    ? t('workbench.gitClean')
    : t('workbench.gitChangedFiles', { count: status.changedFiles })
  if (!status.branch) return changes
  const remote = status.upstream
    ? t('workbench.gitBranchAheadBehind', {
        upstream: status.upstream,
        behind: status.behind,
        ahead: status.ahead,
      })
    : t('workbench.gitNoUpstreamHint')
  return `${changes} · ${remote}`
}
