import type { WorkbenchLanguageServiceDisplayPartKind } from '@velaros/core/types'

export type WorkbenchEditorHoverPartStyle =
  | 'keyword'
  | 'type'
  | 'name'
  | 'function'
  | 'number'
  | 'string'
  | 'operator'
  | 'punctuation'
  | 'plain'
  | 'link'
  | 'location'

export interface WorkbenchEditorHoverTextToken {
  text: string
  style: WorkbenchEditorHoverPartStyle
}

const DISPLAY_PART_STYLE: Readonly<
  Record<WorkbenchLanguageServiceDisplayPartKind, WorkbenchEditorHoverPartStyle>
> = {
  aliasName: 'type',
  className: 'type',
  enumName: 'type',
  fieldName: 'name',
  interfaceName: 'type',
  keyword: 'keyword',
  lineBreak: 'plain',
  numericLiteral: 'number',
  stringLiteral: 'string',
  localName: 'name',
  methodName: 'function',
  moduleName: 'type',
  operator: 'operator',
  parameterName: 'name',
  propertyName: 'name',
  punctuation: 'punctuation',
  space: 'plain',
  text: 'plain',
  typeParameterName: 'type',
  enumMemberName: 'name',
  functionName: 'function',
  regularExpressionLiteral: 'string',
  link: 'link',
  linkName: 'link',
  linkText: 'link',
}

const HOVER_MODIFIER_TEXT_PATTERN = /^\([\w\s]+\)$/
const HOVER_PRIMITIVE_TYPE_NAMES = new Set([
  'string',
  'number',
  'boolean',
  'bigint',
  'symbol',
  'undefined',
  'null',
  'void',
  'never',
  'unknown',
  'any',
  'object',
  'this',
  'true',
  'false',
])

const MODIFIER_PATTERN = /\([\w\s]+\)/g
const PUNCTUATION_PATTERN = /[?:|;,<>[\]{}]/g
const STRING_PATTERN = /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g
const NUMBER_PATTERN = /-?\d+(?:\.\d+)?/g
const TS_STATEMENT_KEYWORD_PATTERN =
  /\b(?:const|let|var|function|class|interface|type|enum|namespace|module|declare|export|import|from|as|extends|implements|return|await|async|new|typeof|instanceof|in|of|if|else|switch|case|break|continue|throw|try|catch|finally|for|while|do|yield|super|static|get|set|abstract|override|public|private|protected)\b/g
const TS_TYPE_KEYWORD_PATTERN =
  /\b(?:readonly|string|number|boolean|bigint|symbol|undefined|null|void|never|unknown|any|object|this|true|false)\b/g
const IDENTIFIER_PATTERN = /\b[A-Za-z_$][\w$]*\b/g
const PASCAL_CASE_TYPE_PATTERN = /\b[A-Z][\w$]*\b/g
const PATH_PATTERN = /(?:\/|\.\/|\.\.\/)[\w./-]+(?::\d+:\d+)?|\b[\w.-]+\.(?:ts|tsx|js|jsx|mjs|cjs|json|css|md)\b(?::\d+:\d+)?/g

interface PlainTextMatch {
  start: number
  end: number
  style: WorkbenchEditorHoverPartStyle
}

function pushToken(
  tokens: WorkbenchEditorHoverTextToken[],
  text: string,
  style: WorkbenchEditorHoverPartStyle
): void {
  if (!text) return
  const last = tokens.at(-1)
  if (last && last.style === style) {
    last.text += text
    return
  }
  tokens.push({ text, style })
}

function collectPlainTextMatches(
  text: string,
  pattern: RegExp,
  style: WorkbenchEditorHoverPartStyle,
  matches: PlainTextMatch[]
): void {
  pattern.lastIndex = 0
  for (const match of text.matchAll(pattern)) {
    const value = match[0]
    if (!value) continue
    matches.push({
      start: match.index ?? 0,
      end: (match.index ?? 0) + value.length,
      style,
    })
  }
}

function isOverlapping(matches: readonly PlainTextMatch[], start: number, end: number): boolean {
  return matches.some((match) => start < match.end && end > match.start)
}

