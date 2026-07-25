import { optionalWhenLazy } from '@velaros-ai/core'
import type { WorkbenchDirectoryEntry } from '@velaros-ai/core/types'
import {
  type FilePresentationVariant,
  getFilePresentationVariant,
} from '@velaros-ai/ui/utils/filePresentation'

import { ROOT_PATH } from '../shared/workbenchUtils'

export interface FileTreeNodeData {
  id: string
  name: string
  entry: WorkbenchDirectoryEntry
  fileKind: Nullable<FilePresentationVariant>
  children?: FileTreeNodeData[]
}

export const ROW_HEIGHT = 23
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
      fileKind: isDirectory ? null : getFilePresentationVariant({ fileName: entry.name }),
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

export function getDefaultCreateName(
  type: WorkbenchDirectoryEntry['type'],
  parentEntry: Nullable<WorkbenchDirectoryEntry>,
  childrenByPath: Map<string, WorkbenchDirectoryEntry[]>
): string {
  const parentPath = parentEntry?.path ?? ROOT_PATH
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
