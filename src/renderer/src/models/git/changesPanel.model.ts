import type {
  SystemWorkspaceGitDiffResult,
  WorkspaceGitLogEntry,
  WorkspaceGitRef,
} from '@shared/contracts'

import type { WorkbenchI18nContextValue } from '../../i18n'

import {
  getWorkbenchGitChangeDisplayPath,
  type WorkbenchGitChangeGroupId,
  type WorkbenchGitChangeItem,
} from './workbenchGitModel'

export const WORKBENCH_GIT_CHANGE_GROUPS: WorkbenchGitChangeGroupId[] = [
  'conflicted',
  'staged',
  'unstaged',
  'untracked',
]

export function workbenchGitChangeGroupLabel(
  group: WorkbenchGitChangeGroupId,
  t: WorkbenchI18nContextValue['t']
): string {
  switch (group) {
    case 'conflicted': {
      return t('workbench.commitGroupConflicted')
    }
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
    case 'stash': {
      return t('workbench.gitDiffStash')
    }
    case 'untracked': {
      return t('workbench.gitDiffUntracked')
    }
    case 'staged': {
      return t('workbench.gitDiffStaged')
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
      commit.refs.map((ref) => ref.name).join(' '),
    ]
      .join(' ')
      .toLowerCase()
      .includes(query)
  )
}

function isSameWorkbenchGitLogEntry(
  commit: WorkspaceGitLogEntry,
  other: LooseOptional<WorkspaceGitLogEntry>
): boolean {
  return (
    !!other &&
    commit.sha === other.sha &&
    commit.subject === other.subject &&
    commit.refs.length === other.refs.length &&
    commit.refs.every((ref, index) => {
      const otherRef = other.refs[index]
      return (
        ref.kind === otherRef?.kind && ref.name === otherRef.name && !ref.current === !otherRef.current
      )
    })
  )
}

/** 两次读到的提交日志一样（同样的提交、主题与引用）：刷新时沿用原来的列表，界面不必重画。 */
export function isSameWorkbenchGitLog(
  left: readonly WorkspaceGitLogEntry[],
  right: readonly WorkspaceGitLogEntry[]
): boolean {
  return (
    left.length === right.length &&
    left.every((commit, index) => isSameWorkbenchGitLogEntry(commit, right[index]))
  )
}

/**
 * 重读来的第一页，与已经读到的日志的开头一样（日志比一页长时只比这一页）：仓库没有新提交、引用也没动，
 * 后面读过的那些页照旧作数，不用跟着重读。
 */
export function isSameWorkbenchGitLogHead(
  loaded: readonly WorkspaceGitLogEntry[],
  firstPage: readonly WorkspaceGitLogEntry[]
): boolean {
  return (
    firstPage.length <= loaded.length &&
    firstPage.every((commit, index) => isSameWorkbenchGitLogEntry(commit, loaded[index]))
  )
}

/** 往后接一页：仓库在两次读取之间变了的话新的一页可能带着已经有的提交，接上去的时候去掉。 */
export function appendWorkbenchGitLogPage(
  loaded: readonly WorkspaceGitLogEntry[],
  page: readonly WorkspaceGitLogEntry[]
): WorkspaceGitLogEntry[] {
  const known = new Set(loaded.map((commit) => commit.sha))
  return [...loaded, ...page.filter((commit) => !known.has(commit.sha))]
}

/**
 * 提交行上引用标签的先后：当前分支（或分离的 HEAD）最前，然后别的本地分支、标签、远端分支；同一类里
 * 照 git 给的顺序。
 */
export function sortWorkbenchGitRefs(refs: readonly WorkspaceGitRef[]): WorkspaceGitRef[] {
  const rank = (ref: WorkspaceGitRef): number =>
    ref.current || ref.kind === 'head'
      ? 0
      : ref.kind === 'branch'
        ? 1
        : ref.kind === 'tag'
          ? 2
          : 3
  return [...refs].sort((left, right) => rank(left) - rank(right))
}

/** HEAD 在这个提交上：当前分支指着它，或者分离的 HEAD 停在它上面。 */
export function isWorkbenchGitHeadCommit(commit: Pick<WorkspaceGitLogEntry, 'refs'>): boolean {
  return commit.refs.some((ref) => ref.current || ref.kind === 'head')
}

