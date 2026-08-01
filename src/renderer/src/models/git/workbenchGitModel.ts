import type { AppLocale, WorkspaceGitFileStatusEntry } from '@shared/contracts'

export type WorkbenchGitChangeGroupId = 'staged' | 'unstaged' | 'untracked'
export type WorkbenchGitDecorationTone = 'added' | 'modified' | 'untracked'

export interface WorkbenchGitChangeItem extends WorkspaceGitFileStatusEntry {
  fileName: string
  group: WorkbenchGitChangeGroupId
  statusCode: string
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
  staged: 0,
  unstaged: 1,
  untracked: 2,
}

const ToneOrder: Record<WorkbenchGitDecorationTone, number> = {
  modified: 0,
  added: 1,
  untracked: 2,
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

function getChangeGroup(entry: WorkspaceGitFileStatusEntry): WorkbenchGitChangeGroupId {
  if (entry.indexStatus === '?' || entry.workTreeStatus === '?') return 'untracked'

  if (entry.indexStatus.trim()) return 'staged'

  return 'unstaged'
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
    .map((entry) => ({
      ...entry,
      fileName: fileNameFromPath(entry.path),
      group: getChangeGroup(entry),
      statusCode: readStatusCode(entry),
    }))
    .sort(
      (left, right) =>
        StatusOrder[left.group] - StatusOrder[right.group] ||
        left.path.localeCompare(right.path, 'en')
    )
}

export function buildWorkbenchGitCommitDraft(
  items: WorkbenchGitChangeItem[],
  locale: AppLocale
): string {
  const isChinese = locale.startsWith('zh')
  if (items.length === 0) return ''

  if (items.length === 1) {
    const [item] = items
    if (item.group === 'untracked')
      return isChinese ? `添加 ${item.fileName}` : `Add ${item.fileName}`

    if (item.indexStatus === 'D' || item.workTreeStatus === 'D')
      return isChinese ? `删除 ${item.fileName}` : `Remove ${item.fileName}`

    return isChinese ? `更新 ${item.fileName}` : `Update ${item.fileName}`
  }

  if (hasOnlyGroup(items, 'untracked'))
    return isChinese ? `添加 ${items.length} 个文件` : `Add ${items.length} files`

  const firstDirectory = items[0]?.path.split('/')[0] ?? ''
  const sharedDirectory =
    firstDirectory && items.every((item) => item.path.split('/')[0] === firstDirectory)
      ? firstDirectory
      : null

  if (sharedDirectory)
    return isChinese ? `更新 ${sharedDirectory} 相关改动` : `Update ${sharedDirectory} changes`

  return isChinese ? `更新 ${items.length} 个文件` : `Update ${items.length} files`
}

export function buildWorkbenchGitDecorationMap(
  items: WorkbenchGitChangeItem[]
): WorkbenchGitDecorationMap {
  const decorations: WorkbenchGitDecorationMap = new Map()

  for (const item of items) {
    const tone = getWorkbenchGitChangeItemTone(item)
    decorations.set(item.path, {
      group: item.group,
      statusCode: item.statusCode,
      isDirectory: false,
      tone,
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
