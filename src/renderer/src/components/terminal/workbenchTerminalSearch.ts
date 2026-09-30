/**
 * 终端查找：在整个缓冲区（含滚回历史）里按行找匹配，折行拼回整行再找。匹配从最下面（最新的输出）往上数，数满上限时
 * 留下的是最近的那些。只给视口附近的匹配画底色（xterm 装饰），滚动时补画，几千处匹配也不卡。
 */
import type { IBuffer, IDecoration, Terminal } from '@xterm/xterm'

import { findWorkbenchTerminalTextMatches } from '../../models/commands/workbenchTerminalFind'
import type { WorkbenchEditorFindStatus } from '../../models/editor/workbenchEditorFindState'

/** 最多数到这么多处匹配（查找栏显示「N+」）。 */
const MaxTerminalFindMatches = 10_000
/** 视口上下各多画这么多屏的匹配。 */
const DecoratedExtraScreens = 1
/** 一行折成多少行以内才往回找它的开头（画视口里的匹配时，匹配所在行可能从视口上方开始）。 */
const MaxWrappedRowsAbove = 64

/** 匹配与当前匹配的底色，xterm 只认 `#rrggbb`。 */
export interface WorkbenchTerminalFindColors {
  match: string
  activeMatch: string
}

interface TerminalFindMatch {
  /** 匹配所在的那一行（连同折行）第一行的行号，0 起。 */
  row: number
  /** 在这行（连同折行）文字里的位置。 */
  start: number
  end: number
}

export interface WorkbenchTerminalSearch {
  pattern: RegExp
  colors: WorkbenchTerminalFindColors
  matches: TerminalFindMatch[]
  limited: boolean
  /** 当前匹配的下标，没有匹配时是 -1。 */
  active: number
  decorations: IDecoration[]
}

interface TerminalCell {
  x: number
  y: number
  width: number
}

/**
 * 按新的查找词找一遍，当前匹配取视口底部往上最近的一处（视口里或上方都没有，就取下方第一处），并滚到它。
 */
export function startWorkbenchTerminalSearch(
  terminal: Terminal,
  pattern: RegExp,
  colors: WorkbenchTerminalFindColors,
  previous: Nullable<WorkbenchTerminalSearch>
): WorkbenchTerminalSearch {
  disposeDecorations(previous)
  const { matches, limited } = collectMatches(terminal.buffer.active, pattern)
  const bottom = terminal.buffer.active.viewportY + terminal.rows - 1
  let active = matches.findLastIndex((match) => match.row <= bottom)
  if (active < 0 && matches.length > 0) active = 0
  const search = { pattern, colors, matches, limited, active, decorations: [] }
  revealActiveMatch(terminal, search)
  decorateWorkbenchTerminalSearch(terminal, search)
  return search
}

/**
 * 输出变了以后按同一个查找词重找：当前匹配还在就留在它上面，不在了就取原来的序号附近那处；不滚动视口
 * （用户可能正在看别处）。
 */
export function refreshWorkbenchTerminalSearch(
  terminal: Terminal,
  search: WorkbenchTerminalSearch
): WorkbenchTerminalSearch {
  const current = search.matches[search.active]
  const { matches, limited } = collectMatches(terminal.buffer.active, search.pattern)
  const kept = current
    ? matches.findIndex(
        (match) =>
          match.row === current.row && match.start === current.start && match.end === current.end
      )
    : -1
  const active = kept >= 0 ? kept : Math.min(search.active, matches.length - 1)
  const next = { ...search, matches, limited, active, decorations: search.decorations }
  decorateWorkbenchTerminalSearch(terminal, next)
  return next
}

/** 到下一处（1）或上一处（-1），首尾相接，并滚到它。 */
export function stepWorkbenchTerminalSearch(
  terminal: Terminal,
  search: WorkbenchTerminalSearch,
  direction: 1 | -1
): WorkbenchTerminalSearch {
  const total = search.matches.length
  if (total === 0) return search
  const active = search.active < 0 ? 0 : (search.active + direction + total) % total
  const next = { ...search, active }
  revealActiveMatch(terminal, next)
  decorateWorkbenchTerminalSearch(terminal, next)
  return next
}

export function describeWorkbenchTerminalSearch(
  search: WorkbenchTerminalSearch
): WorkbenchEditorFindStatus {
  return {
    total: search.matches.length,
    current: search.active + 1,
    limited: search.limited,
    invalid: false,
  }
}

