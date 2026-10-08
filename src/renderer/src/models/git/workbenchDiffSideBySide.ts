import type { WorkbenchDiffLayout } from '../workbenchPreferences'

import {
  collectWorkbenchDiffChangeAnchors,
  type WorkbenchUnifiedDiffRow,
} from './workbenchGitDiffModel'

/**
 * 并排差异的一行：左栏是改动前，右栏是改动后，各是差异行里的哪一行（下标）。一侧在这里没有对应的行
 * （对面多出来的删除行或新增行）时为 null，那一栏画一行空的占位，两栏的行才对得齐。
 */
export interface WorkbenchSideBySideDiffLine {
  left: Nullable<number>
  right: Nullable<number>
}

function isChange(row: LooseOptional<WorkbenchUnifiedDiffRow>): boolean {
  return row?.kind === 'addition' || row?.kind === 'deletion'
}

/**
 * 把上下排的差异行摆成左右两栏。没变的行、块与块之间的分隔行两栏各一份；一块改动里的删除行在左、
 * 新增行在右，第 n 个删除行对着第 n 个新增行，多出来的那一侧对着空行。
 */
export function pairWorkbenchDiffRows(
  rows: readonly WorkbenchUnifiedDiffRow[]
): WorkbenchSideBySideDiffLine[] {
  const lines: WorkbenchSideBySideDiffLine[] = []
  let index = 0
  while (index < rows.length) {
    if (!isChange(rows[index])) {
      lines.push({ left: index, right: index })
      index += 1
      continue
    }
    const deletionStart = index
    while (index < rows.length && rows[index].kind === 'deletion') index += 1
    const additionStart = index
    while (index < rows.length && rows[index].kind === 'addition') index += 1
    const deletions = additionStart - deletionStart
    const additions = index - additionStart
    for (let offset = 0; offset < Math.max(deletions, additions); offset += 1)
      lines.push({
        left: offset < deletions ? deletionStart + offset : null,
        right: offset < additions ? additionStart + offset : null,
      })
  }
  return lines
}

/** 并排时每处改动从第几行开始（行号从 1 起），上一处、下一处按它跳。 */
export function collectWorkbenchSideBySideChangeAnchors(
  rows: readonly WorkbenchUnifiedDiffRow[],
  lines: readonly WorkbenchSideBySideDiffLine[]
): number[] {
  const anchors: number[] = []
  let previousChanged = false
  lines.forEach((line, index) => {
    const changed = line.left === null || line.right === null || isChange(rows[line.left])
    if (changed && !previousChanged) anchors.push(index + 1)
    previousChanged = changed
  })
  return anchors
}

/**
 * 每块改动上方的那排按钮放在哪一行上面：这一块第一处增删所在的那一行（行号从 0 起 → 第几块）。
 * 给了 `lines` 是并排的行，两栏在同一行上各放一份（一栏是按钮，一栏只占同样高的位置）；不给是上下排的行。
 */
export function collectWorkbenchDiffHunkLines(
  rows: readonly WorkbenchUnifiedDiffRow[],
  lines?: readonly WorkbenchSideBySideDiffLine[]
): Map<number, number> {
  const hunkLines = new Map<number, number>()
  const seen = new Set<number>()
  const visit = (row: LooseOptional<WorkbenchUnifiedDiffRow>, line: number): void => {
    if (!row || row.hunk === undefined || !isChange(row) || seen.has(row.hunk)) return
    seen.add(row.hunk)
    hunkLines.set(line, row.hunk)
  }
  if (lines)
    lines.forEach((line, index) => {
      if (line.left !== null) visit(rows[line.left], index)
      if (line.right !== null) visit(rows[line.right], index)
    })
  else rows.forEach(visit)
  return hunkLines
}

/**
 * 查看器里的一栏。上下排时只有一栏，删除行和新增行都在里面；并排时左栏是改动前、右栏是改动后，
 * 两栏行数一样，一侧多出来的行在另一侧是空的占位行。
 */
export interface WorkbenchDiffPane {
  side: 'unified' | 'old' | 'new'
  /** 这一栏的每一行是差异行里的哪一行（下标）；null 是占位行。 */
  rowIndexes: ReadonlyArray<Nullable<number>>
  /** 每块上方那排按钮：画出来，还是只占同样高的位置（并排时的左栏，两栏的行才对得齐）。 */
  hunkBar: 'buttons' | 'placeholder'
}

export interface WorkbenchDiffPaneLayout {
  /** 主栏在最后：上下排时是唯一的那一栏，并排时是右栏。跳转、记滚动位置都看它。 */
  panes: WorkbenchDiffPane[]
  /** 哪几行上方有按钮（行号从 0 起 → 第几块）；各栏都放在同样的行上。 */
  hunkLines: ReadonlyMap<number, number>
  /** 每处改动从第几行开始（行号从 1 起）。 */
  anchors: number[]
}

/** 差异行照选的排法摆成一栏或两栏。 */
export function buildWorkbenchDiffPaneLayout(
  rows: readonly WorkbenchUnifiedDiffRow[],
  layout: WorkbenchDiffLayout
): WorkbenchDiffPaneLayout {
  if (layout === 'split') {
    const lines = pairWorkbenchDiffRows(rows)
    return {
      panes: [
        { side: 'old', rowIndexes: lines.map((line) => line.left), hunkBar: 'placeholder' },
        { side: 'new', rowIndexes: lines.map((line) => line.right), hunkBar: 'buttons' },
      ],
      hunkLines: collectWorkbenchDiffHunkLines(rows, lines),
      anchors: collectWorkbenchSideBySideChangeAnchors(rows, lines),
    }
  }
  return {
    panes: [{ side: 'unified', rowIndexes: rows.map((_, index) => index), hunkBar: 'buttons' }],
    hunkLines: collectWorkbenchDiffHunkLines(rows),
    anchors: collectWorkbenchDiffChangeAnchors(rows),
  }
}

/** 一栏的正文：每行是对应差异行的文字，占位行是空行。 */
export function getWorkbenchDiffPaneText(
  rows: readonly WorkbenchUnifiedDiffRow[],
  pane: WorkbenchDiffPane
): string {
  return pane.rowIndexes.map((rowIndex) => (rowIndex === null ? '' : rows[rowIndex].text)).join('\n')
}
