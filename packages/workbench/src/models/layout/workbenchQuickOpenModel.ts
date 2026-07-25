import { isEmpty } from '@velaros-ai/core'

import type { WorkbenchOpenEditorTab } from '../../types/workbenchTypes'
import type { WorkbenchProjectContextFile } from '../project/workbenchProjectContextIndex'
import { fileLanguage } from '../shared/workbenchUtils'

const DEFAULT_QUICK_OPEN_LIMIT = 12

export interface QuickOpenItem {
  path: string
  name: string
  language: string
  isOpen: boolean
  score: number
}

function normalizeQuery(query: string): string[] {
  return query
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter((token) => !isEmpty(token))
}

function isSubsequence(needle: string, haystack: string): boolean {
  let cursor = 0

  for (const char of haystack) {
    if (char === needle[cursor]) {
      cursor += 1
    }

    if (cursor === needle.length) return true
  }

  return isEmpty(needle)
}

function scoreToken(token: string, name: string, path: string): number {
  if (name === token) return 120

  if (name.startsWith(token)) return 90

  if (name.includes(token)) return 70

  if (path.includes(token)) return 40

  if (isSubsequence(token, path)) return 12

  return -1
}

export function buildQuickOpenItems({
  files,
  openTabs,
  query,
  limit = DEFAULT_QUICK_OPEN_LIMIT,
}: {
  files: WorkbenchProjectContextFile[]
  openTabs: WorkbenchOpenEditorTab[]
  query: string
  limit?: number
}): QuickOpenItem[] {
  const openPaths = new Set(openTabs.map((tab) => tab.path))
  const filesByPath = new Map(files.map((file) => [file.path, file]))

  for (const tab of openTabs) {
    if (!filesByPath.has(tab.path)) {
      filesByPath.set(tab.path, {
        path: tab.path,
        name: tab.path.split('/').at(-1) ?? tab.path,
        language: fileLanguage(tab.path),
      })
    }
  }

  const tokens = normalizeQuery(query)
  const items: QuickOpenItem[] = []

  for (const file of filesByPath.values()) {
    const normalizedName = file.name.toLowerCase()
    const normalizedPath = file.path.toLowerCase()
    const tokenScore = tokens.reduce((total, token) => {
      if (total < 0) return total

      const score = scoreToken(token, normalizedName, normalizedPath)
      return score < 0 ? -1 : total + score
    }, 0)

    if (tokenScore < 0) {
      continue
    }

    const isOpen = openPaths.has(file.path)
    items.push({
      path: file.path,
      name: file.name,
      language: file.language,
      isOpen,
      score: tokenScore + (isOpen ? 8 : 0),
    })
  }

  return items
    .sort(
      (left, right) =>
        right.score - left.score ||
        +right.isOpen - +left.isOpen ||
        left.name.length - right.name.length ||
        left.path.length - right.path.length ||
        left.path.localeCompare(right.path)
    )
    .slice(0, Math.max(1, limit))
}
