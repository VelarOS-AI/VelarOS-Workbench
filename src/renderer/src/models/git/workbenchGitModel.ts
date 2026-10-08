import { type WorkspaceGitFileStatusEntry } from '@shared/contracts/system'
import { isWorkspaceGitConflictEntry } from '@shared/workbenchGit'

import { type WorkbenchI18nContextValue } from '../../i18n/WorkbenchLocalizationProvider'

/**
 * 一个文件的改动落在哪一侧：`staged` 暂存区相对 HEAD，`unstaged` 工作区相对暂存区，`untracked` 未跟踪，
 * `conflicted` 还没解决的合并冲突。暂存了一部分的文件两侧各有一条。
 */
export type WorkbenchGitChangeGroupId = 'conflicted' | 'staged' | 'unstaged' | 'untracked'
export type WorkbenchGitDecorationTone = 'added' | 'modified' | 'untracked' | 'conflicted'

export interface WorkbenchGitChangeItem extends WorkspaceGitFileStatusEntry {
  fileName: string
  group: WorkbenchGitChangeGroupId
  /** 这一侧的状态字母（暂存区一侧看 indexStatus，工作区一侧看 workTreeStatus）。 */
  statusCode: string
}

export interface WorkbenchOpenDiffOptions {
  focusFirstChange?: boolean
}

export interface WorkbenchGitPathDecoration {
  group: WorkbenchGitChangeGroupId
  statusCode: string
  isDirectory: boolean
  tone: WorkbenchGitDecorationTone
}

export type WorkbenchGitDecorationMap = Map<string, WorkbenchGitPathDecoration>

export const EMPTY_WORKBENCH_GIT_DECORATIONS: WorkbenchGitDecorationMap = new Map()

const StatusOrder: Record<WorkbenchGitChangeGroupId, number> = {
  conflicted: 0,
  staged: 1,
  unstaged: 2,
  untracked: 3,
}

/** 目录取它下面最要紧的那个：有冲突的目录显示成冲突。 */
const ToneOrder: Record<WorkbenchGitDecorationTone, number> = {
  modified: 0,
  added: 1,
  untracked: 2,
  conflicted: 3,
}

function fileNameFromPath(path: string): string {
  return path.split('/').filter(Boolean).at(-1) ?? path
}

export function getWorkbenchGitChangeDisplayPath(item: WorkspaceGitFileStatusEntry): string {
  return item.originalPath ? `${item.originalPath} -> ${item.path}` : item.path
}

export function getWorkbenchGitChangeItemKey(item: WorkbenchGitChangeItem): string {
  return [
    item.path,
    item.originalPath ?? '',
    item.group,
    item.statusCode,
    item.indexStatus,
    item.workTreeStatus,
  ].join('\0')
}

export function isSameWorkbenchGitChangeItem(
  left: LooseOptional<WorkbenchGitChangeItem>,
  right: LooseOptional<WorkbenchGitChangeItem>
): boolean {
  return (
    !!left && !!right && getWorkbenchGitChangeItemKey(left) === getWorkbenchGitChangeItemKey(right)
  )
}

function readStatusCode(entry: WorkspaceGitFileStatusEntry): string {
  const index = entry.indexStatus === ' ' ? '' : entry.indexStatus
  const workTree = entry.workTreeStatus === ' ' ? '' : entry.workTreeStatus
  return `${index}${workTree}` || 'M'
}

/** 一条状态落在哪几侧：冲突、未跟踪各一条；暂存区与工作区都有改动时两侧各一条。 */
function buildEntryChangeItems(entry: WorkspaceGitFileStatusEntry): WorkbenchGitChangeItem[] {
  const fileName = fileNameFromPath(entry.path)
  if (isWorkspaceGitConflictEntry(entry))
    return [{ ...entry, fileName, group: 'conflicted', statusCode: readStatusCode(entry) }]
  if (entry.indexStatus === '?' || entry.workTreeStatus === '?')
    return [{ ...entry, fileName, group: 'untracked', statusCode: readStatusCode(entry) }]

  const items: WorkbenchGitChangeItem[] = []
  if (entry.indexStatus.trim())
    items.push({ ...entry, fileName, group: 'staged', statusCode: entry.indexStatus })
  if (entry.workTreeStatus.trim() || items.length === 0) {
    // 工作区这一侧对照的是暂存区里（改名之后）的路径，不再带改名前的路径。
    const { originalPath: _originalPath, ...unstaged } = entry
    items.push({
      ...unstaged,
      fileName,
      group: 'unstaged',
      statusCode: entry.workTreeStatus.trim() || 'M',
    })
  }
  return items
}

