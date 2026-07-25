import { isEmpty } from '@velaros/core'
import type { WorkbenchDirectoryEntry } from '@velaros/core/types'

import type { WorkbenchProject } from '../project/workbenchProjects'

export const ROOT_PATH = '.'

/** 文件树中的合成项目根行，路径始终为根路径常量。 */
export function isWorkbenchTreeRoot(entry: Pick<WorkbenchDirectoryEntry, 'path'>): boolean {
  return entry.path === ROOT_PATH
}

export function sortProjects(projects: WorkbenchProject[]): WorkbenchProject[] {
  return [...projects].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1

    return (b.lastOpenedAt ?? b.createdAt) - (a.lastOpenedAt ?? a.createdAt)
  })
}

export function fileLanguage(path: Nullable<string>): string {
  if (!path) return ''

  const extension = path.split('.').at(-1)?.toLowerCase()
  switch (extension) {
    case 'ts':
    case 'tsx':
      return 'TypeScript'
    case 'js':
    case 'jsx':
      return 'JavaScript'
    case 'json':
      return 'JSON'
    case 'css':
      return 'CSS'
    case 'md':
    case 'mdx':
      return 'Markdown'
    default:
      return extension ? extension.toUpperCase() : 'Text'
  }
}

export function findEntryByPath(
  childrenByPath: Map<string, WorkbenchDirectoryEntry[]>,
  path: Nullable<string>
): Nullable<WorkbenchDirectoryEntry> {
  if (!path) return null

  for (const entries of childrenByPath.values()) {
    const entry = entries.find((candidate) => candidate.path === path)
    if (entry) return entry
  }

  return null
}

export function getParentPath(path: string): string {
  if (path === ROOT_PATH) return ROOT_PATH

  const segments = path.split('/').filter((value) => !!value)
  segments.pop()
  return !isEmpty(segments) ? segments.join('/') : ROOT_PATH
}

export function isSameOrChildPath(path: string, parentPath: string): boolean {
  return path === parentPath || path.startsWith(`${parentPath}/`)
}