export function formatWorkbenchGitCommitDate(
  locale: string,
  commit: Pick<WorkspaceGitLogEntry, 'authoredAt'>
): string {
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
  commit: Pick<WorkspaceGitLogEntry, 'authoredAt'>,
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
    line.startsWith('dissimilarity index ') ||
    line.startsWith('rename from ') ||
    line.startsWith('rename to ') ||
    line.startsWith('copy from ') ||
    line.startsWith('copy to ') ||
    line.startsWith('old mode ') ||
    line.startsWith('new mode ') ||
    line.startsWith('Binary files ')
  ) return 'meta'
  return 'context'
}

const GitQuotedEscapes: Record<string, number> = {
  a: 7,
  b: 8,
  t: 9,
  n: 10,
  v: 11,
  f: 12,
  r: 13,
  '"': 34,
  '\\': 92,
}

/**
 * git 给特殊文件名（含引号、反斜杠、制表符、换行，或没关 core.quotePath 时的非 ASCII 字符）加的 C 风格
 * 引号还原成原文：`"a/\346\226\207.txt"` → `a/文.txt`。不带引号的原样返回。
 */
export function unquoteWorkbenchGitPath(raw: string): string {
  if (raw.length < 2 || !raw.startsWith('"') || !raw.endsWith('"')) return raw

  const body = raw.slice(1, -1)
  const encoder = new TextEncoder()
  const bytes: number[] = []
  let index = 0
  while (index < body.length) {
    const char = String.fromCodePoint(body.codePointAt(index) ?? 0)
    if (char !== '\\') {
      bytes.push(...encoder.encode(char))
      index += char.length
      continue
    }
    const octal = body.slice(index + 1, index + 4)
    if (/^[0-7]{3}$/u.test(octal)) {
      bytes.push(Number.parseInt(octal, 8))
      index += 4
      continue
    }
    const escaped = body[index + 1] ?? ''
    bytes.push(GitQuotedEscapes[escaped] ?? escaped.charCodeAt(0))
    index += 2
  }
  return new TextDecoder().decode(new Uint8Array(bytes))
}

/** `--- a/…` / `+++ b/…` 里的路径：可能带引号；含空格的名字后面 git 会补一个制表符；/dev/null 为 null。 */
function readPatchLinePath(lines: string[], marker: string, prefix: string): Nullable<string> {
  const line = lines.find((candidate) => candidate.startsWith(marker))
  if (!line) return null
  const path = unquoteWorkbenchGitPath(line.slice(marker.length).replace(/\t$/u, ''))
  if (path === '/dev/null') return null
  return path.startsWith(prefix) ? path.slice(prefix.length) : path
}

function readRenamedPath(lines: string[]): Nullable<string> {
  const line = lines.find((candidate) => /^(?:rename|copy) to /u.test(candidate))
  return line ? unquoteWorkbenchGitPath(line.replace(/^(?:rename|copy) to /u, '')) : null
}

/** `diff --git a/<旧> b/<新>` 这一行里的新路径：两边都可能带引号；不带引号时靠两边同名拆开。 */
function readDiffHeaderPath(header: string): string {
  const quoted = header.match(/^(?:"(?:[^"\\]|\\.)*"|\S+) ("(?:[^"\\]|\\.)*")$/u)
  if (quoted?.[1]) return unquoteWorkbenchGitPath(quoted[1]).replace(/^b\//u, '')
  const nameLength = (header.length - 5) / 2
  if (
    Number.isInteger(nameLength) &&
    header.startsWith('a/') &&
    header.slice(2 + nameLength, 5 + nameLength) === ' b/' &&
    header.slice(2, 2 + nameLength) === header.slice(5 + nameLength)
  )
    return header.slice(5 + nameLength)
  return header.match(/^a\/(.+?) b\/(.+)$/u)?.[2] ?? header
}

export function parseWorkbenchGitCommitDiff(diff: string): WorkbenchGitCommitDiffFile[] {
  if (!diff.trim()) return []

  return diff
    .split(/^diff --git /mu)
    .slice(1)
    .map((section) => {
      const lines = section.split(/\r?\n/u)
      const header = lines.shift() ?? ''
      // 新路径：`+++ b/…`；删掉的文件看 `--- a/…`；只改名、二进制、只改权限的没有这两行，看改名行和头一行。
      const path =
        readPatchLinePath(lines, '+++ ', 'b/') ??
        readPatchLinePath(lines, '--- ', 'a/') ??
        readRenamedPath(lines) ??
        readDiffHeaderPath(header)
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
