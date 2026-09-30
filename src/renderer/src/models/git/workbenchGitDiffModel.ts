import { applyPatch, parsePatch, reversePatch, structuredPatch } from 'diff'

import { isEmpty,isString, Log } from '@velaros-ai/core'

import type { SystemWorkspaceFilesChangedEvent, WorkspaceGitFileStatusEntry } from '@shared/contracts'
import type { WorkbenchGitFilePatch, WorkbenchGitPatchHunk } from '@shared/workbenchGitPatch'

const log = Log.tag('workbench-git-diff-model')

/**
 * 打开着的差异标签要不要重读：这批文件改动碰到了差异的两侧——文件本身（含改名前的路径），或者
 * HEAD、索引、分支（提交、切分支之后对照的基准变了）。
 */
export function isWorkbenchGitDiffAffectedByChange(
  item: Pick<WorkspaceGitFileStatusEntry, 'path' | 'originalPath'>,
  event: Pick<SystemWorkspaceFilesChangedEvent, 'paths'>
): boolean {
  return event.paths.some(
    (path) => path === item.path || path === item.originalPath || path.startsWith('.git/')
  )
}

export interface WorkbenchUnifiedDiffRow {
  id: string
  kind: 'hunk' | 'addition' | 'deletion' | 'context'
  oldLine: Nullable<number>
  newLine: Nullable<number>
  marker: string
  text: string
  /** 按 git 的补丁铺的行：属于第几块改动（从 0 起）；块外面的行、别的来源的行没有。 */
  hunk?: number
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

  return buildRowsFromHunks(patch.hunks, {
    separateHunks: !fullFile,
    maxLines: fullFile ? FullFileMaxDiffLines : DefaultMaxDiffLines,
  })
}

/**
 * 只有单文件统一补丁、没有两侧全文时的差异行：按补丁里的 hunk 逐行展开，hunk 之间插分隔行。
 * 补丁读不懂（不是单文件补丁）时为空。
 */
export function buildWorkbenchPatchDiffRows(diff: string): WorkbenchUnifiedDiffRow[] {
  try {
    const patches = parsePatch(diff)
    if (patches.length !== 1 || isEmpty(patches[0].hunks)) return []
    return buildRowsFromHunks(patches[0].hunks, {
      separateHunks: true,
      maxLines: FullFileMaxDiffLines,
    })
  } catch (error) {
    log.debug('补丁无法解析为差异行', { error })
    return []
  }
}

/** 补丁一侧的全文，拿来铺开改动之间没变的行：`old` 是改动前那一侧，`new` 是改动后那一侧。 */
export interface WorkbenchGitPatchContent {
  text: string
  side: 'old' | 'new'
}

export interface WorkbenchGitPatchRows {
  rows: WorkbenchUnifiedDiffRow[]
  /** 没变的行也铺开了（整份文件）；否则只有各块改动。 */
  fullFile: boolean
}

/**
 * 按 git 自己的补丁铺差异行，每一行记着属于哪一块，块上的按钮（暂存、回滚这一块）照它放。给了一侧的全文时
 * 按行号把块与块之间没变的行也铺开；全文对不上补丁（读完之后文件又变了、编码不是 UTF-8）、补丁不完整、
 * 或者太长时只铺各块改动。
 */
export function buildWorkbenchGitPatchRows(
  patch: WorkbenchGitFilePatch,
  content: Nullable<WorkbenchGitPatchContent>
): WorkbenchGitPatchRows {
  const rows = content && !patch.incomplete ? buildFullFilePatchRows(patch, content) : null
  return rows
    ? { rows, fullFile: true }
    : { rows: buildHunkPatchRows(patch.hunks), fullFile: false }
}

/** 块头里这一侧从哪一行起：这一侧没有行（纯新增、纯删除）时块头给的是它前面那一行。 */
function hunkSideStart(start: number, count: number): number {
  return count === 0 ? start + 1 : start
}

const ByteOrderMark = String.fromCodePoint(0xfeff)

/** 补丁里的一行去掉前缀；CRLF 文件的 `\r` 与第一行的 BOM 不算内容（编辑器读的全文已去掉它们）。 */
function patchLineText(line: string, lineNumber: number): string {
  const text = line.slice(1).replace(/\r$/u, '')
  return lineNumber === 1 && text.startsWith(ByteOrderMark) ? text.slice(1) : text
}

function splitPatchContentLines(text: string): string[] {
  if (!text) return []
  const lines = text.split('\n')
  if (lines.at(-1) === '') lines.pop()
  return lines
}

/** 铺行时的位置：两侧各到了第几行，已经铺了几行。 */
class PatchRowCursor {
  public readonly rows: WorkbenchUnifiedDiffRow[] = []
  public oldLine = 1
  public newLine = 1

