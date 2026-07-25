import type { WorkbenchDirectoryEntry } from '@velaros-ai/core/types'

import type { WorkbenchContentSearchMatch } from './workbenchContentSearchModel'

export type WorkbenchFileSearchNavigationItem =
  | {
      id: string
      kind: 'entry'
      entry: WorkbenchDirectoryEntry
    }
  | {
      id: string
      kind: 'content'
      match: WorkbenchContentSearchMatch
    }

export type WorkbenchFileSearchKeyboardAction =
  | { kind: 'open-active' }
  | { kind: 'set-active'; index: number }

export function buildWorkbenchFileSearchNavigationItems(
  entries: WorkbenchDirectoryEntry[],
  contentMatches: WorkbenchContentSearchMatch[]
): WorkbenchFileSearchNavigationItem[] {
  return [
    ...entries.map(
      (entry): WorkbenchFileSearchNavigationItem => ({
        id: `entry:${entry.path}`,
        kind: 'entry',
        entry,
      })
    ),
    ...contentMatches.map(
      (match): WorkbenchFileSearchNavigationItem => ({
        id: `content:${match.id}`,
        kind: 'content',
        match,
      })
    ),
  ]
}

export function getWorkbenchFileSearchKeyboardAction(
  key: string,
  activeIndex: number,
  itemCount: number
): Nullable<WorkbenchFileSearchKeyboardAction> {
  if (!itemCount) return null

  switch (key) {
    case 'ArrowDown': {
      return { kind: 'set-active', index: (activeIndex + 1) % itemCount }
    }
    case 'ArrowUp': {
      return { kind: 'set-active', index: (activeIndex + itemCount - 1) % itemCount }
    }
    case 'Home': {
      return { kind: 'set-active', index: 0 }
    }
    case 'End': {
      return { kind: 'set-active', index: itemCount - 1 }
    }
    case 'Enter': {
      return { kind: 'open-active' }
    }
    default: {
      return null
    }
  }
}
