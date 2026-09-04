import { javascriptLanguage } from '@codemirror/lang-javascript'
import {
  highlightingFor,
  StreamLanguage,
  type StreamParser,
  StringStream,
} from '@codemirror/language'
import { javascript as JavaScriptParser } from '@codemirror/legacy-modes/mode/javascript'
import { type EditorState, type Extension, Prec, RangeSetBuilder } from '@codemirror/state'
import { Decoration, type DecorationSet, type EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view'
import { type Highlighter, highlightTree } from '@lezer/highlight'
import type { WorkbenchEditorLanguageContribution } from '@renderer/language/workbenchEditorLanguageContributions'

import {
  VELAR_LANGUAGE_KEYWORDS,
  VELAR_NODE_CONTEXTUAL_KEYWORDS,
  VELAR_WEB_CONTEXTUAL_KEYWORDS,
} from '@shared/contributions/velar/language'

interface VelarStreamState {
  stringQuote: string | null
  rawString: boolean
  regexpString: boolean
  interpolatedString: boolean
  interpolationDepth: number
  layoutString: boolean
  layoutIndent: number
  indentUnit: number
  lineIndent: number
  nextIndent: number
  nextIdentifierStyle: string | null
  memberAccess: boolean
  objectDepth: number
  objectKeyExpected: boolean
  embeddedJavaScript: boolean
  embeddedJavaScriptChecked: boolean
  embeddedJavaScriptClosing: boolean
  embeddedJavaScriptIndent: number
  embeddedJavaScriptState: unknown | null
  jsxDepth: number
  jsxTag: boolean
  jsxTagClosing: boolean
  jsxTagNameExpected: boolean
  jsxTagExpressionDepth: number
  jsxExpressionDepth: number
  jsxElementExpressionDepths: number[]
  lookBlockIndent: number | null
  pendingLookBlock: boolean
}

export const VELAR_EDITOR_KEYWORDS = VELAR_LANGUAGE_KEYWORDS

const Keywords = new Set<string>(VELAR_EDITOR_KEYWORDS)
const ExtensionContextualKeywords = new Set<string>([
  ...VELAR_NODE_CONTEXTUAL_KEYWORDS,
  ...VELAR_WEB_CONTEXTUAL_KEYWORDS,
])
const FrameworkDeclarationKeywords = new Set([
  'action',
  'component',
  'computed',
  'resource',
  'server',
  'state',
])

const BuiltinValueTypes = new Set([
  'bool',
  'number',
  'string',
  'unknown',
])

const BuiltinClassTypes = new Set([
  'Error',
  'List',
  'Map',
  'Promise',
  'Set',
])

function isExtensionContextualKeyword(stream: StringStream, word: string): boolean {
  if (!ExtensionContextualKeywords.has(word)) return false
  const before = stream.string.slice(0, stream.start).trim()
  const after = stream.string.slice(stream.pos).trimStart()
  const declarationStart = before.length === 0 || before === 'export'

  if (word === 'component' || word === 'server')
    return declarationStart
      && /^[A-Za-z_$][\w$]*(?:\s*(?:\(|<|:)|\s*$)/u.test(after)
  if (word === 'state' || word === 'computed' || word === 'resource' || word === 'action') return declarationStart && /^[A-Za-z_$][\w$]*\s*(?::|\(|=)/u.test(after)
  if (word === 'watch') return before.length === 0 && !after.startsWith('(') && /:\s*(?:\/\/.*)?$/u.test(after)
  if (word === 'expose') return before.length === 0 && after.startsWith('{')
  if (word === 'exposes') return /\bcomponent\b/u.test(before) && /^[A-Za-z_$]/u.test(after)
  if (word === 'look' || word === 'keyframes') return after.startsWith(':')
  if (word === 'css') return before === 'unsafe' || after.startsWith('`')
  return false
}

function canStartJsxTag(stream: StringStream, state: VelarStreamState): boolean {
  const contentDepth = state.jsxElementExpressionDepths.at(-1)
  if (contentDepth !== undefined && state.jsxExpressionDepth === contentDepth) return true
  const before = stream.string.slice(0, stream.start).trimEnd()
  return before.length === 0 || /(?:\breturn|=>|[=([{,:?])$/u.test(before)
}

function isInJsxContent(state: VelarStreamState): boolean {
  const contentDepth = state.jsxElementExpressionDepths.at(-1)
  return contentDepth !== undefined && state.jsxExpressionDepth === contentDepth
}

function resetString(state: VelarStreamState): void {
  state.stringQuote = null
  state.rawString = false
  state.regexpString = false
  state.interpolatedString = false
  state.interpolationDepth = 0
}

function inlineRawStringBody(source: string): string | null {
  const quote = source[0]
  if (quote !== '"' && quote !== "'" && quote !== '`') return null

  let body = ''
  for (let index = 1; index < source.length; index += 1) {
    const character = source[index]
    if (character !== quote) {
      body += character
      continue
    }
    if (source[index + 1] === quote) {
      body += quote
      index += 1
      continue
    }
    return body
  }
  return null
}

/**
 * `r"..."` remains a raw string in the language. The editor only assigns the
 * regexp presentation when the complete inline body contains unambiguous
 * pattern grammar, so ordinary raw paths such as `r"C:\\Users\\foo"` stay text.
 */
export function isLikelyVelarRawRegularExpressionLiteral(source: string): boolean {
  const body = inlineRawStringBody(source)
  if (!body) return false

  if (body.startsWith('^') || /(?<!\\)\$$/u.test(body)) return true
  if (/(^|[^\\])\[(?:\\.|[^\]])+\]/u.test(body)) return true
  if (/\\[bBdDsSwWAZzG]/u.test(body)) return true
  if (/(^|[^\\])(?:\.\*|\.\+|\([^)]*\)|\||\{\d+(?:,\d*)?\})/u.test(body)) return true
  return false
}

function readString(stream: StringStream, state: VelarStreamState, layout = false): string {
  const quote = state.stringQuote
  const style = state.regexpString ? 'regexp' : 'string'
  if (!quote) return style

  let escaped = false
  while (!stream.eol()) {
    const char = stream.next()
    if (!state.rawString && escaped) {
      escaped = false
      continue
    }
    if (!state.rawString && char === '\\') {
      escaped = true
      continue
    }
    if (state.interpolatedString && char === '{') {
      if (stream.peek() === '{') {
        stream.next()
        continue
      }
      if (stream.pos - 1 > stream.start) {
        stream.backUp(1)
        return style
      }
      state.interpolationDepth = 1
      return 'punctuation'
    }
    if (state.interpolatedString && char === '}' && stream.peek() === '}') {
      stream.next()
      continue
    }
    if (layout) continue
    if (char === quote && state.rawString && stream.peek() === quote) {
      stream.next()
      continue
    }
    if (char === quote) {
      resetString(state)
      break
    }
  }
  // Inline strings are recovery-bounded by their physical line. Only a quote
  // followed immediately by a newline enters the layout-string state below.
  if (stream.eol() && !layout) resetString(state)
  return style
}

function beginString(
  stream: StringStream,
  state: VelarStreamState,
  raw: boolean,
  interpolated: boolean
): string {
  const regexp = raw
    && isLikelyVelarRawRegularExpressionLiteral(stream.string.slice(stream.pos))
  const quote = stream.next()
  if (!quote) return 'string'
  state.stringQuote = quote
  state.rawString = raw
  state.regexpString = regexp
  state.interpolatedString = interpolated
  state.interpolationDepth = 0
  if (quote === '"' && stream.eol()) {
    state.layoutString = true
    state.layoutIndent = state.lineIndent
    return 'string'
  }
  return readString(stream, state)
}

function readNestedInterpolationString(stream: StringStream, raw: boolean): string {
  const quote = stream.next()
  if (!quote) return 'string'
  let escaped = false
  while (!stream.eol()) {
    const char = stream.next()
    if (!raw && escaped) {
      escaped = false
      continue
    }
    if (!raw && char === '\\') {
      escaped = true
      continue
    }
    if (char === quote && raw && stream.peek() === quote) {
      stream.next()
      continue
    }
    if (char === quote) break
  }
  return 'string'
}

function embeddedJavaScriptKind(stream: StringStream): 'checked' | 'unsafe' | null {
  if (stream.peek() !== '`') return null
  const header = stream.string.slice(0, stream.pos)
  if (/^\s*unsafe\s+js\s*$/u.test(header)) return 'unsafe'
  if (/^\s*extern\s+js(?:\s*\(.*\))?\s*$/u.test(header)) return 'checked'
  return null
}

function beginEmbeddedJavaScript(
  stream: StringStream,
  state: VelarStreamState,
  kind: 'checked' | 'unsafe'
): string {
  stream.next()
  state.embeddedJavaScript = true
  state.embeddedJavaScriptChecked = kind === 'checked'
  state.embeddedJavaScriptClosing = false
  state.embeddedJavaScriptIndent = state.lineIndent
  state.embeddedJavaScriptState = JavaScriptParser.startState?.(state.indentUnit) ?? {}
  return 'string'
}

function copyEmbeddedJavaScriptState(state: unknown | null): unknown | null {
  if (state === null) return null
  return JavaScriptParser.copyState?.(state) ?? state
}

const VelarParser: StreamParser<VelarStreamState> = {
  startState: (indentUnit) => ({
    stringQuote: null,
    rawString: false,
    regexpString: false,
    interpolatedString: false,
    interpolationDepth: 0,
    layoutString: false,
    layoutIndent: 0,
    indentUnit,
    lineIndent: 0,
    nextIndent: 0,
    nextIdentifierStyle: null,
    memberAccess: false,
    objectDepth: 0,
    objectKeyExpected: false,
    embeddedJavaScript: false,
    embeddedJavaScriptChecked: false,
    embeddedJavaScriptClosing: false,
    embeddedJavaScriptIndent: 0,
    embeddedJavaScriptState: null,
    jsxDepth: 0,
    jsxTag: false,
    jsxTagClosing: false,
    jsxTagNameExpected: false,
    jsxTagExpressionDepth: 0,
    jsxExpressionDepth: 0,
    jsxElementExpressionDepths: [],
    lookBlockIndent: null,
    pendingLookBlock: false,
  }),
  copyState: (state) => ({
    ...state,
    embeddedJavaScriptState: copyEmbeddedJavaScriptState(state.embeddedJavaScriptState),
    jsxElementExpressionDepths: [...state.jsxElementExpressionDepths],
  }),
  token(stream, state) {
    if (stream.sol()) {
      state.lineIndent = stream.indentation()
      state.nextIndent = state.lineIndent
      if (
        state.lookBlockIndent !== null
        && stream.string.trim().length > 0
        && state.lineIndent <= state.lookBlockIndent
      ) {
        state.lookBlockIndent = null
      }
      if (state.embeddedJavaScript) {
        const tail = stream.string.slice(state.lineIndent)
        state.embeddedJavaScriptClosing = state.lineIndent === state.embeddedJavaScriptIndent
          && (state.embeddedJavaScriptChecked
            ? /^`:\s*(?:\/\/.*)?$/u.test(tail)
            : /^`\s*(?:\/\/.*)?$/u.test(tail))
      }
      if (state.stringQuote && !state.layoutString) resetString(state)
      if (state.layoutString && state.interpolationDepth === 0) {
        const blank = stream.string.trim().length === 0
        const closing = state.lineIndent === state.layoutIndent
          && stream.string.slice(state.lineIndent).startsWith(state.stringQuote ?? '\0')
        if (closing) {
          if (state.lineIndent > 0) stream.match(/^\s+/u)
          stream.next()
          state.layoutString = false
          resetString(state)
          return 'string'
        }
        if (blank || state.lineIndent > state.layoutIndent) {
          if (!state.interpolatedString || blank) {
            stream.skipToEnd()
            return 'string'
          }
        }
        if (!blank && state.lineIndent <= state.layoutIndent) {
          state.layoutString = false
          resetString(state)
        }
      }
    }
    if (state.embeddedJavaScript) {
      if (state.embeddedJavaScriptClosing) {
        if (stream.eatSpace()) return null
        stream.next()
        state.embeddedJavaScript = false
        state.embeddedJavaScriptClosing = false
        state.embeddedJavaScriptState = null
        return 'string'
      }
      return JavaScriptParser.token(stream, state.embeddedJavaScriptState ?? {})
    }
    if (state.stringQuote && state.interpolationDepth === 0)
      return readString(stream, state, state.layoutString)
    if (stream.eatSpace()) return null
    if (stream.match('//')) {
      stream.skipToEnd()
      return 'comment'
    }

    if (state.jsxTag && state.jsxExpressionDepth === state.jsxTagExpressionDepth) {
      if (stream.match('/>')) {
        state.jsxTag = false
        state.jsxTagClosing = false
        state.jsxTagNameExpected = false
        return 'punctuation'
      }
      if (stream.eat('>')) {
        state.jsxTag = false
        if (state.jsxTagClosing) {
          state.jsxDepth = Math.max(0, state.jsxDepth - 1)
          state.jsxElementExpressionDepths.pop()
        } else {
          state.jsxDepth += 1
          state.jsxElementExpressionDepths.push(state.jsxTagExpressionDepth)
        }
        state.jsxTagClosing = false
        state.jsxTagNameExpected = false
        return 'punctuation'
      }
      if (stream.eat('{')) {
        state.jsxExpressionDepth = state.jsxTagExpressionDepth + 1
        return 'punctuation'
      }
      if (
        state.jsxTagNameExpected
        && stream.match(/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*/u)
      ) {
        state.jsxTagNameExpected = false
        return 'tag'
      }
      const quote = stream.peek()
      if (quote === '"' || quote === "'" || quote === '`')
        return beginString(stream, state, false, false)
      if (stream.match(/^[A-Za-z_$][\w$:-]*/u)) return 'attribute'
      if (stream.eat('=')) return 'operator'
      stream.next()
      return 'punctuation'
    }

    if (state.jsxExpressionDepth > 0 && state.interpolationDepth === 0) {
      if (stream.eat('{')) {
        state.jsxExpressionDepth += 1
        return 'punctuation'
      }
      if (stream.eat('}')) {
        state.jsxExpressionDepth -= 1
        return 'punctuation'
      }
    }

    if (stream.match(/^<>/u)) {
      state.jsxDepth += 1
      state.jsxElementExpressionDepths.push(state.jsxExpressionDepth)
      return 'punctuation'
    }
    if (stream.match(/^<\/>/u)) {
      state.jsxDepth = Math.max(0, state.jsxDepth - 1)
      state.jsxElementExpressionDepths.pop()
      return 'punctuation'
    }
    if (isInJsxContent(state) && stream.eat('{')) {
      const contentDepth = state.jsxElementExpressionDepths.at(-1) ?? 0
      state.jsxExpressionDepth = contentDepth + 1
      return 'punctuation'
    }
    if (canStartJsxTag(stream, state) && stream.match(/^<\/?(?=[A-Za-z_$])/u)) {
      state.jsxTag = true
      state.jsxTagClosing = stream.current() === '</'
      state.jsxTagNameExpected = true
      state.jsxTagExpressionDepth = state.jsxExpressionDepth
      return 'punctuation'
    }
    if (isInJsxContent(state)) {
      if (stream.match(/^[^<{]+/u)) return null
      stream.next()
      return null
    }

    if (stream.match(/^@[A-Za-z_$][\w$]*/u)) return 'meta'

    if (state.interpolationDepth > 0) {
      if (stream.match(/^(?:rf|f|r)(?=["'`])/u))
        return readNestedInterpolationString(stream, stream.current().includes('r'))
      const nestedQuote = stream.peek()
      if (nestedQuote === '"' || nestedQuote === "'" || nestedQuote === '`')
        return readNestedInterpolationString(stream, false)
      if (stream.eat('{')) {
        state.interpolationDepth += 1
        return 'punctuation'
      }
      if (stream.eat('}')) {
        state.interpolationDepth -= 1
        return 'punctuation'
      }
    }

    if (stream.match(/^(?:rf|f|r|p)(?=["'`])/u)) {
      const prefix = stream.current()
      return beginString(
        stream,
        state,
        prefix.includes('r'),
        prefix.includes('f') || prefix === 'p'
      )
    }

    const quote = stream.peek()
    const embeddedKind = quote === '`' ? embeddedJavaScriptKind(stream) : null
    if (embeddedKind) return beginEmbeddedJavaScript(stream, state, embeddedKind)
    if (quote === '"' || quote === "'" || quote === '`')
      return beginString(stream, state, false, quote === '`')

    if (stream.match(/^0(?:[xX][0-9A-Fa-f](?:_?[0-9A-Fa-f])*|[bB][01](?:_?[01])*|[oO][0-7](?:_?[0-7])*)/u))
      return 'number'
    if (stream.match(/^(?:\d(?:_?\d)*(?:\.\d(?:_?\d)*)?|\.\d(?:_?\d)*)(?:[eE][+-]?\d(?:_?\d)*)?/u))
      return 'number'
    if (stream.match(/^[A-Za-z_$][\w$]*/u)) {
      const word = stream.current()
      const nextIdentifierStyle = state.nextIdentifierStyle
      state.nextIdentifierStyle = null
      if (state.memberAccess) {
        state.memberAccess = false
        return /^\s*\(/u.test(stream.string.slice(stream.pos))
          ? 'propertyName.function'
          : 'propertyName'
      }
      if (
        state.objectDepth > 0
        && state.objectKeyExpected
        && /^\s*(?::|[,}])/u.test(stream.string.slice(stream.pos))
      ) {
        state.objectKeyExpected = false
        return 'propertyName'
      }
      if (state.objectDepth > 0 && state.objectKeyExpected) state.objectKeyExpected = false
      if (nextIdentifierStyle) return nextIdentifierStyle
      if (
        state.lookBlockIndent !== null
        && state.lineIndent > state.lookBlockIndent
        && stream.string.slice(state.lineIndent, stream.start).trim().length === 0
        && /^\s*=/u.test(stream.string.slice(stream.pos))
      ) return 'propertyName'
      if (Keywords.has(word) || isExtensionContextualKeyword(stream, word)) {
        if (word === 'def') state.nextIdentifierStyle = 'variableName.definition.function'
        else if (word === 'class') state.nextIdentifierStyle = 'className.definition'
        else if (FrameworkDeclarationKeywords.has(word))
          state.nextIdentifierStyle = 'variableName.definition.special'
        else if (word === 'type' || word === 'enum' || word === 'interface')
          state.nextIdentifierStyle = 'typeName.definition'
        else if (
          word === 'const'
          || word === 'let'
          || word === 'var'
          || word === 'state'
          || word === 'computed'
          || word === 'resource'
        )
          state.nextIdentifierStyle = 'variableName.definition'
        if (word === 'look') state.pendingLookBlock = true
        return 'keyword'
      }
      if (BuiltinValueTypes.has(word)) return 'atom'
      if (BuiltinClassTypes.has(word)) return 'className'
      if (/^[A-Z]/u.test(word)) return 'className'
      if (/^\s*\(/u.test(stream.string.slice(stream.pos))) return 'variableName.function'
      return 'variableName'
    }

    if (stream.eat(':')) {
      if (state.objectDepth > 0) state.objectKeyExpected = false
      if (/^\s*(?:\/\/.*)?$/u.test(stream.string.slice(stream.pos))) {
        state.nextIndent = state.lineIndent + state.indentUnit
        if (state.pendingLookBlock) state.lookBlockIndent = state.lineIndent
      }
      state.pendingLookBlock = false
      return 'punctuation'
    }
    if (stream.eat('.')) {
      state.memberAccess = true
      if (state.objectDepth > 0) state.objectKeyExpected = false
      return 'operator'
    }
    if (stream.eat('/') || stream.match(/^[+\-*%=!<>|&^~?:]+/u)) {
      state.memberAccess = false
      if (state.objectDepth > 0) state.objectKeyExpected = false
      return 'operator'
    }
    if (stream.match(/^[()[\]{},;]/u)) {
      const punctuation = stream.current()
      if (punctuation === '{') {
        state.objectDepth += 1
        state.objectKeyExpected = true
      } else if (punctuation === '}') {
        state.objectDepth = Math.max(0, state.objectDepth - 1)
        state.objectKeyExpected = false
      } else if (punctuation === ',' && state.objectDepth > 0) {
        state.objectKeyExpected = true
      }
      return 'punctuation'
    }
    stream.next()
    return null
  },
  indent: (state, textAfter) =>
    /^(?:else|catch|finally)\b/u.test(textAfter)
      ? Math.max(0, state.nextIndent - state.indentUnit)
      : state.nextIndent,
  languageData: {
    commentTokens: { line: '//' },
    closeBrackets: { brackets: ['(', '[', '{', "'", '"'] },
    indentOnInput: /^\s*(?:else|catch|finally):?$/u,
  },
}

export interface VelarEmbeddedJavaScriptRange {
  readonly from: number
  readonly to: number
}

interface ParsedVelarEmbeddedJavaScriptRange extends VelarEmbeddedJavaScriptRange {
  readonly tree: ReturnType<typeof javascriptLanguage.parser.parse>
}

function nextLineBoundary(
  source: string,
  lineStart: number
): { readonly lineEnd: number; readonly nextStart: number } {
  for (let index = lineStart; index < source.length; index += 1) {
    if (source[index] === '\n') return { lineEnd: index, nextStart: index + 1 }
    if (source[index] === '\r')
      return {
        lineEnd: index,
        nextStart: source[index + 1] === '\n' ? index + 2 : index + 1,
      }
  }
  return { lineEnd: source.length, nextStart: source.length }
}

/**
 * Replays the same state machine used by the editor language so the modern
 * JavaScript highlighter sees exactly the raw bodies that the Velar fallback
 * parser accepted. This deliberately does not rediscover blocks with a regex:
 * header-like text inside a Velar layout string must remain string content.
 */
export function findVelarEmbeddedJavaScriptRanges(
  source: string,
  tabSize = 4,
  indentUnit = 2
): readonly VelarEmbeddedJavaScriptRange[] {
  const state = VelarParser.startState?.(indentUnit)
  if (!state) return []

  const ranges: VelarEmbeddedJavaScriptRange[] = []
  let bodyStart: number | null = null
  let lineStart = 0

  while (lineStart < source.length) {
    const boundary = nextLineBoundary(source, lineStart)
    const stream = new StringStream(source.slice(lineStart, boundary.lineEnd), tabSize, indentUnit)

    while (!stream.eol()) {
      stream.start = stream.pos
      const embeddedBefore = state.embeddedJavaScript
      VelarParser.token(stream, state)
      if (stream.pos <= stream.start)
        throw new Error('VelarScript editor parser did not advance while locating embedded JavaScript')

      if (!embeddedBefore && state.embeddedJavaScript) {
        bodyStart = boundary.nextStart
      } else if (embeddedBefore && !state.embeddedJavaScript && bodyStart !== null) {
        ranges.push({ from: bodyStart, to: lineStart })
        bodyStart = null
      }
    }

    if (boundary.nextStart <= lineStart || boundary.nextStart >= source.length) break
    lineStart = boundary.nextStart
  }

  if (bodyStart !== null && bodyStart <= source.length)
    ranges.push({ from: bodyStart, to: source.length })
  return ranges
}

function parseVelarEmbeddedJavaScriptRanges(
  source: string
): readonly ParsedVelarEmbeddedJavaScriptRange[] {
  return findVelarEmbeddedJavaScriptRanges(source).map((range) => ({
    ...range,
    tree: javascriptLanguage.parser.parse(source.slice(range.from, range.to)),
  }))
}

function activeJavaScriptHighlighter(
  state: EditorState,
  scope: ReturnType<typeof javascriptLanguage.parser.parse>['topNode']['type']
): Highlighter {
  return {
    style: (tags) => highlightingFor(state, tags, scope),
  }
}

export function buildVelarEmbeddedJavaScriptHighlightDecorations(
  state: EditorState,
  visibleRanges: readonly VelarEmbeddedJavaScriptRange[] = [{ from: 0, to: state.doc.length }],
  parsedRanges = parseVelarEmbeddedJavaScriptRanges(state.doc.toString())
): DecorationSet {
  const decorations: Array<{ readonly from: number; readonly to: number; readonly value: Decoration }> = []
  const marks = new Map<string, Decoration>()

  for (const embedded of parsedRanges) {
    const highlighter = activeJavaScriptHighlighter(state, embedded.tree.topNode.type)
    for (const visible of visibleRanges) {
      const from = Math.max(embedded.from, visible.from)
      const to = Math.min(embedded.to, visible.to)
      if (from >= to) continue
      highlightTree(
        embedded.tree,
        highlighter,
        (tokenFrom, tokenTo, classes) => {
          const value = marks.get(classes) ?? Decoration.mark({ class: classes })
          marks.set(classes, value)
          decorations.push({
            from: embedded.from + tokenFrom,
            to: embedded.from + tokenTo,
            value,
          })
        },
        from - embedded.from,
        to - embedded.from
      )
    }
  }

  decorations.sort((left, right) => left.from - right.from || left.to - right.to)
  const builder = new RangeSetBuilder<Decoration>()
  let previousIdentity = ''
  for (const decoration of decorations) {
    const identity = `${decoration.from}:${decoration.to}:${String(decoration.value.spec.class)}`
    if (identity === previousIdentity) continue
    previousIdentity = identity
    builder.add(decoration.from, decoration.to, decoration.value)
  }
  return builder.finish()
}

const velarEmbeddedJavaScriptHighlighting = Prec.highest(ViewPlugin.fromClass(
  class {
    decorations: DecorationSet
    private parsedRanges: readonly ParsedVelarEmbeddedJavaScriptRange[]

    constructor(view: EditorView) {
      this.parsedRanges = parseVelarEmbeddedJavaScriptRanges(view.state.doc.toString())
      this.decorations = this.build(view)
    }

    public update(update: ViewUpdate): void {
      if (update.docChanged)
        this.parsedRanges = parseVelarEmbeddedJavaScriptRanges(update.state.doc.toString())
      if (
        update.docChanged
        || update.viewportChanged
        || update.transactions.some((transaction) => transaction.reconfigured)
      )
        this.decorations = this.build(update.view)
    }

    private build(view: EditorView): DecorationSet {
      return buildVelarEmbeddedJavaScriptHighlightDecorations(
        view.state,
        view.visibleRanges,
        this.parsedRanges
      )
    }
  },
  { decorations: (plugin) => plugin.decorations }
))

export function velarScript(): Extension {
  return [StreamLanguage.define(VelarParser), velarEmbeddedJavaScriptHighlighting]
}

export const VelarWorkbenchEditorLanguage = {
  id: 'velarscript',
  languageId: 'velar',
  extensions: ['vel'],
  languages: ['velar', 'velarscript'],
  createExtension: velarScript,
  basicSyntax: {
    keywords: VELAR_EDITOR_KEYWORDS,
    lineComment: '//',
  },
  project: {
    markers: ['velar.json'],
    commands: [
      { id: 'install', label: 'Install Dependencies', command: 'velar', args: ['install'] },
      { id: 'update', label: 'Update Dependencies', command: 'velar', args: ['update'] },
      { id: 'check', label: 'Check', command: 'velar', args: ['check'] },
      { id: 'run', label: 'Run Core Project', command: 'velar', args: ['run'] },
      { id: 'format', label: 'Format Project', command: 'velar', args: ['format'] },
      { id: 'format-check', label: 'Check Formatting', command: 'velar', args: ['format', '--check'] },
      { id: 'dev', label: 'Dev Server', command: 'velar', args: ['dev'] },
      { id: 'test', label: 'Test', command: 'velar', args: ['test'] },
      { id: 'test-browser', label: 'Browser Test', command: 'velar', args: ['test', '--browser'] },
      { id: 'build', label: 'Production Build', command: 'velar', args: ['build'] },
      { id: 'verify', label: 'Verify Production Build', command: 'velar', args: ['verify'] },
      { id: 'preview', label: 'Production Preview', command: 'velar', args: ['preview'] },
      {
        id: 'verify-deployment',
        label: 'Verify Deployed Site',
        command: 'velar',
        args: ['verify-deployment'],
      },
    ],
  },
} satisfies WorkbenchEditorLanguageContribution
