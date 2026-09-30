/**
 * 终端里的查找：查找词与开关项合成正则，在一整行（连同折行）里找匹配。与编辑器查找栏同一套开关语义：区分大小写、
 * 全字（前后不是字母、数字、下划线）、正则（Unicode 模式，与编辑器一致）。
 */

export interface WorkbenchTerminalFindOptions {
  caseSensitive: boolean
  wholeWord: boolean
  regexp: boolean
}

export const DefaultWorkbenchTerminalFindOptions: WorkbenchTerminalFindOptions = {
  caseSensitive: false,
  wholeWord: false,
  regexp: false,
}

/** 查找词为空时是 null，正则写错了是 'invalid'。 */
export function buildWorkbenchTerminalFindPattern(
  query: string,
  options: WorkbenchTerminalFindOptions
): RegExp | 'invalid' | null {
  if (!query) return null
  const body = options.regexp ? query : query.replace(/[.*+?^${}()|[\]\\/]/gu, '\\$&')
  const source = options.wholeWord ? String.raw`(?<![\p{L}\p{N}_])(?:${body})(?![\p{L}\p{N}_])` : body
  try {
    return new RegExp(source, options.caseSensitive ? 'gu' : 'giu')
  } catch {
    // arch-guard:silent-catch-ok 正则写错是用户正在输入的中间状态，查找栏据此提示。
    return 'invalid'
  }
}

/** 一段文字里的匹配 `[start, end)`，不算空匹配（`a*` 这类），最多 limit 个。 */
export function findWorkbenchTerminalTextMatches(
  text: string,
  pattern: RegExp,
  limit: number
): Array<[number, number]> {
  const matches: Array<[number, number]> = []
  pattern.lastIndex = 0
  while (matches.length < limit) {
    const match = pattern.exec(text)
    if (!match) break
    if (match[0].length === 0) {
      pattern.lastIndex = match.index + ((text.codePointAt(match.index) ?? 0) > 0xffff ? 2 : 1)
      continue
    }
    matches.push([match.index, match.index + match[0].length])
  }
  return matches
}
