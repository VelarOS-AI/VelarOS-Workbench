export type WorkbenchConsoleOutputTokenKind =
  | 'plain'
  | 'link'
  | 'timestamp'
  | 'levelDbg'
  | 'levelInfo'
  | 'levelWarn'
  | 'levelError'
  | 'jsonKey'
  | 'string'
  | 'number'
  | 'boolean'
  | 'stackFunction'
  | 'stackPath'
  | 'ansiBlack'
  | 'ansiRed'
  | 'ansiGreen'
  | 'ansiYellow'
  | 'ansiBlue'
  | 'ansiMagenta'
  | 'ansiCyan'
  | 'ansiWhite'
  | 'ansiBrightBlack'
  | 'ansiBrightRed'
  | 'ansiBrightGreen'
  | 'ansiBrightYellow'
  | 'ansiBrightBlue'
  | 'ansiBrightMagenta'
  | 'ansiBrightCyan'
  | 'ansiBrightWhite'

export interface WorkbenchConsoleOutputToken {
  text: string
  kind: WorkbenchConsoleOutputTokenKind
}

// eslint-disable-next-line no-control-regex -- ANSI escape matching intentionally starts with the ESC control character.
const ANSI_PATTERN = /\x1b\[[0-9;]*m/g

const ANSI_FOREGROUND: Readonly<Record<number, WorkbenchConsoleOutputTokenKind>> = {
  30: 'ansiBlack',
  31: 'ansiRed',
  32: 'ansiGreen',
  33: 'ansiYellow',
  34: 'ansiBlue',
  35: 'ansiMagenta',
  36: 'ansiCyan',
  37: 'ansiWhite',
  90: 'ansiBrightBlack',
  91: 'ansiBrightRed',
  92: 'ansiBrightGreen',
  93: 'ansiBrightYellow',
  94: 'ansiBrightBlue',
  95: 'ansiBrightMagenta',
  96: 'ansiBrightCyan',
  97: 'ansiBrightWhite',
}

const ISO_TIMESTAMP =
  /\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:?\d{2})?/
const CLOCK_TIMESTAMP = /\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?/
const LOG_LEVEL = /\[(DBG|DEBUG|INFO|LOG|WARN|WARNING|ERR|ERROR|TRACE|FATAL)\]/i
const STACK_WITH_FUNCTION =
  /^(\s*at\s+)((?:async\s+)?(?:[\w.$<>]+|\[[^\]]+\]))(\s+\()([^:]+):(\d+):(\d+)(\))/m
