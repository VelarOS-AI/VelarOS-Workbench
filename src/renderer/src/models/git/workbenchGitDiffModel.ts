import { applyPatch, parsePatch, reversePatch, structuredPatch } from 'diff'

import { isEmpty,isString, Log } from '@velaros-ai/core'

const log = Log.tag('workbench-git-diff-model')

export interface WorkbenchUnifiedDiffRow {
  id: string
  kind: 'hunk' | 'addition' | 'deletion' | 'context'
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
