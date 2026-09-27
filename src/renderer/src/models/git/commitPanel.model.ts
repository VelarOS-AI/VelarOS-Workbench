import {
  getWorkbenchGitChangeDisplayPath,
  type WorkbenchGitChangeItem,
} from './workbenchGitModel'

export type CommitPanelGroupId = 'changed' | 'untracked'

export type CommitPanelPrimaryAction = 'commit' | 'push'

export interface CommitPanelSelectionModifiers {
  toggle?: boolean
  range?: boolean
}

export interface CommitPanelSelectionResult {
  paths: ReadonlySet<string>
  anchorPath: string
}

export interface CommitPanelContextMenuCapabilities {
  showSingleFileActions: boolean
  showAddToVersionControl: boolean
}

export function commitPanelStatusTitle(item: WorkbenchGitChangeItem): string {
  return `${item.indexStatus}${item.workTreeStatus} ${getWorkbenchGitChangeDisplayPath(item)}`.trim()
}

export interface CommitPanelItemPartition {
  tracked: WorkbenchGitChangeItem[]
  untracked: WorkbenchGitChangeItem[]
}

export function partitionCommitPanelChangeItems(
  items: readonly WorkbenchGitChangeItem[]
): CommitPanelItemPartition {
  const tracked: WorkbenchGitChangeItem[] = []
  const untracked: WorkbenchGitChangeItem[] = []
  for (const item of items) {
    if (item.group === 'untracked') {
      untracked.push(item)
    } else {
      tracked.push(item)
    }
  }
  return { tracked, untracked }
}

export interface CommitPanelGroupItems {
  id: CommitPanelGroupId
  items: WorkbenchGitChangeItem[]
}

export function buildCommitPanelGroups(
  items: readonly WorkbenchGitChangeItem[]
): CommitPanelGroupItems[] {
  const { tracked, untracked } = partitionCommitPanelChangeItems(items)
  const groups: CommitPanelGroupItems[] = []
  if (tracked.length > 0) {
    groups.push({ id: 'changed', items: tracked })
  }
  if (untracked.length > 0) {
    groups.push({ id: 'untracked', items: untracked })
  }
  return groups
}

export function deriveCommitPanelSelectedItem(
  changeItems: readonly WorkbenchGitChangeItem[],
  selectedChangePath: Nullable<string>,
  selectedFilePath: Nullable<string>
): Nullable<WorkbenchGitChangeItem> {
  const selectedChangeItem = selectedChangePath
    ? changeItems.find((item) => item.path === selectedChangePath)
    : undefined
  const selectedFileItem = selectedFilePath
    ? changeItems.find((item) => item.path === selectedFilePath)
    : undefined

  return selectedChangeItem ?? selectedFileItem ?? changeItems[0] ?? null
}

/**
 * 回滚的对象只能是用户明确选的：勾选了的文件；一个都没勾时是在列表里点中的那一行（`clickedItem`，
 * 不是默认高亮的那一行）；都没有就什么也不回滚。
 */
export function deriveRollbackTargetItems(
  changeItems: readonly WorkbenchGitChangeItem[],
  selectedCommitPaths: ReadonlySet<string>,
  clickedItem: Nullable<WorkbenchGitChangeItem>
): WorkbenchGitChangeItem[] {
  if (selectedCommitPaths.size)
    return changeItems.filter((item) => selectedCommitPaths.has(item.path))

  return clickedItem ? [clickedItem] : []
}

/**
 * 回滚会把它从磁盘上删掉（`git clean`，不进废纸篓）：未跟踪的文件，以及只在暂存区里新增或复制出来、
 * HEAD 里没有的文件。
 */
export function isCommitPanelRollbackDeletion(item: WorkbenchGitChangeItem): boolean {
  return (
    item.group === 'untracked' ||
    item.indexStatus === 'A' ||
    item.indexStatus === 'C' ||
    item.workTreeStatus === 'A'
  )
}

export interface CommitPanelCommitAllSummary {
  count: number
  untracked: number
}

/** 一个都没勾就点提交时先问一句：一共几个改动，其中几个是未跟踪的新文件。 */
export function summarizeCommitPanelCommitAll(
  items: readonly WorkbenchGitChangeItem[]
): CommitPanelCommitAllSummary {
  return {
    count: items.length,
    untracked: items.filter((item) => item.group === 'untracked').length,
  }
}

export function deriveSelectedCommitItems(
  changeItems: readonly WorkbenchGitChangeItem[],
  selectedCommitPaths: ReadonlySet<string>
): WorkbenchGitChangeItem[] {
  return changeItems.filter((item) => selectedCommitPaths.has(item.path))
}