const STACK_FILE_ONLY = /^(\s*at\s+)([^(\s]+):(\d+):(\d+)/m
const QUOTED_JSON_KEY = /"(?:[^"\\]|\\.)*"\s*:|'(?:[^'\\]|\\.)*'\s*:/g
const UNQUOTED_JSON_KEY = /\b[A-Za-z_$][\w$]*\s*:/g
const QUOTED_STRING = /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g
const NUMBER_LITERAL = /\b-?\d+(?:\.\d+)?(?:e[+-]?\d+)?\b/gi
const BOOLEAN_LITERAL = /\b(?:true|false|null|undefined)\b/g
// http(s) URL；结尾去掉常见句读（. , ; : ! ? ) ] }）避免把句尾标点吞进链接。
const URL_LITERAL = /https?:\/\/[^\s<>"'`\])}]*[^\s<>"'`\])}.,;:!?]/gi

interface SemanticMatch {
  start: number
  end: number
  kind: WorkbenchConsoleOutputTokenKind
}

function pushToken(
  tokens: WorkbenchConsoleOutputToken[],
  text: string,
  kind: WorkbenchConsoleOutputTokenKind
): void {
  if (!text) return

  const last = tokens.at(-1)
  if (last?.kind === kind) {
    last.text += text
    return
  }

  tokens.push({ text, kind })
}

function parseAnsiKind(sequence: string): Nullable<WorkbenchConsoleOutputTokenKind> {
  const body = sequence.slice(2, -1)
  if (!body) return null

  let resolved: Nullable<WorkbenchConsoleOutputTokenKind> = null

  for (const part of body.split(';')) {
    if (!part) continue

    const code = Number(part)
    if (!Number.isFinite(code)) continue

    if (code === 0) {
      resolved = null
      continue
    }

    const mapped = ANSI_FOREGROUND[code]
    if (mapped) resolved = mapped
  }

  return resolved
}

function resolveLogLevelKind(level: string): WorkbenchConsoleOutputTokenKind {
  const normalized = level.toUpperCase()

  if (normalized === 'DBG' || normalized === 'DEBUG' || normalized === 'TRACE') return 'levelDbg'
  if (normalized === 'WARN' || normalized === 'WARNING') return 'levelWarn'
  if (normalized === 'ERR' || normalized === 'ERROR' || normalized === 'FATAL') return 'levelError'

  return 'levelInfo'
}

function collectRegexMatches(
  text: string,
  pattern: RegExp,
  kind: WorkbenchConsoleOutputTokenKind | ((match: RegExpExecArray) => WorkbenchConsoleOutputTokenKind)
): SemanticMatch[] {
  const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`
  const regex = new RegExp(pattern.source, flags)
  const matches: SemanticMatch[] = []

  for (const match of text.matchAll(regex)) {
    const start = match.index ?? 0
    const end = start + match[0].length
    const resolvedKind = typeof kind === 'function' ? kind(match) : kind

    matches.push({ start, end, kind: resolvedKind })
  }

  return matches
}

function mergeSemanticMatches(text: string, matches: SemanticMatch[]): WorkbenchConsoleOutputToken[] {
  const sorted = matches.toSorted((left, right) => left.start - right.start || right.end - left.end)
  const tokens: WorkbenchConsoleOutputToken[] = []
  let cursor = 0

  for (const match of sorted) {
    if (match.start < cursor) continue

    pushToken(tokens, text.slice(cursor, match.start), 'plain')
    pushToken(tokens, text.slice(match.start, match.end), match.kind)
    cursor = match.end
  }

  pushToken(tokens, text.slice(cursor), 'plain')

  return tokens
}

function highlightStackTraceLine(line: string): WorkbenchConsoleOutputToken[] {
  const withFunction = line.match(STACK_WITH_FUNCTION)
  if (withFunction) {
    const [, prefix, fnName, openParen, filePath, lineNo, columnNo, closeParen] = withFunction
    return [
      { text: prefix ?? '', kind: 'plain' },
      { text: fnName ?? '', kind: 'stackFunction' },
      { text: openParen ?? '', kind: 'plain' },
      { text: filePath ?? '', kind: 'stackPath' },
      { text: `:${lineNo ?? ''}:${columnNo ?? ''}${closeParen ?? ''}`, kind: 'plain' },
    ]
  }

  const fileOnly = line.match(STACK_FILE_ONLY)
  if (fileOnly) {
    const [, prefix, filePath, lineNo, columnNo] = fileOnly
    return [
      { text: prefix ?? '', kind: 'plain' },
      { text: filePath ?? '', kind: 'stackPath' },
      { text: `:${lineNo ?? ''}:${columnNo ?? ''}`, kind: 'plain' },
    ]
  }

  return highlightSemanticLine(line)
}

function highlightLogPrefix(line: string): { consumed: number; tokens: WorkbenchConsoleOutputToken[] } {
  let index = 0
  const tokens: WorkbenchConsoleOutputToken[] = []

  const leadingWhitespace = line.match(/^\s+/)
  if (leadingWhitespace) {
    tokens.push({ text: leadingWhitespace[0], kind: 'plain' })
    index = leadingWhitespace[0].length
  }

  const isoMatch = line.slice(index).match(ISO_TIMESTAMP)
  if (isoMatch?.index === 0) {
    tokens.push({ text: isoMatch[0], kind: 'timestamp' })
    index += isoMatch[0].length

    if (line[index] === ' ') {
      tokens.push({ text: ' ', kind: 'plain' })
      index += 1
    }
  } else {
    const clockMatch = line.slice(index).match(CLOCK_TIMESTAMP)
    if (clockMatch?.index === 0) {
      tokens.push({ text: clockMatch[0], kind: 'timestamp' })
      index += clockMatch[0].length

      if (line[index] === ' ') {
        tokens.push({ text: ' ', kind: 'plain' })
        index += 1
      }
    }
  }

  const levelMatch = line.slice(index).match(LOG_LEVEL)
  if (levelMatch?.index === 0) {
    tokens.push({ text: levelMatch[0], kind: resolveLogLevelKind(levelMatch[1] ?? '') })
    index += levelMatch[0].length
  }

  return { consumed: index, tokens }
}

function highlightSemanticLine(line: string): WorkbenchConsoleOutputToken[] {
  if (/^\s*at\s+/.test(line)) return highlightStackTraceLine(line)

  const { consumed, tokens: prefixTokens } = highlightLogPrefix(line)
  const remainder = line.slice(consumed)

  if (!remainder) return prefixTokens

  const remainderTokens = mergeSemanticMatches(remainder, [
    // URL 优先级最高：整段 URL 先占位，避免内部的数字/字符串把它切碎。
    ...collectRegexMatches(remainder, URL_LITERAL, 'link'),
    ...collectRegexMatches(remainder, QUOTED_JSON_KEY, 'jsonKey'),
    ...collectRegexMatches(remainder, UNQUOTED_JSON_KEY, 'jsonKey'),
    ...collectRegexMatches(remainder, QUOTED_STRING, 'string'),
    ...collectRegexMatches(remainder, BOOLEAN_LITERAL, 'boolean'),
    ...collectRegexMatches(remainder, NUMBER_LITERAL, 'number'),
  ])

  return [...prefixTokens, ...remainderTokens]
}

function highlightSemanticText(text: string): WorkbenchConsoleOutputToken[] {
  const lines = text.split('\n')
  const tokens: WorkbenchConsoleOutputToken[] = []

  lines.forEach((line, lineIndex) => {
    if (lineIndex > 0) pushToken(tokens, '\n', 'plain')
    for (const token of highlightSemanticLine(line)) {
      pushToken(tokens, token.text, token.kind)
    }
  })

  return tokens
}

function highlightWithAnsi(text: string): WorkbenchConsoleOutputToken[] {
  if (!text.includes('\x1b[')) return highlightSemanticText(text)

  const tokens: WorkbenchConsoleOutputToken[] = []
  let cursor = 0
  let activeAnsiKind: Nullable<WorkbenchConsoleOutputTokenKind> = null

  for (const match of text.matchAll(ANSI_PATTERN)) {
    const start = match.index ?? 0
    const chunk = text.slice(cursor, start)

    if (chunk) {
      const semanticTokens = highlightSemanticText(chunk)
      for (const token of semanticTokens) {
        // 链接优先于 ANSI 颜色，保证带色 URL（如 vite 的 Local 地址）仍可点击。
        pushToken(tokens, token.text, token.kind === 'link' ? 'link' : (activeAnsiKind ?? token.kind))
      }
    }

    activeAnsiKind = parseAnsiKind(match[0])
    cursor = start + match[0].length
  }

  const tail = text.slice(cursor)
  if (tail) {
    for (const token of highlightSemanticText(tail)) {
      pushToken(tokens, token.text, token.kind === 'link' ? 'link' : (activeAnsiKind ?? token.kind))
    }
  }

  return tokens
}

export function highlightWorkbenchConsoleOutput(text: string): WorkbenchConsoleOutputToken[] {
  if (!text) return []

  return highlightWithAnsi(text)
}