function tokenizePlainHoverText(text: string): WorkbenchEditorHoverTextToken[] {
  const matches: PlainTextMatch[] = []
  collectPlainTextMatches(text, MODIFIER_PATTERN, 'keyword', matches)
  collectPlainTextMatches(text, PUNCTUATION_PATTERN, 'punctuation', matches)
  collectPlainTextMatches(text, STRING_PATTERN, 'string', matches)
  collectPlainTextMatches(text, NUMBER_PATTERN, 'number', matches)
  collectPlainTextMatches(text, TS_STATEMENT_KEYWORD_PATTERN, 'keyword', matches)
  collectPlainTextMatches(text, TS_TYPE_KEYWORD_PATTERN, 'type', matches)
  collectPlainTextMatches(text, PATH_PATTERN, 'location', matches)

  const typeMatches: PlainTextMatch[] = []
  collectPlainTextMatches(text, PASCAL_CASE_TYPE_PATTERN, 'type', typeMatches)
  for (const match of typeMatches) {
    if (isOverlapping(matches, match.start, match.end)) continue
    matches.push(match)
  }

  const identifierMatches: PlainTextMatch[] = []
  collectPlainTextMatches(text, IDENTIFIER_PATTERN, 'name', identifierMatches)
  for (const match of identifierMatches) {
    if (isOverlapping(matches, match.start, match.end)) continue
    matches.push(match)
  }

  matches.sort((left, right) => left.start - right.start || right.end - left.end)

  const tokens: WorkbenchEditorHoverTextToken[] = []
  let cursor = 0
  for (const match of matches) {
    if (match.start < cursor) continue
    pushToken(tokens, text.slice(cursor, match.start), 'plain')
    pushToken(tokens, text.slice(match.start, match.end), match.style)
    cursor = match.end
  }
  pushToken(tokens, text.slice(cursor), 'plain')
  return tokens
}

function resolvePrimitiveTypeStyle(text: string): WorkbenchEditorHoverPartStyle | null {
  const trimmed = text.trim()
  return HOVER_PRIMITIVE_TYPE_NAMES.has(trimmed) ? 'type' : null
}

export function resolveWorkbenchHoverDisplayPartStyle(
  kind: WorkbenchLanguageServiceDisplayPartKind,
  text = ''
): WorkbenchEditorHoverPartStyle {
  if (kind === 'text') {
    if (HOVER_MODIFIER_TEXT_PATTERN.test(text)) return 'keyword'
    const primitiveStyle = resolvePrimitiveTypeStyle(text)
    if (primitiveStyle) return primitiveStyle
    if (/^[A-Z][\w$]*$/.test(text.trim())) return 'type'
  }

  if (kind === 'keyword') {
    const primitiveStyle = resolvePrimitiveTypeStyle(text)
    if (primitiveStyle) return primitiveStyle
  }

  return DISPLAY_PART_STYLE[kind] ?? 'plain'
}

export function workbenchHoverDisplayPartNeedsSubTokenization(
  kind: WorkbenchLanguageServiceDisplayPartKind,
  text = ''
): boolean {
  if (kind !== 'text' && kind !== 'space') return false
  return resolveWorkbenchHoverDisplayPartStyle(kind, text) === 'plain'
}

function decorateWorkbenchEditorHoverPartSpan(
  span: HTMLSpanElement,
  style: WorkbenchEditorHoverPartStyle,
  partClassName: (style: WorkbenchEditorHoverPartStyle) => string
): void {
  span.className = partClassName(style)
  span.dataset.hoverPart = style
}

export function tokenizeWorkbenchEditorHoverPlainText(text: string): WorkbenchEditorHoverTextToken[] {
  if (!text) return []
  return tokenizePlainHoverText(text)
}

export function appendWorkbenchEditorHoverTokens(
  container: HTMLElement,
  tokens: readonly WorkbenchEditorHoverTextToken[],
  partClassName: (style: WorkbenchEditorHoverPartStyle) => string
): void {
  for (const token of tokens) {
    if (token.text === '\n') {
      container.append(document.createElement('br'))
      continue
    }

    const span = document.createElement('span')
    decorateWorkbenchEditorHoverPartSpan(span, token.style, partClassName)
    span.textContent = token.text
    container.append(span)
  }
}

export function appendWorkbenchEditorHoverText(
  container: HTMLElement,
  {
    parts,
    fallbackText,
    partClassName,
  }: {
    parts?: ReadonlyArray<{ text: string; kind: WorkbenchLanguageServiceDisplayPartKind }>
    fallbackText: string
    partClassName: (style: WorkbenchEditorHoverPartStyle) => string
  }
): void {
  if (parts && parts.length > 0) {
    for (const part of parts) {
      if (part.kind === 'lineBreak') {
        container.append(document.createElement('br'))
        continue
      }

      if (workbenchHoverDisplayPartNeedsSubTokenization(part.kind, part.text)) {
        appendWorkbenchEditorHoverTokens(
          container,
          tokenizeWorkbenchEditorHoverPlainText(part.text),
          partClassName
        )
        continue
      }

      const span = document.createElement('span')
      decorateWorkbenchEditorHoverPartSpan(
        span,
        resolveWorkbenchHoverDisplayPartStyle(part.kind, part.text),
        partClassName
      )
      span.textContent = part.text
      container.append(span)
    }
    return
  }

  appendWorkbenchEditorHoverTokens(
    container,
    tokenizeWorkbenchEditorHoverPlainText(fallbackText),
    partClassName
  )
}
