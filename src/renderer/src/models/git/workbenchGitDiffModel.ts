import { applyPatch, parsePatch, reversePatch, structuredPatch } from 'diff'

import { isEmpty,isString, Log } from '@velaros-ai/core'

const log = Log.tag('workbench-git-diff-model')

export type WorkbenchGitDiffLineKind = 'meta' | 'hunk' | 'addition' | 'deletion' | 'context'

export interface WorkbenchGitDiffLine {
  id: string
  kind: WorkbenchGitDiffLineKind
  text: string
}

export interface WorkbenchUnifiedDiffRow {
  id: string
  kind: WorkbenchGitDiffLineKind
  oldLine: Nullable<number>
  newLine: Nullable<number>
  marker: string
  text: string
}

export interface WorkbenchFullFileDiffContents {
  beforeContent: string
  afterContent: string
}

/** Change-block start rows (1-indexed document lines) used by initial and arrow navigation. */
export function collectWorkbenchDiffChangeAnchors(rows: WorkbenchUnifiedDiffRow[]): number[] {
  const anchors: number[] = []
  rows.forEach((row, index) => {
    const isChange = row.kind === 'addition' || row.kind === 'deletion'
    const previous = rows[index - 1]
    const previousIsChange =
      !!previous && (previous.kind === 'addition' || previous.kind === 'deletion')
    if (isChange && !previousIsChange) anchors.push(index + 1)
  })
  return anchors
}

const DefaultMaxDiffLines = 220

function getDiffLineKind(line: string): WorkbenchGitDiffLineKind {
  if (line.startsWith('@@')) return 'hunk'

  if (line.startsWith('+') && !line.startsWith('+++')) return 'addition'

  if (line.startsWith('-') && !line.startsWith('---')) return 'deletion'

  if (
    line.startsWith('diff --git') ||
    line.startsWith('index ') ||
    line.startsWith('---') ||
    line.startsWith('+++') ||
    line.startsWith('new file mode') ||
    line.startsWith('deleted file mode') ||
    line.startsWith('similarity index') ||
    line.startsWith('rename from') ||
    line.startsWith('rename to') ||
    line.startsWith('\\ No newline at end of file')
  )
    return 'meta'

  return 'context'
}

export function buildWorkbenchGitDiffLines(
  diff: string,
  maxLines = DefaultMaxDiffLines
): WorkbenchGitDiffLine[] {
  return diff
    .split(/\r?\n/)
    .slice(0, Math.max(1, maxLines))
    .map((line, index) => ({
      id: `${index}:${line.slice(0, 32)}`,
      kind: getDiffLineKind(line),
      text: line || ' ',
    }))
}

export function buildWorkbenchUnifiedDiffRows(
  diff: string,
  maxLines = DefaultMaxDiffLines
): WorkbenchUnifiedDiffRow[] {
  let oldLine = 0
  let newLine = 0
  let insideHunk = false

  const rows = diff
    .split(/\r?\n/)
    .slice(0, Math.max(1, maxLines))
    .map((line, index): WorkbenchUnifiedDiffRow => {
      const kind = getDiffLineKind(line)
      const hunkMatch = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@renderer/.exec(line)

      if (hunkMatch) {
        insideHunk = true
        oldLine = +hunkMatch[1]
        newLine = +hunkMatch[2]
        return {
          id: `${index}:hunk:${line.slice(0, 24)}`,
          kind,
          oldLine: null,
          newLine: null,
          marker: '',
          text: line,
        }
      }

      if (kind === 'meta') {
        if (!line.startsWith('\\ No newline at end of file')) insideHunk = false
        return {
          id: `${index}:meta:${line.slice(0, 24)}`,
          kind,
          oldLine: null,
          newLine: null,
          marker: '',
          text: line || ' ',
        }
      }

      if (!insideHunk)
        return {
          id: `${index}:meta:${line.slice(0, 24)}`,
          kind: 'meta',
          oldLine: null,
          newLine: null,
          marker: '',
          text: line || ' ',
        }

      switch (kind) {
        case 'addition': {
          return {
            id: `${index}:add:${newLine}`,
            kind,
            oldLine: null,
            newLine: newLine++,
            marker: '+',
            text: line.slice(1) || ' ',
          }
        }
        case 'deletion': {
          return {
            id: `${index}:del:${oldLine}`,
            kind,
            oldLine: oldLine++,
            newLine: null,
            marker: '-',
            text: line.slice(1) || ' ',
          }
        }
        case 'context': {
          return {
            id: `${index}:ctx:${oldLine}:${newLine}`,
            kind,
            oldLine: oldLine++,
            newLine: newLine++,
            marker: '',
            text: line.startsWith(' ') ? line.slice(1) || ' ' : line || ' ',
          }
        }
        default:
          return {
            id: `${index}:meta:${line.slice(0, 24)}`,
            kind: 'meta',
            oldLine: null,
            newLine: null,
            marker: '',
            text: line || ' ',
          }
      }
    })

  return rows.filter((row) => row.kind !== 'meta' && row.kind !== 'hunk')
}

