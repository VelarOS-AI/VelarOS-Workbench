/**
 * 项目内容搜索与替换的匹配规则：main（搜磁盘上的文件、替换没在编辑器里开着的文件）与 renderer（搜、替换编辑器里
 * 开着的文件）共用这一份，两边的匹配、行列号与替换结果才一致。
 *
 * 规则与编辑器里的查找（CodeMirror 的搜索）一致：
 * - 字面查找按原样找；区分大小写、全字匹配、正则三个开关。
 * - 正则带 `gmu` 标志（不区分大小写再加 `i`）：`^` `$` 按行算，`.` 不跨行，`\s`、`[^…]`、`\n` 可以跨行。
 * - 全字匹配：匹配的两头不能与相邻的字母、数字或下划线连成一个词（按 Unicode 算）。
 * - 替换：字面查找原样用替换文本；正则先认 `\n` `\r` `\t` `\\`，再换 `$&`（整个匹配）、`$$`（`$` 本身）、
 *   `$1`…`$99`（捕获组，没有这一组时原样保留）。
 * - 空匹配（`^`、没有 a 处的 `a*`）不算：在整个项目里它们只会刷满结果。
 *
 * 正文是去掉 BOM、换行统一为 LF 的文本；行列号从 1 起，列按 UTF-16 码元算，与编辑器一致。
 */

/** 查找的三个开关。 */
export interface WorkbenchTextSearchOptions {
  matchCase: boolean
  wholeWord: boolean
  regex: boolean
}

export interface WorkbenchTextSearchQuery extends WorkbenchTextSearchOptions {
  query: string
}

export const DefaultWorkbenchTextSearchOptions: Readonly<WorkbenchTextSearchOptions> = {
  matchCase: false,
  wholeWord: false,
  regex: false,
}

/** 一次内容搜索默认最多列出的匹配数，与请求能要的上限。 */
export const WorkbenchContentSearchDefaultLimit = 5000
export const WorkbenchContentSearchMaxLimit = 20_000
/** 超过这么大的文件不搜（多半是生成的数据或打包产物），结果里报跳过了几个。 */
export const WorkbenchContentSearchMaxFileBytes = 1_000_000

export interface WorkbenchTextSearchMatcher {
  readonly query: WorkbenchTextSearchQuery
  /** 全局、多行的正则；每次扫描都从头设 lastIndex，扫描是同步的，不跨调用共享状态。 */
  readonly pattern: RegExp
}

export type WorkbenchTextSearchCompileResult =
  | { status: 'empty' }
  | { status: 'invalid'; message: string }
  | { status: 'ready'; matcher: WorkbenchTextSearchMatcher }

/** 一处匹配。 */
export interface WorkbenchTextSearchHit {
  /** 在正文里的位置 [from, to)。 */
  from: number
  to: number
  line: number
  column: number
  /** 匹配末尾之后那个位置的行列（跨行的匹配落在后面的行）。 */
  endLine: number
  endColumn: number
  /** 匹配起点所在行的行首偏移。 */
  lineStart: number
  /** 整个匹配与各捕获组（正则替换用）；字面查找只有整个匹配。 */
  groups: ReadonlyArray<string | undefined>
}

/** 按起止行列认出一处匹配（替换「这一处」时用）。 */
export interface WorkbenchTextSearchRange {
  line: number
  column: number
  endLine: number
  endColumn: number
}

/** 结果里显示的一行：匹配所在的行，太长时只留匹配附近一段，截掉的地方是 `...`。 */
export interface WorkbenchTextSearchPreview {
  text: string
  /** 匹配在 text 里的位置 [matchStart, matchEnd)；跨行的匹配截到这一行末尾。 */
  matchStart: number
  matchEnd: number
}

export interface WorkbenchTextReplaceResult {
  content: string
  count: number
}

const RegExpSyntaxCharacters = /[$()*+.?[\\\]^{|}]/gu
const WordCharacter = /[\p{Alphabetic}\p{Number}_]/u
/** 预览里匹配前面最多留这么多字符（窄的侧栏里也要看得到匹配本身），整行最多这么长。 */
const PreviewContextBefore = 30
const PreviewMaxChars = 160
/** 截断处的记号；搜索结果的着色认它（见 workbenchCodeSnippetHighlight）。 */
const PreviewEllipsis = '...'