export function deriveCommitPanelGitPaths(items: readonly WorkbenchGitChangeItem[]): string[] {
  const paths = new Set<string>()
  for (const item of items) {
    if (item.originalPath) {
      paths.add(item.originalPath)
    }
    paths.add(item.path)
  }
  return [...paths]
}

export function deriveVisibleCommitPanelItems(
  groups: ReadonlyArray<{ id: CommitPanelGroupId; items: readonly WorkbenchGitChangeItem[] }>,
  expandedGroups: ReadonlySet<CommitPanelGroupId>
): WorkbenchGitChangeItem[] {
  return groups.flatMap((group) => (expandedGroups.has(group.id) ? [...group.items] : []))
}

export function pruneCommitPanelSelectedPaths(
  current: ReadonlySet<string>,
  changeItems: readonly WorkbenchGitChangeItem[]
): ReadonlySet<string> {
  if (!current.size) return current

  const existingPaths = new Set(changeItems.map((item) => item.path))
  const next = new Set([...current].filter((path) => existingPaths.has(path)))
  return next.size === current.size ? current : next
}

export function resolveRelativeCommitPanelPath(
  visibleChangeItems: readonly WorkbenchGitChangeItem[],
  selectedItem: Nullable<WorkbenchGitChangeItem>,
  offset: number
): Nullable<string> {
  if (!visibleChangeItems.length) return null

  const selectedIndex = selectedItem
    ? visibleChangeItems.findIndex((item) => item.path === selectedItem.path)
    : -1
  const nextIndex =
    selectedIndex < 0
      ? offset > 0
        ? 0
        : visibleChangeItems.length - 1
      : Math.min(Math.max(selectedIndex + offset, 0), visibleChangeItems.length - 1)

  return visibleChangeItems[nextIndex]?.path ?? null
}

export function resolveCommitPanelSelection(
  visibleChangeItems: readonly WorkbenchGitChangeItem[],
  currentPaths: ReadonlySet<string>,
  anchorPath: Nullable<string>,
  targetPath: string,
  modifiers: CommitPanelSelectionModifiers = {}
): CommitPanelSelectionResult {
  if (modifiers.range && anchorPath) {
    const anchorIndex = visibleChangeItems.findIndex((item) => item.path === anchorPath)
    const targetIndex = visibleChangeItems.findIndex((item) => item.path === targetPath)
    if (anchorIndex >= 0 && targetIndex >= 0) {
      const rangePaths = visibleChangeItems
        .slice(Math.min(anchorIndex, targetIndex), Math.max(anchorIndex, targetIndex) + 1)
        .map((item) => item.path)
      return {
        paths: modifiers.toggle ? new Set([...currentPaths, ...rangePaths]) : new Set(rangePaths),
        anchorPath,
      }
    }
  }

  if (modifiers.toggle) {
    const next = new Set(currentPaths)
    if (next.has(targetPath)) {
      next.delete(targetPath)
    } else {
      next.add(targetPath)
    }
    return { paths: next, anchorPath: targetPath }
  }

  return { paths: new Set([targetPath]), anchorPath: targetPath }
}

export function deriveCommitPanelContextItems(
  changeItems: readonly WorkbenchGitChangeItem[],
  selectedPaths: ReadonlySet<string>,
  contextItem: WorkbenchGitChangeItem
): WorkbenchGitChangeItem[] {
  if (!selectedPaths.has(contextItem.path)) return [contextItem]
  return changeItems.filter((item) => selectedPaths.has(item.path))
}

export function deriveCommitPanelGroupContextItems(
  groupItems: readonly WorkbenchGitChangeItem[],
  selectedPaths: ReadonlySet<string>
): WorkbenchGitChangeItem[] {
  const selectedItems = groupItems.filter((item) => selectedPaths.has(item.path))
  return selectedItems.length === 0 ? [...groupItems] : selectedItems
}

export function resolveCommitPanelContextMenuCapabilities(
  targetKind: 'item' | 'group',
  contextItems: readonly WorkbenchGitChangeItem[]
): CommitPanelContextMenuCapabilities {
  return {
    showSingleFileActions: targetKind === 'item',
    showAddToVersionControl: contextItems.some((item) => item.group === 'untracked'),
  }
}

export function isCommitPanelEditableKeyboardTarget(
  tagName: string,
  isContentEditable: boolean
): boolean {
  return tagName === 'INPUT' || tagName === 'TEXTAREA' || tagName === 'SELECT' || isContentEditable
}
