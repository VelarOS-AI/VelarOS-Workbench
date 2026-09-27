import { Language, LanguageSupport } from '@codemirror/language'
import type { Extension } from '@codemirror/state'
import { highlightCode, type Highlighter, tagHighlighter } from '@lezer/highlight'

import type { WorkbenchThemeId } from '../settings/workbenchPreferences'

import { resolveWorkbenchCodeMirrorLanguage } from './workbenchCodeMirrorLanguage'
import { getWorkbenchCodeHighlightSpecs } from './workbenchCodeMirrorTheme'

/** 一段着色后的代码：颜色与字形取自编辑器的着色规则；`match` 表示这段落在查询词里。 */
export interface WorkbenchCodeSnippetToken {
  text: string
  style?: WorkbenchCodeTokenStyle
  match?: boolean
}

export interface WorkbenchCodeTokenStyle {
  color?: string
  fontWeight?: string
  fontStyle?: string
  textDecoration?: string
}

/** 片段着色结果缓存条数：搜索结果一屏几十条，打字时同一行会反复出现。 */
const MaxCachedSnippets = 400
/** 搜索摘要被截断时两头的省略号（见内容搜索的摘要压缩）。 */
const Ellipsis = '...'

const snippetCache = new Map<string, WorkbenchCodeSnippetToken[]>()
const languageCache = new Map<string, Nullable<Language>>()
const highlighterCache = new Map<WorkbenchThemeId, Highlighter>()

/**
 * 给搜索结果里的一行代码着色：按文件名认语言、用编辑器同一套着色规则，再把查询词标出来。认不出语言的按
 * 纯文本返回。只看这一行，跨行的字符串、注释中间截出来的片段着色可能不准，但不影响阅读。
 */
export function highlightWorkbenchCodeSnippet(options: {
  path: string
  text: string
  theme: WorkbenchThemeId
  query?: string
}): WorkbenchCodeSnippetToken[] {
  const query = options.query?.trim() ?? ''
  const key = `${options.theme}\0${languageKey(options.path)}\0${query}\0${options.text}`
  const cached = snippetCache.get(key)
  if (cached) {
    // 最近用过的挪到最后，淘汰时先丢最久没用的。
    snippetCache.delete(key)
    snippetCache.set(key, cached)
    return cached
  }
  const tokens = markQuery(highlight(options.path, options.text, options.theme), query)
  snippetCache.set(key, tokens)
  if (snippetCache.size > MaxCachedSnippets) {
    const oldest = snippetCache.keys().next().value
    if (oldest !== undefined) snippetCache.delete(oldest)
  }
  return tokens
}

function highlight(path: string, text: string, theme: WorkbenchThemeId): WorkbenchCodeSnippetToken[] {
  const head = text.startsWith(Ellipsis) ? Ellipsis : ''
  const tail = text.length > head.length && text.endsWith(Ellipsis) ? Ellipsis : ''
  const code = text.slice(head.length, text.length - tail.length)
  const language = languageFor(path)
  const tokens: WorkbenchCodeSnippetToken[] = head ? [{ text: head }] : []
  if (!language || !code) tokens.push({ text: code })
  else {
    const specs = getWorkbenchCodeHighlightSpecs(theme)
    highlightCode(
      code,
      language.parser.parse(code),
      highlighterFor(theme),
      (piece, classes) => tokens.push(classes ? { text: piece, style: styleOf(classes, specs) } : { text: piece }),
      () => tokens.push({ text: ' ' })
    )
  }
  if (tail) tokens.push({ text: tail })
  return tokens.filter((token) => token.text)
}

/** 每条规则一个类名（规则的下标），着色时再按下标取回它的样式。 */
function highlighterFor(theme: WorkbenchThemeId): Highlighter {
  const cached = highlighterCache.get(theme)
  if (cached) return cached
  const highlighter = tagHighlighter(
    getWorkbenchCodeHighlightSpecs(theme).map((spec, index) => ({ tag: spec.tag, class: `s${index}` }))
  )
  highlighterCache.set(theme, highlighter)
  return highlighter
}

function styleOf(
  classes: string,
  specs: ReturnType<typeof getWorkbenchCodeHighlightSpecs>
): WorkbenchCodeTokenStyle | undefined {
  const style: WorkbenchCodeTokenStyle = {}
  for (const name of classes.split(' ')) {
    const spec = specs[Number(name.slice(1))]
    if (!spec) continue
    if (typeof spec.color === 'string') style.color = spec.color
    if (typeof spec.fontWeight === 'string') style.fontWeight = spec.fontWeight
    if (typeof spec.fontStyle === 'string') style.fontStyle = spec.fontStyle
    if (typeof spec.textDecoration === 'string') style.textDecoration = spec.textDecoration
  }
  return Object.keys(style).length > 0 ? style : undefined
}

/** 把查询词（不分大小写）所在的部分切出来标上 `match`，着色不变。 */
function markQuery(tokens: WorkbenchCodeSnippetToken[], query: string): WorkbenchCodeSnippetToken[] {
  if (!query) return tokens
  const text = tokens.map((token) => token.text).join('')
  const haystack = text.toLowerCase()
  const needle = query.toLowerCase()
  const ranges: Array<[number, number]> = []
  for (let from = haystack.indexOf(needle); from >= 0; from = haystack.indexOf(needle, from + needle.length))
    ranges.push([from, from + needle.length])
  if (ranges.length === 0) return tokens
  const marked: WorkbenchCodeSnippetToken[] = []
  let offset = 0
  for (const token of tokens) {
    const start = offset
    const end = offset + token.text.length
    offset = end
    let cursor = start
    for (const [from, to] of ranges) {
      if (to <= cursor || from >= end) continue
      if (from > cursor) marked.push({ ...token, text: text.slice(cursor, from) })
      const stop = Math.min(to, end)
      marked.push({ ...token, text: text.slice(Math.max(from, cursor), stop), match: true })
      cursor = stop
    }
    if (cursor < end) marked.push({ ...token, text: text.slice(cursor, end) })
  }
  return marked
}

/** 同一种文件共用一个语言解析器：按扩展名认，没有扩展名（Dockerfile、.env）按整个文件名认。 */
function languageFor(path: string): Nullable<Language> {
  const key = languageKey(path)
  if (languageCache.has(key)) return languageCache.get(key) ?? null
  const support = resolveWorkbenchCodeMirrorLanguage(path, '')
  const language = support.mode === 'builtin' ? findLanguage(support.extension) : null
  languageCache.set(key, language)
  return language
}

function languageKey(path: string): string {
  const name = (path.split(/[\\/]/u).at(-1) ?? path).toLowerCase()
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot + 1) : name
}

function findLanguage(extension: Extension): Nullable<Language> {
  if (extension instanceof LanguageSupport) return extension.language
  if (extension instanceof Language) return extension
  if (Array.isArray(extension))
    for (const item of extension) {
      const found = findLanguage(item as Extension)
      if (found) return found
    }
  return null
}
