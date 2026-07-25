import type { SystemWorkspaceGitDiffResult, WorkspaceGitLogEntry } from '@velaros/core/types'

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
