import { isEmpty } from '@velaros-ai/core'

import { type WorkbenchDirectoryEntry } from '@shared/contracts/workbench'

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

  const fileName = path.split(/[\\/]/).at(-1)?.toLowerCase() ?? ''
  if (fileName === 'dockerfile' || fileName === 'containerfile') return 'Dockerfile'
  if (fileName === 'cargo.lock') return 'TOML'
  if (fileName === '.bashrc' || fileName === '.profile' || fileName === '.zshrc') return 'Shell'
  if (fileName === '.env' || fileName.startsWith('.env.')) return 'Environment'
  if (fileName === '.gitignore') return 'Git Ignore'

  const extension = path.split('.').at(-1)?.toLowerCase()
  switch (extension) {
    case 'ts':
    case 'tsx':
      return 'TypeScript'
    case 'js':
    case 'jsx':
      return 'JavaScript'
    case 'json':
    case 'jsonc':
      return 'JSON'
    case 'css':
      return 'CSS'
    case 'md':
    case 'markdown':
    case 'mdown':
    case 'mdx':
      return 'Markdown'
    case 'yaml':
    case 'yml':
      return 'YAML'
    case 'atom':
    case 'plist':
    case 'rss':
    case 'svg':
    case 'xml':
    case 'xsd':
    case 'xsl':
    case 'xslt':
      return 'XML'
    case 'sql':
      return 'SQL'
    case 'toml':
      return 'TOML'
    case 'bash':
    case 'sh':
    case 'zsh':
      return 'Shell'
    case 'cfg':
    case 'ini':
    case 'properties':
      return 'Properties'
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

/**
 * `path` 是 `parentPath` 本身或在它里面。工程根（`.`）包含一切：
 * 文件监听说「整个根目录都可能变了」时报的就是它，打开的每个文件都要重读。
 */
export function isSameOrChildPath(path: string, parentPath: string): boolean {
  return parentPath === ROOT_PATH || path === parentPath || path.startsWith(`${parentPath}/`)
}