function getPathAncestors(path: string): string[] {
  const parts = path.split('/').filter((value) => !!value)
  const ancestors: string[] = []

  for (let index = 1; index < parts.length; index += 1) {
    ancestors.push(parts.slice(0, index).join('/'))
  }

  return ancestors
}

function mergeGroup(
  current: WorkbenchGitChangeGroupId,
  incoming: WorkbenchGitChangeGroupId
): WorkbenchGitChangeGroupId {
  return StatusOrder[incoming] > StatusOrder[current] ? incoming : current
}

export function getWorkbenchGitChangeItemTone(
  item: WorkbenchGitChangeItem
): WorkbenchGitDecorationTone {
  if (item.group === 'conflicted') return 'conflicted'

  if (item.group === 'untracked') return 'untracked'

  if (item.indexStatus === 'A' || item.workTreeStatus === 'A') return 'added'

  return 'modified'
}

function mergeTone(
  current: WorkbenchGitDecorationTone,
  incoming: WorkbenchGitDecorationTone
): WorkbenchGitDecorationTone {
  return ToneOrder[incoming] > ToneOrder[current] ? incoming : current
}

function hasOnlyGroup(items: WorkbenchGitChangeItem[], group: WorkbenchGitChangeGroupId): boolean {
  return items.length > 0 && items.every((item) => item.group === group)
}

export function buildWorkbenchGitChangeItems(
  entries: WorkspaceGitFileStatusEntry[]
): WorkbenchGitChangeItem[] {
  return entries
    .flatMap((entry) => buildEntryChangeItems(entry))
    .sort(
      (left, right) =>
        StatusOrder[left.group] - StatusOrder[right.group] ||
        left.path.localeCompare(right.path, 'en')
    )
}

/**
 * 提交说明输入框里的草稿（占位文字），按这次会提交的文件拟。字从文案表出（`t`），跟着界面语言走。
 */
export function buildWorkbenchGitCommitDraft(
  changeItems: WorkbenchGitChangeItem[],
  t: WorkbenchI18nContextValue['t']
): string {
  // 暂存了一部分的文件两侧各一条，按文件算。
  const seenPaths = new Set<string>()
  const items: WorkbenchGitChangeItem[] = []
  for (const item of changeItems) {
    if (seenPaths.has(item.path)) continue
    seenPaths.add(item.path)
    items.push(item)
  }
  if (items.length === 0) return ''

  if (items.length === 1) {
    const [item] = items
    const file = item.fileName
    if (item.group === 'untracked') return t('workbench.gitCommitDraftAdd', { file })

    if (item.indexStatus === 'D' || item.workTreeStatus === 'D')
      return t('workbench.gitCommitDraftRemove', { file })

    return t('workbench.gitCommitDraftUpdate', { file })
  }

  if (hasOnlyGroup(items, 'untracked'))
    return t('workbench.gitCommitDraftAddFiles', { count: items.length })

  const firstDirectory = items[0]?.path.split('/')[0] ?? ''
  const sharedDirectory =
    firstDirectory && items.every((item) => item.path.split('/')[0] === firstDirectory)
      ? firstDirectory
      : null

  if (sharedDirectory)
    return t('workbench.gitCommitDraftUpdateDirectory', { directory: sharedDirectory })

  return t('workbench.gitCommitDraftUpdateFiles', { count: items.length })
}

export function buildWorkbenchGitDecorationMap(
  items: WorkbenchGitChangeItem[]
): WorkbenchGitDecorationMap {
  const decorations: WorkbenchGitDecorationMap = new Map()

  for (const item of items) {
    const tone = getWorkbenchGitChangeItemTone(item)
    // 暂存了一部分的文件两侧各一条：文件本身只记一次，取两侧里更要紧的颜色。
    const existing = decorations.get(item.path)
    decorations.set(item.path, {
      group: existing ? mergeGroup(existing.group, item.group) : item.group,
      statusCode: readStatusCode(item),
      isDirectory: false,
      tone: existing ? mergeTone(existing.tone, tone) : tone,
    })

    for (const ancestor of getPathAncestors(item.path)) {
      const current = decorations.get(ancestor)
      decorations.set(ancestor, {
        group: current ? mergeGroup(current.group, item.group) : item.group,
        statusCode: '•',
        isDirectory: true,
        tone: current ? mergeTone(current.tone, tone) : tone,
      })
    }
  }

  return decorations
}