/** 把视口附近的匹配重新画一遍（先撤掉原来画的）。 */
export function decorateWorkbenchTerminalSearch(
  terminal: Terminal,
  search: WorkbenchTerminalSearch
): void {
  disposeDecorations(search)
  const buffer = terminal.buffer.active
  const from = buffer.viewportY - terminal.rows * DecoratedExtraScreens
  const to = buffer.viewportY + terminal.rows * (1 + DecoratedExtraScreens)
  const cellsByRow = new Map<number, TerminalCell[]>()
  const decorations: IDecoration[] = []
  search.matches.forEach((match, index) => {
    if (match.row > to || match.row < from - MaxWrappedRowsAbove) return
    let cells = cellsByRow.get(match.row)
    if (!cells) {
      cells = readLogicalLineCells(buffer, match.row)
      cellsByRow.set(match.row, cells)
    }
    const color = index === search.active ? search.colors.activeMatch : search.colors.match
    for (const segment of toRowSegments(cells, match.start, match.end)) {
      if (segment.y < from || segment.y > to) continue
      const marker = terminal.registerMarker(segment.y - (buffer.baseY + buffer.cursorY))
      if (!marker) continue
      const decoration = terminal.registerDecoration({
        marker,
        x: segment.x,
        width: segment.width,
        backgroundColor: color,
      })
      if (!decoration) {
        marker.dispose()
        continue
      }
      decoration.onDispose(() => marker.dispose())
      decorations.push(decoration)
    }
  })
  search.decorations = decorations
}

export function disposeWorkbenchTerminalSearch(search: Nullable<WorkbenchTerminalSearch>): void {
  disposeDecorations(search)
}

function disposeDecorations(search: Nullable<WorkbenchTerminalSearch>): void {
  if (!search) return
  for (const decoration of search.decorations) decoration.dispose()
  search.decorations = []
}

/** 从最下面一行往上，按整行（连同折行）找匹配；数满上限就停，留下的是最近的输出里的那些。 */
function collectMatches(
  buffer: IBuffer,
  pattern: RegExp
): { matches: TerminalFindMatch[]; limited: boolean } {
  const lines: TerminalFindMatch[][] = []
  let count = 0
  let limited = false
  for (let last = buffer.length - 1; last >= 0 && !limited; ) {
    let first = last
    while (first > 0 && buffer.getLine(first)?.isWrapped) first -= 1
    let text = ''
    for (let row = first; row <= last; row += 1)
      text += buffer.getLine(row)?.translateToString(row === last) ?? ''
    let found = findWorkbenchTerminalTextMatches(text, pattern, MaxTerminalFindMatches + 1)
    if (count + found.length > MaxTerminalFindMatches) {
      found = found.slice(found.length - (MaxTerminalFindMatches - count))
      limited = true
    }
    if (found.length > 0) {
      lines.push(found.map(([start, end]) => ({ row: first, start, end })))
      count += found.length
    }
    last = first - 1
  }
  return { matches: lines.reverse().flat(), limited }
}

/**
 * 一行（连同折行）里每个 UTF-16 码元落在哪个格子，与 `translateToString` 拼出的文字一一对应：宽字符只出现一次、
 * 后半格跳过，空格子算一个空格。
 */
function readLogicalLineCells(buffer: IBuffer, first: number): TerminalCell[] {
  const cell = buffer.getNullCell()
  const cells: TerminalCell[] = []
  for (let y = first; y < buffer.length; y += 1) {
    const line = buffer.getLine(y)
    if (!line || (y > first && !line.isWrapped)) break
    for (let x = 0; x < line.length; x += 1) {
      line.getCell(x, cell)
      const width = cell.getWidth()
      if (width === 0) continue
      const length = cell.getChars().length || 1
      for (let index = 0; index < length; index += 1) cells.push({ x, y, width })
    }
  }
  return cells
}

/** 匹配按屏幕行切成段：每段是一行里的起始格与格数。 */
function toRowSegments(
  cells: readonly TerminalCell[],
  start: number,
  end: number
): Array<{ y: number; x: number; width: number }> {
  const segments: Array<{ y: number; x: number; width: number }> = []
  for (let index = start; index < end; index += 1) {
    const cell = cells[index]
    if (!cell) break
    const last = segments.at(-1)
    if (last && last.y === cell.y) last.width = cell.x + cell.width - last.x
    else segments.push({ y: cell.y, x: cell.x, width: cell.width })
  }
  return segments
}

/** 当前匹配不在视口里就滚过去，让它落在视口中间。 */
function revealActiveMatch(terminal: Terminal, search: WorkbenchTerminalSearch): void {
  const match = search.matches[search.active]
  if (!match) return
  const buffer = terminal.buffer.active
  const y = readLogicalLineCells(buffer, match.row)[match.start]?.y ?? match.row
  if (y >= buffer.viewportY && y < buffer.viewportY + terminal.rows) return
  terminal.scrollToLine(Math.max(0, Math.min(buffer.baseY, y - Math.floor(terminal.rows / 2))))
}