/** 编译查找词；正则写错时给出说明，不抛错。查找词为空时什么也不找。 */
export function compileWorkbenchTextSearch(
  query: WorkbenchTextSearchQuery
): WorkbenchTextSearchCompileResult {
  if (!query.query) return { status: 'empty' }

  const source = query.regex ? query.query : query.query.replace(RegExpSyntaxCharacters, '\\$&')
  try {
    return {
      status: 'ready',
      matcher: { query, pattern: new RegExp(source, query.matchCase ? 'gmu' : 'gimu') },
    }
  } catch (error) {
    return { status: 'invalid', message: describeRegExpError(error) }
  }
}

/**
 * 按顺序逐个报出正文里的匹配；visit 返回 false 就停。
 */
export function scanWorkbenchTextSearch(
  content: string,
  matcher: WorkbenchTextSearchMatcher,
  visit: (hit: WorkbenchTextSearchHit) => boolean | void
): void {
  const pattern = matcher.pattern
  const cursor = createLineCursor(content)
  pattern.lastIndex = 0
  for (let match = pattern.exec(content); match; match = pattern.exec(content)) {
    const from = match.index
    const to = from + match[0].length
    if (to === from) {
      pattern.lastIndex = from + codePointLength(content, from)
      if (pattern.lastIndex > content.length) return
      continue
    }
    if (matcher.query.wholeWord && !isWholeWordMatch(content, from, to)) {
      pattern.lastIndex = to
      continue
    }

    moveLineCursor(content, cursor, from)
    const end = { ...cursor }
    moveLineCursor(content, end, to)
    const hit: WorkbenchTextSearchHit = {
      from,
      to,
      line: cursor.line,
      column: from - cursor.lineStart + 1,
      endLine: end.line,
      endColumn: to - end.lineStart + 1,
      lineStart: cursor.lineStart,
      groups: match,
    }
    if (visit(hit) === false) return
    pattern.lastIndex = to
  }
}

/** 结果里显示的那一行（见 WorkbenchTextSearchPreview）。 */
export function buildWorkbenchTextSearchPreview(
  content: string,
  hit: WorkbenchTextSearchHit
): WorkbenchTextSearchPreview {
  const lineBreak = content.indexOf('\n', hit.from)
  const lineEnd = lineBreak === -1 ? content.length : lineBreak
  const line = content.slice(hit.lineStart, lineEnd)
  const matchStart = hit.from - hit.lineStart
  const matchEnd = Math.min(hit.to, lineEnd) - hit.lineStart

  // 行首与行尾的空白不要，匹配本身里的空白留着。
  let from = 0
  while (from < matchStart && isWhitespace(line.charCodeAt(from))) from += 1
  let to = line.length
  while (to > matchEnd && isWhitespace(line.charCodeAt(to - 1))) to -= 1

  let prefix = ''
  if (matchStart - from > PreviewContextBefore) {
    // 从匹配往前数，尽量在词的边界截，免得开头是半个词。
    let cut = matchStart - PreviewContextBefore
    const space = line.slice(cut, matchStart).search(/\s\S/u)
    if (space !== -1) cut += space + 1
    from = skipLowSurrogate(line, cut)
    prefix = PreviewEllipsis
  }
  let suffix = ''
  if (to - from > PreviewMaxChars) {
    to = keepHighSurrogate(line, from + PreviewMaxChars)
    suffix = PreviewEllipsis
  }

  return {
    text: `${prefix}${line.slice(from, to)}${suffix}`,
    matchStart: prefix.length + matchStart - from,
    matchEnd: prefix.length + Math.min(matchEnd, to) - from,
  }
}

/** 这一处匹配要换成的文字（规则见文件头）。 */
export function expandWorkbenchTextSearchReplacement(
  options: WorkbenchTextSearchOptions,
  replacement: string,
  groups: ReadonlyArray<string | undefined>
): string {
  if (!options.regex) return replacement

  const unquoted = replacement.replace(/\\([nrt\\])/gu, (_escape, char: string) =>
    char === 'n' ? '\n' : char === 'r' ? '\r' : char === 't' ? '\t' : '\\'
  )
  return unquoted.replace(/\$([$&]|\d+)/gu, (token, reference: string) => {
    if (reference === '&') return groups[0] ?? ''
    if (reference === '$') return '$'
    // `$12` 在只有一个捕获组时是 `$1` 后面跟着 2。
    for (let length = reference.length; length > 0; length -= 1) {
      const index = Number(reference.slice(0, length))
      if (index > 0 && index < groups.length) return (groups[index] ?? '') + reference.slice(length)
    }
    return token
  })
}

