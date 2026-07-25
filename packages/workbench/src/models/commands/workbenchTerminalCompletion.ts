import { isEmpty } from '@velaros/core'

import type { WorkbenchProjectContextFile } from '../project/workbenchProjectContextIndex'

import type { WorkbenchCommandHistoryItem } from './workbenchCommandHistory'
import type { WorkbenchRunConfiguration } from './workbenchRunConfigurations'

export interface WorkbenchTerminalCompletionSuggestion {
  value: string
  label: string
  detail: string
  replacementStart: number
}

function getCurrentToken(input: string): { token: string; start: number } {
  const beforeCursor = input
  const match = beforeCursor.match(/(?:^|\s)(["']?)([^\s"'`]*)$/)
  if (!match) return { token: beforeCursor, start: 0 }

  const token = match[2] ?? ''
  return {
    token,
    start: beforeCursor.length - token.length,
  }
}

function quotePath(path: string): string {
  return /^[\w@./:-]+$/.test(path) ? path : JSON.stringify(path)
}

function parentDirectoryPath(path: string): string {
  const slashIndex = path.lastIndexOf('/')
  if (slashIndex <= 0) return '.'
  return path.slice(0, slashIndex)
}

function scoreFileMatch(file: WorkbenchProjectContextFile, lowerToken: string): number {
  const lowerName = file.name.toLowerCase()
  const lowerPath = file.path.toLowerCase()
  if (lowerName === lowerToken) return 120
  if (lowerName.startsWith(lowerToken)) return 90
  if (lowerName.includes(lowerToken)) return 70
  if (lowerPath.includes(lowerToken)) return 40
  return -1
}

function formatFileSuggestionPresentation(
  file: WorkbenchProjectContextFile
): Pick<WorkbenchTerminalCompletionSuggestion, 'label' | 'detail'> {
  return {
    label: file.name,
    detail: parentDirectoryPath(file.path),
  }
}

function uniqueSuggestions(
  suggestions: WorkbenchTerminalCompletionSuggestion[],
  limit: number
): WorkbenchTerminalCompletionSuggestion[] {
  const seen = new Set<string>()
  const unique: WorkbenchTerminalCompletionSuggestion[] = []

  for (const suggestion of suggestions) {
    const key = `${suggestion.replacementStart}:${suggestion.value}`
    if (seen.has(key)) {
      continue
    }

    seen.add(key)
    unique.push(suggestion)
    if (unique.length >= limit) {
      break
    }
  }

  return unique
}

export function buildWorkbenchTerminalCompletionSuggestions({
  commandHistory,
  files,
  input,
  runConfigurations,
  limit = 8,
}: {
  commandHistory: WorkbenchCommandHistoryItem[]
  files: WorkbenchProjectContextFile[]
  input: string
  runConfigurations: WorkbenchRunConfiguration[]
  limit?: number
}): WorkbenchTerminalCompletionSuggestion[] {
  const trimmedInput = input.trimStart()
  const lowerInput = trimmedInput.toLowerCase()
  const token = getCurrentToken(input)
  const lowerToken = token.token.toLowerCase()
  const suggestions: WorkbenchTerminalCompletionSuggestion[] = []

  if (!trimmedInput || !input.includes(' ')) {
    runConfigurations.forEach((configuration) => {
      if (!lowerInput || configuration.command.toLowerCase().includes(lowerInput)) {
        suggestions.push({
          value: configuration.command,
          label: configuration.label,
          detail: configuration.source,
          replacementStart: 0,
        })
      }
    })

    commandHistory.forEach((item) => {
      if (!lowerInput || item.command.toLowerCase().includes(lowerInput)) {
        suggestions.push({
          value: item.command,
          label: item.command,
          detail: 'history',
          replacementStart: 0,
        })
      }
    })
  }

  if (!isEmpty(lowerToken)) {
    files
      .map((file) => ({ file, score: scoreFileMatch(file, lowerToken) }))
      .filter((entry) => entry.score >= 0)
      .sort(
        (left, right) =>
          right.score - left.score ||
          left.file.path.length - right.file.path.length ||
          left.file.path.localeCompare(right.file.path)
      )
      .slice(0, limit)
      .forEach(({ file }) => {
        const presentation = formatFileSuggestionPresentation(file)
        suggestions.push({
          value: quotePath(file.path),
          label: presentation.label,
          detail: presentation.detail,
          replacementStart: token.start,
        })
      })
  }

  return uniqueSuggestions(suggestions, limit)
}

export function applyWorkbenchTerminalCompletion(
  input: string,
  suggestion: WorkbenchTerminalCompletionSuggestion
): string {
  return `${input.slice(0, suggestion.replacementStart)}${suggestion.value}`
}