/** 全文件 diff 一次最多渲染的行数（远大于普通 hunk diff，覆盖整份文件）。 */
const FullFileMaxDiffLines = 100_000

/**
 * 用单文件 Git patch 还原完整的差异两侧。暂存区 patch 从 HEAD 正向应用，
 * 工作区 patch 从当前文件反向应用，因而不会丢掉 patch 未携带的上下文。
 */
export function resolveWorkbenchFullFileDiffContents(input: {
  diff: string
  scope: 'staged' | 'working'
  baseContent: string
  currentContent: string
}): Nullable<WorkbenchFullFileDiffContents> {
  try {
    const patches = parsePatch(input.diff)
    if (patches.length !== 1) return null

    if (input.scope === 'staged') {
      const afterContent = applyPatch(input.baseContent, patches[0])
      return isString(afterContent) ? { beforeContent: input.baseContent, afterContent } : null
    }

    const beforeContent = applyPatch(input.currentContent, reversePatch(patches[0]))
    return isString(beforeContent) ? { beforeContent, afterContent: input.currentContent } : null
  } catch (error) {
    log.debug('Git patch 无法还原为完整文件差异', { error })
    return null
  }
}

/**
 * 由两段内容（旧=历史快照，新=当前版本）生成统一 diff 行，复用与 Git 历史相同的渲染。
 * 采用 `diff` 包的 `structuredPatch`（真正的多 hunk Myers diff，与 `git diff` 行为一致），
 *
 * fullFile=true 时用超大 context，把整份文件都作为上下文展开（未改动的行也全部显示），
 * 而非只显示改动附近的若干行。
 */
export function buildWorkbenchContentDiffRows(
  path: string,
  oldContent: string,
  newContent: string,
  { fullFile = false }: { fullFile?: boolean } = {}
): WorkbenchUnifiedDiffRow[] {
  if (oldContent === newContent) return []

  const context = fullFile ? Number.MAX_SAFE_INTEGER : 3
  const patch = structuredPatch(path, path, oldContent, newContent, '', '', { context })
  if (isEmpty(patch.hunks)) return []

  const maxLines = fullFile ? FullFileMaxDiffLines : DefaultMaxDiffLines
  const rows: WorkbenchUnifiedDiffRow[] = []
  let id = 0

  for (let hunkIndex = 0; hunkIndex < patch.hunks.length; hunkIndex += 1) {
    const hunk = patch.hunks[hunkIndex]
    let oldLine = hunk.oldStart
    let newLine = hunk.newStart

    // 非全文件模式下多个 hunk 之间插一条分隔行；全文件只有一个 hunk，不需要噪音。
    if (!fullFile && hunkIndex > 0) {
      rows.push({
        id: `${id++}:hunk`,
        kind: 'hunk',
        oldLine: null,
        newLine: null,
        marker: '',
        text: `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`,
      })
    }

    let pendingDeletions: string[] = []
    let pendingAdditions: string[] = []

    const flushChangeBlock = (): void => {
      pendingDeletions.forEach((text) => {
        rows.push({
          id: `${id++}:del`,
          kind: 'deletion',
          oldLine: oldLine++,
          newLine: null,
          marker: '-',
          text,
        })
      })
      pendingAdditions.forEach((text) => {
        rows.push({
          id: `${id++}:add`,
          kind: 'addition',
          oldLine: null,
          newLine: newLine++,
          marker: '+',
          text,
        })
      })
      pendingDeletions = []
      pendingAdditions = []
    }

    for (const raw of hunk.lines) {
      if (rows.length >= maxLines) break
      if (raw.startsWith('\\ No newline at end of file')) continue

      const prefix = raw[0]
      const text = raw.slice(1)
      if (prefix === '-') {
        pendingDeletions.push(text)
      } else if (prefix === '+') {
        pendingAdditions.push(text)
      } else {
        flushChangeBlock()
        rows.push({
          id: `${id++}:ctx`,
          kind: 'context',
          oldLine: oldLine++,
          newLine: newLine++,
          marker: '',
          text,
        })
      }
    }
    flushChangeBlock()
    if (rows.length >= maxLines) break
  }

  return rows.slice(0, maxLines)
}

export function buildWorkbenchUntrackedPreviewDiff(content: string): string {
  if (!content) return '+'

  return content
    .split(/\r?\n/)
    .map((line) => `+${line}`)
    .join('\n')
}