/** 换掉正文里的匹配：给了 select 就只换它挑中的，不给就全换。 */
export function replaceWorkbenchTextSearchMatches(
  content: string,
  matcher: WorkbenchTextSearchMatcher,
  replacement: string,
  select?: (hit: WorkbenchTextSearchHit) => boolean
): WorkbenchTextReplaceResult {
  const pieces: string[] = []
  let last = 0
  let count = 0
  scanWorkbenchTextSearch(content, matcher, (hit) => {
    if (select && !select(hit)) return
    pieces.push(
      content.slice(last, hit.from),
      expandWorkbenchTextSearchReplacement(matcher.query, replacement, hit.groups)
    )
    last = hit.to
    count += 1
  })
  if (count === 0) return { content, count }

  pieces.push(content.slice(last))
  return { content: pieces.join(''), count }
}

/** 一处匹配的标识：起止行列。 */
export function workbenchTextSearchRangeKey(range: WorkbenchTextSearchRange): string {
  return `${range.line}:${range.column}-${range.endLine}:${range.endColumn}`
}

/** 行列（从 1 起）在正文里的偏移；超出行尾的列落在行尾，超出的行落在正文末尾。 */
export function resolveWorkbenchTextOffset(content: string, line: number, column: number): number {
  let lineStart = 0
  for (let current = 1; current < line; current += 1) {
    const lineBreak = content.indexOf('\n', lineStart)
    if (lineBreak === -1) return content.length
    lineStart = lineBreak + 1
  }
  const lineBreak = content.indexOf('\n', lineStart)
  const lineEnd = lineBreak === -1 ? content.length : lineBreak
  return Math.min(lineStart + Math.max(0, column - 1), lineEnd)
}

/** 查找词原样当字面文字用时的正则写法（打开「正则」后用选中的文字预填查找词）。 */
export function escapeWorkbenchTextSearchRegExp(text: string): string {
  return text.replace(RegExpSyntaxCharacters, '\\$&')
}

interface LineCursor {
  line: number
  lineStart: number
  /** 当前行末尾的换行符的位置；最后一行是正文长度。 */
  lineEnd: number
}

function createLineCursor(content: string): LineCursor {
  const lineBreak = content.indexOf('\n')
  return { line: 1, lineStart: 0, lineEnd: lineBreak === -1 ? content.length : lineBreak }
}

/** 把游标挪到 position 所在的行（只往后挪；记着行尾，同一行里的多个匹配不重复找换行）。 */
function moveLineCursor(content: string, cursor: LineCursor, position: number): void {
  while (cursor.lineEnd < position) {
    cursor.line += 1
    cursor.lineStart = cursor.lineEnd + 1
    const lineBreak = content.indexOf('\n', cursor.lineStart)
    cursor.lineEnd = lineBreak === -1 ? content.length : lineBreak
  }
}

/** 与 CodeMirror 一样：匹配两头各自要么不挨着词字符，要么本身不是词字符。 */
function isWholeWordMatch(content: string, from: number, to: number): boolean {
  return (
    (!isWordCharacter(characterBefore(content, from)) || !isWordCharacter(characterAt(content, from)))
    && (!isWordCharacter(characterAt(content, to)) || !isWordCharacter(characterBefore(content, to)))
  )
}

function isWordCharacter(character: string): boolean {
  return !!character && WordCharacter.test(character)
}

function characterAt(text: string, index: number): string {
  if (index >= text.length) return ''
  return String.fromCodePoint(text.codePointAt(index)!)
}

function characterBefore(text: string, index: number): string {
  if (index <= 0) return ''
  const low = text.charCodeAt(index - 1)
  if (index >= 2 && isLowSurrogate(low) && isHighSurrogate(text.charCodeAt(index - 2)))
    return text.slice(index - 2, index)
  return text.charAt(index - 1)
}

function codePointLength(text: string, index: number): number {
  return isHighSurrogate(text.charCodeAt(index)) && isLowSurrogate(text.charCodeAt(index + 1)) ? 2 : 1
}

function skipLowSurrogate(text: string, index: number): number {
  return isLowSurrogate(text.charCodeAt(index)) ? index + 1 : index
}

function keepHighSurrogate(text: string, index: number): number {
  return isHighSurrogate(text.charCodeAt(index - 1)) ? index - 1 : index
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff
}

function isWhitespace(code: number): boolean {
  return code === 0x20 || code === 0x09 || code === 0x0b || code === 0x0c || code === 0x0d || code === 0xa0
    || code === 0xfeff || code === 0x3000
}

/** V8 的报错带着整个正则（`Invalid regular expression: /(/gmu: Unterminated group`），只留后面的原因。 */
function describeRegExpError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.replace(/^Invalid regular expression: \/.*\/[a-z]*: /su, '')
}
