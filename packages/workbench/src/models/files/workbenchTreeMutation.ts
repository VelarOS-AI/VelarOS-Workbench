import type { WorkbenchDirectoryEntry } from '@velaros-ai/core/types'

import {
  getParentPath,
  isSameOrChildPath,
  ROOT_PATH,
} from '../shared/workbenchUtils'

/**
 * 文件树变更（创建 / 重命名 / 移动 / 删除）的纯逻辑模型。
 *
 * 从 `useWorkbenchMutationController` 抽出与 React 状态无关的路径推导与集合过滤，
 * 行为不变，便于复用与单测。
 */

/** 由当前选中项推导出树操作的目标父目录：目录取自身，文件取父级，否则根。 */
export function resolveTreeActionBasePath(
  selectedEntry: Nullable<WorkbenchDirectoryEntry>,
  selectedEntryPath: Nullable<string>
): string {
  if (selectedEntry?.type === 'directory') return selectedEntry.path

  if (selectedEntryPath) return getParentPath(selectedEntryPath)

  return ROOT_PATH
}

/** 针对显式传入的条目推导基准父目录；缺省时回退到当前选中项的基准。 */
export function resolveTreeActionBasePathForEntry(
  entry: Nullable<WorkbenchDirectoryEntry>,
  fallbackBasePath: string
): string {
  if (entry?.type === 'directory') return entry.path

  if (entry) return getParentPath(entry.path)

  return fallbackBasePath
}

/**
 * 过滤出可移动的条目：排除根，并剔除「已被同批次祖先目录覆盖」的冗余子项，
 * 避免父子同时移动产生的重复操作。
 */
export function selectMovableTreeEntries(
  entries: readonly WorkbenchDirectoryEntry[]
): WorkbenchDirectoryEntry[] {
  return entries
    .filter((entry) => entry.path !== ROOT_PATH)
    .filter(
      (entry, _index, allEntries) =>
        !allEntries.some(
          (candidate) =>
            candidate.path !== entry.path && isSameOrChildPath(entry.path, candidate.path)
        )
    )
}

export type WorkbenchFileTreeShortcutAction = 'delete-selected' | 'undo-delete'

interface WorkbenchFileTreeShortcutEventLike {
  altKey: boolean
  ctrlKey: boolean
  key: string
  metaKey: boolean
  shiftKey: boolean
}

export function getWorkbenchFileTreeShortcutAction(
  event: WorkbenchFileTreeShortcutEventLike
): Nullable<WorkbenchFileTreeShortcutAction> {
  if (
    event.key === 'Delete' &&
    !event.altKey &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.shiftKey
  ) return 'delete-selected'

  if (
    event.key.toLowerCase() === 'z' &&
    (event.metaKey || event.ctrlKey) &&
    !event.altKey &&
    !event.shiftKey
  ) return 'undo-delete'

  return null
}