  public get full(): boolean {
    return this.rows.length >= FullFileMaxDiffLines
  }

  public start(hunk: WorkbenchGitPatchHunk): void {
    this.oldLine = hunkSideStart(hunk.oldStart, hunk.oldLines)
    this.newLine = hunkSideStart(hunk.newStart, hunk.newLines)
  }

  public push(kind: WorkbenchUnifiedDiffRow['kind'], text: string, hunk?: number): void {
    const row: WorkbenchUnifiedDiffRow = {
      id: `${this.rows.length}:${kind}`,
      kind,
      oldLine: kind === 'addition' || kind === 'hunk' ? null : this.oldLine,
      newLine: kind === 'deletion' || kind === 'hunk' ? null : this.newLine,
      marker: kind === 'addition' ? '+' : kind === 'deletion' ? '-' : '',
      text,
    }
    if (hunk !== undefined) row.hunk = hunk
    this.rows.push(row)
    if (kind !== 'addition' && kind !== 'hunk') this.oldLine += 1
    if (kind !== 'deletion' && kind !== 'hunk') this.newLine += 1
  }
}

function patchLineKind(marker: string): 'addition' | 'deletion' | 'context' {
  return marker === '+' ? 'addition' : marker === '-' ? 'deletion' : 'context'
}

function buildFullFilePatchRows(
  patch: WorkbenchGitFilePatch,
  content: WorkbenchGitPatchContent
): Nullable<WorkbenchUnifiedDiffRow[]> {
  const fileLines = splitPatchContentLines(content.text)
  const cursor = new PatchRowCursor()
  const sideLine = (): number => (content.side === 'old' ? cursor.oldLine : cursor.newLine)
  /** 铺没变的行，铺到这一侧的第 `end` 行之前（不含）；全文不够长时返回 false。 */
  const pushUnchanged = (end: number): boolean => {
    while (sideLine() < end) {
      const text = fileLines[sideLine() - 1]
      if (text === undefined || cursor.full) return false
      cursor.push('context', text)
    }
    return true
  }

  for (const [hunkIndex, hunk] of patch.hunks.entries()) {
    const oldStart = hunkSideStart(hunk.oldStart, hunk.oldLines)
    const newStart = hunkSideStart(hunk.newStart, hunk.newLines)
    if (!pushUnchanged(content.side === 'old' ? oldStart : newStart)) return null
    if (cursor.oldLine !== oldStart || cursor.newLine !== newStart) return null
    for (const line of hunk.lines) {
      if (line.startsWith('\\')) continue
      if (cursor.full) return null
      const kind = patchLineKind(line[0])
      const text = patchLineText(line, kind === 'deletion' ? cursor.oldLine : cursor.newLine)
      // 全文那一侧有的行（上下文，加上删掉的或新增的那些）要跟全文对得上。
      const onContentSide =
        kind === 'context' || (kind === 'deletion') === (content.side === 'old')
      if (onContentSide && fileLines[sideLine() - 1] !== text) return null
      cursor.push(kind, text, hunkIndex)
    }
  }
  return pushUnchanged(fileLines.length + 1) ? cursor.rows : null
}

/** 只铺各块改动，块与块之间插一行块头当分隔。 */
function buildHunkPatchRows(hunks: readonly WorkbenchGitPatchHunk[]): WorkbenchUnifiedDiffRow[] {
  const cursor = new PatchRowCursor()
  for (const [hunkIndex, hunk] of hunks.entries()) {
    if (hunkIndex > 0) cursor.push('hunk', hunk.header)
    cursor.start(hunk)
    for (const line of hunk.lines) {
      if (line.startsWith('\\')) continue
      if (cursor.full) return cursor.rows
      const kind = patchLineKind(line[0])
      cursor.push(
        kind,
        patchLineText(line, kind === 'deletion' ? cursor.oldLine : cursor.newLine),
        hunkIndex
      )
    }
  }
  return cursor.rows
}

function buildRowsFromHunks(
  hunks: ReadonlyArray<{
    oldStart: number
    oldLines: number
    newStart: number
    newLines: number
    lines: string[]
  }>,
  { separateHunks, maxLines }: { separateHunks: boolean; maxLines: number }
): WorkbenchUnifiedDiffRow[] {
  const rows: WorkbenchUnifiedDiffRow[] = []
  let id = 0

  for (let hunkIndex = 0; hunkIndex < hunks.length; hunkIndex += 1) {
    const hunk = hunks[hunkIndex]
    let oldLine = hunk.oldStart
    let newLine = hunk.newStart

    // 非全文件模式下多个 hunk 之间插一条分隔行；全文件只有一个 hunk，不需要噪音。
    if (separateHunks && hunkIndex > 0) {
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
