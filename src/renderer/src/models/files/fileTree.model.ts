import { optionalWhenLazy } from '@velaros-ai/core'

import type { WorkbenchDirectoryEntry } from '@shared/contracts'

import { getParentPath, isSameOrChildPath, ROOT_PATH } from '../shared/workbenchUtils'

import {
  getWorkbenchFilePresentationVariant,
  type WorkbenchFilePresentationVariant,
} from './workbenchFilePresentation'

export interface FileTreeNodeData {
  id: string
  name: string
  entry: WorkbenchDirectoryEntry
  fileKind: Nullable<WorkbenchFilePresentationVariant>
  children?: FileTreeNodeData[]
}

/** 目标在工程外或已不存在的符号链接：树里只显示链接本身，不展开、不打开、不挂到聊天里。 */
export function isUnresolvedTreeSymlink(entry: Pick<WorkbenchDirectoryEntry, 'symlink'>): boolean {
  return !!entry.symlink && entry.symlink.targetState !== 'inside'
}

export const TREE_INDENT = 16
export const TREE_OVERSCAN_COUNT = 8
export const DEFAULT_TREE_WIDTH = 280

export function buildTreeNodes(
  entries: WorkbenchDirectoryEntry[],
  childrenByPath: Map<string, WorkbenchDirectoryEntry[]>,
  expandedPaths: ReadonlySet<string>
): FileTreeNodeData[] {
  return entries.map((entry) => {
    const isDirectory = entry.type === 'directory'
    const childEntries =
      isDirectory && expandedPaths.has(entry.path) ? (childrenByPath.get(entry.path) ?? []) : []

    return {
      id: entry.path,
      name: entry.name,
      entry,
      fileKind: isDirectory
        ? null
        : getWorkbenchFilePresentationVariant({ fileName: entry.name }),
      // 折叠目录仍保留空 children 以维持可展开节点语义，但不把已缓存的整棵子树交给 Arborist 建模。
      children: optionalWhenLazy(isDirectory, () =>
        buildTreeNodes(childEntries, childrenByPath, expandedPaths)
      ),
    }
  })
}

export function createOpenState(expandedPaths: Set<string>): Record<string, boolean> {
  const openState: Record<string, boolean> = {}
  expandedPaths.forEach((path) => {
    openState[path] = true
  })
  return openState
}

/**
 * 右键菜单里「新建」落在哪个目录：点在目录上建在它里面，点在文件上建在它旁边，
 * 工程根（`.`）建在根目录。
 */
export function resolveTreeCreateDirectoryPath(anchorEntry: WorkbenchDirectoryEntry): string {
  return anchorEntry.type === 'directory' ? anchorEntry.path : getParentPath(anchorEntry.path)
}

/** Arborist 行内改名的结果（与它的 `EditResult` 同形）。 */
export type FileTreeEditResult = { cancelled: true } | { cancelled: false; value: string }

/**
 * 行内改名之后这一项的路径：提交了新名字就是同目录下的新名字，
 * 取消了或名字不能用（空、带路径分隔符）就还是原来的路径。
 */
export function resolveEditedTreeEntryPath(path: string, result: FileTreeEditResult): string {
  if (result.cancelled) return path

  const name = result.value.trim()
  if (!name || /[\\/]/u.test(name)) return path

  const parentPath = getParentPath(path)
  return parentPath === ROOT_PATH ? name : `${parentPath}/${name}`
}

export function getDefaultCreateName(
  type: WorkbenchDirectoryEntry['type'],
  parentPath: string,
  childrenByPath: Map<string, WorkbenchDirectoryEntry[]>
): string {
  const siblingNames = new Set((childrenByPath.get(parentPath) ?? []).map((entry) => entry.name))
  const baseName = type === 'file' ? 'untitled' : 'new-folder'
  const extension = type === 'file' ? '.txt' : ''
  const firstName = `${baseName}${extension}`

  if (!siblingNames.has(firstName)) return firstName

  for (let index = 2; index < 1000; index += 1) {
    const candidate = `${baseName}-${index}${extension}`
    if (!siblingNames.has(candidate)) return candidate
  }

  return `${baseName}-${Date.now()}${extension}`
}

/**
 * Arborist 放下时给的父节点。拖到顶层条目之间或列表空白处时，它是 Arborist 自己的内部根节点：
 * `isRoot` 为 true，数据里没有条目。
 */
export interface FileTreeDropNode {
  isRoot: boolean
  data: { entry?: WorkbenchDirectoryEntry }
}

/** 放下的目标目录：内部根节点就是工程根目录；落点不是目录时为 null。 */
export function resolveTreeDropDirectoryPath(
  parentNode: Nullable<FileTreeDropNode>
): Nullable<string> {
  if (!parentNode) return null
  if (parentNode.isRoot) return ROOT_PATH

  const entry = parentNode.data.entry
  return entry?.type === 'directory' ? entry.path : null
}

/**
 * 能不能放在这里：目标得是目录，目录不能放进它自己或它的子目录；拖的全都本来就在这个目录里时，
 * 放下去什么也不会发生（树按名字排序，同一目录里挪位置没有意义），也不接。
 */
export function canDropTreeEntries(
  parentNode: Nullable<FileTreeDropNode>,
  dragNodes: readonly FileTreeDropNode[]
): boolean {
  const targetPath = resolveTreeDropDirectoryPath(parentNode)
  if (targetPath === null || dragNodes.length === 0) return false

  const draggedPaths: string[] = []
  for (const node of dragNodes) {
    const path = node.data.entry?.path
    if (!path || path === ROOT_PATH || isSameOrChildPath(targetPath, path)) return false
    draggedPaths.push(path)
  }

  return draggedPaths.some((path) => getParentPath(path) !== targetPath)
}
