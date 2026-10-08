/**
 * 快速打开的 `@` 模式（转到文件中的符号）的纯逻辑：当前文件的符号怎么列、按输入怎么筛、一打开选中哪一行。
 *
 * - 没有输入：整个文件的符号按先后列出，嵌套的缩进，旁边带着外层的名字；
 * - 有输入：按名字模糊匹配（空格隔开的几段都要命中，名字里没有的那段可以命中在外层名字上），不再缩进，
 *   命中在名字上的排在只命中外层名字的前面，同分按文件里的先后。
 */
import { type WorkbenchLanguageServiceDocumentSymbol, type WorkbenchLanguageServiceDocumentSymbolKind } from '@shared/contracts/workbench'

import { scoreWorkbenchFuzzy } from '../shared/workbenchFuzzyScore'

export interface WorkbenchQuickOpenSymbolItem {
  /** 在文件的符号清单里的下标（同名的符号靠它分开）。 */
  index: number
  name: string
  kind: WorkbenchLanguageServiceDocumentSymbolKind
  /** 外层的名字，由外到内用 ` › ` 接起来；顶层的为空串。 */
  container: string
  /** 缩进几层；按输入筛过的结果不缩进，一律为 0。 */
  depth: number
  line: number
  column: number
  /** 名字、外层名字里命中输入的字符下标。 */
  nameMatches: readonly number[]
  containerMatches: readonly number[]
}

export interface WorkbenchQuickOpenSymbolList {
  items: WorkbenchQuickOpenSymbolItem[]
  /** 符号太多没列全。 */
  truncated: boolean
}

export const WorkbenchQuickOpenSymbolContainerSeparator = ' › '

/** 一次最多列这么多行：再多的文件（生成的代码）列全了也没法看，先筛。 */
const DefaultSymbolResultLimit = 2000
/** 命中在名字上的排在只命中外层名字的前面。 */
const NameMatchScore = 1 << 16

/** 每个符号外层的名字。符号按文件里的先后排，一个符号的外层是它前面最近的、`depth` 少一的那个。 */
function resolveContainers(symbols: readonly WorkbenchLanguageServiceDocumentSymbol[]): string[] {
  const ancestors: string[] = []
  return symbols.map((symbol) => {
    ancestors.length = Math.min(ancestors.length, Math.max(0, symbol.depth))
    const container = ancestors.join(WorkbenchQuickOpenSymbolContainerSeparator)
    ancestors[Math.max(0, symbol.depth)] = symbol.name
    return container
  })
}

export function buildWorkbenchQuickOpenSymbolItems({
  symbols,
  query,
  limit = DefaultSymbolResultLimit,
}: {
  symbols: readonly WorkbenchLanguageServiceDocumentSymbol[]
  /** `@` 后面的输入。 */
  query: string
  limit?: number
}): WorkbenchQuickOpenSymbolList {
  const containers = resolveContainers(symbols)
  const pieces = query.trim().split(/\s+/).filter(Boolean)
  const toItem = (
    index: number,
    depth: number,
    nameMatches: readonly number[],
    containerMatches: readonly number[]
  ): WorkbenchQuickOpenSymbolItem => {
    const symbol = symbols[index]!
    return {
      index,
      name: symbol.name,
      kind: symbol.kind,
      container: containers[index] ?? '',
      depth,
      line: symbol.line,
      column: symbol.column,
      nameMatches,
      containerMatches,
    }
  }

  if (pieces.length === 0)
    return {
      items: symbols.slice(0, limit).map((symbol, index) => toItem(index, Math.max(0, symbol.depth), [], [])),
      truncated: symbols.length > limit,
    }

  const scored: Array<{ item: WorkbenchQuickOpenSymbolItem; score: number }> = []
  symbols.forEach((symbol, index) => {
    const container = containers[index] ?? ''
    let score = 0
    const nameMatches = new Set<number>()
    const containerMatches = new Set<number>()
    for (const piece of pieces) {
      const nameMatch = scoreWorkbenchFuzzy(symbol.name, piece)
      if (nameMatch) {
        score += NameMatchScore + nameMatch.score
        nameMatch.positions.forEach((position) => nameMatches.add(position))
        continue
      }
      const containerMatch = container ? scoreWorkbenchFuzzy(container, piece) : null
      if (!containerMatch) return
      score += containerMatch.score
      containerMatch.positions.forEach((position) => containerMatches.add(position))
    }
    // 只命中了外层名字的不算：那是外层那个符号的事，它自己会被列出来。
    if (nameMatches.size === 0) return
    const ascending = (values: Set<number>): number[] => [...values].sort((left, right) => left - right)
    scored.push({ item: toItem(index, 0, ascending(nameMatches), ascending(containerMatches)), score })
  })

  scored.sort((left, right) => right.score - left.score || left.item.index - right.item.index)
  return {
    items: scored.slice(0, limit).map(({ item }) => item),
    truncated: scored.length > limit,
  }
}

function startsAtOrBefore(
  symbol: WorkbenchLanguageServiceDocumentSymbol,
  position: { line: number; column: number }
): boolean {
  const { startLine, startColumn } = symbol.range
  return startLine < position.line || (startLine === position.line && startColumn <= position.column)
}

function endsAtOrAfter(
  symbol: WorkbenchLanguageServiceDocumentSymbol,
  position: { line: number; column: number }
): boolean {
  const { endLine, endColumn } = symbol.range
  return endLine > position.line || (endLine === position.line && endColumn >= position.column)
}

/**
 * 光标所在的符号在清单里的下标：范围盖住光标的那些里最里层的一个。光标不在任何符号里（两个函数之间的空行、
 * 文件开头的 import）时取它前面最近的一个，前面没有就是第一个。没有符号返回 -1。
 */
export function findWorkbenchSymbolIndexAtPosition(
  symbols: readonly WorkbenchLanguageServiceDocumentSymbol[],
  position: { line: number; column: number }
): number {
  let containing = -1
  let preceding = -1
  symbols.forEach((symbol, index) => {
    if (!startsAtOrBefore(symbol, position)) return
    preceding = index
    // 符号按先后排、外层在前：后面盖住光标的一定更靠里。
    if (endsAtOrAfter(symbol, position)) containing = index
  })
  if (containing >= 0) return containing
  if (preceding >= 0) return preceding
  return symbols.length > 0 ? 0 : -1
}
