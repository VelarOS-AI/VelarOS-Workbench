import type { SystemWorkspaceGitDiffResult, WorkspaceGitLogEntry } from '@shared/contracts'

import type { WorkbenchI18nContextValue } from '../../i18n'

import {
  getWorkbenchGitChangeDisplayPath,
  type WorkbenchGitChangeGroupId,
  type WorkbenchGitChangeItem,
} from './workbenchGitModel'

export const WORKBENCH_GIT_CHANGE_GROUPS: WorkbenchGitChangeGroupId[] = [
  'staged',
  'unstaged',
  'untracked',
]

export function workbenchGitChangeGroupLabel(
  group: WorkbenchGitChangeGroupId,
  t: WorkbenchI18nContextValue['t']
): string {
  switch (group) {
    case 'staged': {
      return t('workbench.gitGroupStaged')
    }
    case 'untracked': {
      return t('workbench.gitGroupUntracked')
    }
    default: {
      return t('workbench.gitGroupUnstaged')
    }
  }
}

export function workbenchGitChangeStatusTitle(item: WorkbenchGitChangeItem): string {
  return `${item.indexStatus}${item.workTreeStatus} ${getWorkbenchGitChangeDisplayPath(item)}`.trim()
}

export type WorkbenchGitDiffPreviewScope = SystemWorkspaceGitDiffResult['scope'] | 'untracked'

export function workbenchGitDiffScopeLabel(
  scope: WorkbenchGitDiffPreviewScope,
  t: WorkbenchI18nContextValue['t']
): string {
  switch (scope) {
    case 'commit': {
      return t('workbench.gitDiffCommit')
    }
    case 'staged': {
      return t('workbench.gitDiffStaged')
    }
    case 'untracked': {
      return t('workbench.gitDiffUntracked')
    }
    default: {
      return t('workbench.gitDiffWorking')
    }
  }
}

export function filterWorkbenchGitLogCommits(
  commits: WorkspaceGitLogEntry[],
  logSearch: string
): WorkspaceGitLogEntry[] {
  const query = logSearch.trim().toLowerCase()
  if (!query) return commits

  return commits.filter((commit) =>
    [
      commit.sha,
      commit.shortSha,
      commit.subject,
      commit.authorName,
      commit.authorEmail ?? '',
      commit.refs.join(' '),
    ]
      .join(' ')
      .toLowerCase()
      .includes(query)
  )
}

export function formatWorkbenchGitCommitDate(locale: string, commit: WorkspaceGitLogEntry): string {
  if (!commit.authoredAt) return '-'

  return new Intl.DateTimeFormat(locale, {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(commit.authoredAt))
}

export function formatWorkbenchGitCommitRelativeDate(
  locale: string,
  commit: WorkspaceGitLogEntry,
  now = Date.now()
): string {
  if (!commit.authoredAt) return '-'

  const elapsed = Math.max(0, now - commit.authoredAt)
  const minute = 60_000
  const hour = 60 * minute
  const day = 24 * hour
  const relative = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' })

  if (elapsed < hour) return relative.format(-Math.max(1, Math.round(elapsed / minute)), 'minute')
  if (elapsed < day) return relative.format(-Math.round(elapsed / hour), 'hour')
  if (elapsed < 7 * day) return relative.format(-Math.round(elapsed / day), 'day')
  return formatWorkbenchGitCommitDate(locale, commit)
}

export type WorkbenchGitCommitDiffLineKind = 'meta' | 'hunk' | 'addition' | 'deletion' | 'context'

export interface WorkbenchGitCommitDiffLine {
  kind: WorkbenchGitCommitDiffLineKind
  text: string
}

export interface WorkbenchGitCommitDiffFile {
  path: string
  additions: number
  deletions: number
  lines: WorkbenchGitCommitDiffLine[]
}

function commitDiffLineKind(line: string): WorkbenchGitCommitDiffLineKind {
  if (line.startsWith('@@')) return 'hunk'
  if (line.startsWith('+') && !line.startsWith('+++')) return 'addition'
  if (line.startsWith('-') && !line.startsWith('---')) return 'deletion'
  if (
    line.startsWith('index ') ||
    line.startsWith('--- ') ||
    line.startsWith('+++ ') ||
    line.startsWith('new file mode ') ||
    line.startsWith('deleted file mode ') ||
    line.startsWith('similarity index ') ||
    line.startsWith('rename from ') ||
    line.startsWith('rename to ') ||
    line.startsWith('Binary files ')
  ) return 'meta'
  return 'context'
}

export function parseWorkbenchGitCommitDiff(diff: string): WorkbenchGitCommitDiffFile[] {
  if (!diff.trim()) return []

  return diff
    .split(/^diff --git /mu)
    .slice(1)
    .map((section) => {
      const lines = section.split(/\r?\n/u)
      const header = lines.shift() ?? ''
      const path = lines
        .find((line) => line.startsWith('+++ b/'))
        ?.slice('+++ b/'.length)
        ?? header.match(/^a\/(.+?) b\/(.+)$/u)?.[2]
        ?? header
      const previewLines = lines.map((line) => ({
        kind: commitDiffLineKind(line),
        text: line,
      }))
      return {
        path,
        additions: previewLines.filter((line) => line.kind === 'addition').length,
        deletions: previewLines.filter((line) => line.kind === 'deletion').length,
        lines: previewLines,
      }
    })
    .filter((file) => !!file.path)
}
