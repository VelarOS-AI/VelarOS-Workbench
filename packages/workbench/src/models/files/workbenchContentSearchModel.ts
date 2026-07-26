import type { WorkbenchIndexedTextFile } from '../../contracts/index'
import type { WorkbenchOpenEditorTab } from '../../types/workbenchTypes'

export interface WorkbenchContentSearchMatch {
  id: string
  path: string
  fileName: string
  line: number
  column: number
  excerpt: string
  isOpen: boolean
}

const DEFAULT_CONTENT_SEARCH_LIMIT = 80
const MAX_EXCERPT_LENGTH = 140

function normalizeQuery(query: string): string {
  return query.trim().replace(/\s+/g, ' ').toLocaleLowerCase()
}

function fileNameFromPath(path: string): string {
  return path.split('/').findLast((value) => !!value) ?? path
}

function compactExcerpt(line: string, matchIndex: number, queryLength: number): string {
  const compactLine = line.replace(/\s+/g, ' ').trim()
  if (compactLine.length <= MAX_EXCERPT_LENGTH) return compactLine

  const start = Math.max(0, matchIndex - 46)
  const end = Math.min(line.length, matchIndex + queryLength + 78)
  const excerpt = line.slice(start, end).replace(/\s+/g, ' ').trim()
  return `${start > 0 ? '...' : ''}${excerpt}${end < line.length ? '...' : ''}`
}

export function mapWorkbenchContentSearchMatchResult(
  match: {
    path: string
    line: number
    column: number
    excerpt: string
  },
  options: { isOpen: boolean }
): WorkbenchContentSearchMatch {
  return {
    id: `${match.path}:${match.line}:${match.column}`,
    path: match.path,
    fileName: fileNameFromPath(match.path),
    line: match.line,
    column: match.column,
    excerpt: match.excerpt,
    isOpen: options.isOpen,
  }
}

export function mergeWorkbenchContentSearchMatches(
  openTabMatches: WorkbenchContentSearchMatch[],
  diskMatches: WorkbenchContentSearchMatch[],
  limit = DEFAULT_CONTENT_SEARCH_LIMIT
): WorkbenchContentSearchMatch[] {
  const openPaths = new Set(openTabMatches.map((match) => match.path))
  const merged = [
    ...openTabMatches,
    ...diskMatches.filter((match) => !openPaths.has(match.path)),
  ]
  const seen = new Set<string>()
  const normalizedLimit = Math.max(1, Math.min(200, Math.round(limit)))
  const unique: WorkbenchContentSearchMatch[] = []

  for (const match of merged) {
    if (seen.has(match.id)) continue

    seen.add(match.id)
    unique.push(match)
    if (unique.length >= normalizedLimit) break
  }

  return unique
}

export function buildWorkbenchContentSearchMatches({
  indexedFiles,
  openTabs,
  query,
  limit = DEFAULT_CONTENT_SEARCH_LIMIT,
}: {
  indexedFiles: WorkbenchIndexedTextFile[]
  openTabs: WorkbenchOpenEditorTab[]
  query: string
  limit?: number
}): WorkbenchContentSearchMatch[] {
  const normalizedQuery = normalizeQuery(query)
  if (!normalizedQuery) return []

  const filesByPath = new Map<
    string,
    { content: string; isOpen: boolean; modifiedAt: number; path: string }
  >()

  for (const file of indexedFiles) {
    filesByPath.set(file.path, {
      content: file.content,
      isOpen: false,
      modifiedAt: file.modifiedAt,
      path: file.path,
    })
  }

  for (const tab of openTabs) {
    filesByPath.set(tab.path, {
      content: tab.content,
      isOpen: true,
      modifiedAt: tab.file.modifiedAt,
      path: tab.path,
    })
  }

  const matches: WorkbenchContentSearchMatch[] = []
  const normalizedLimit = Math.max(1, Math.min(200, Math.round(limit)))

  for (const file of [...filesByPath.values()].sort((left, right) =>
    left.path.localeCompare(right.path, 'en')
  )) {
    if (matches.length >= normalizedLimit) {
      break
    }

    const lines = file.content.split('\n')
    for (let index = 0; index < lines.length; index += 1) {
      if (matches.length >= normalizedLimit) {
        break
      }

      const line = lines[index]
      const matchIndex = line.toLocaleLowerCase().indexOf(normalizedQuery)
      if (matchIndex === -1) {
        continue
      }

      matches.push({
        id: `${file.path}:${index + 1}:${matchIndex + 1}`,
        path: file.path,
        fileName: fileNameFromPath(file.path),
        line: index + 1,
        column: matchIndex + 1,
        excerpt: compactExcerpt(line, matchIndex, normalizedQuery.length),
        isOpen: file.isOpen,
      })
    }
  }

  return matches
}
