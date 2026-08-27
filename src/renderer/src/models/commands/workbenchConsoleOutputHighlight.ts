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
  | 'ansiCustom'

export interface WorkbenchConsoleOutputToken {
  text: string
  kind: WorkbenchConsoleOutputTokenKind
  color?: string
}

// eslint-disable-next-line no-control-regex -- ANSI escape matching intentionally starts with the ESC control character.
const ANSI_PATTERN = /\x1b\[[0-9;:]*m/g

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

interface AnsiForeground {
  kind: WorkbenchConsoleOutputTokenKind
  color?: string
}

function pushToken(
  tokens: WorkbenchConsoleOutputToken[],
  text: string,
  kind: WorkbenchConsoleOutputTokenKind,
  color?: string
): void {
  if (!text) return

  const last = tokens.at(-1)
  if (last?.kind === kind && last.color === color) {
    last.text += text
    return
  }

  tokens.push({ text, kind, ...(color ? { color } : {}) })
}

function parseAnsiParameters(sequence: string): number[] {
  const body = sequence.slice(2, -1)
  if (!body) return [0]

  return body.split(';').flatMap((parameter) => {
    if (!parameter.includes(':')) return [parameter ? Number(parameter) : 0]

    return parameter.split(':').map((part) => (part ? Number(part) : Number.NaN))
  })
}

function resolveAnsiIndexedForeground(index: number): Nullable<AnsiForeground> {
  if (!Number.isInteger(index) || index < 0 || index > 255) return null

  if (index < 8) return { kind: ANSI_FOREGROUND[30 + index] ?? 'plain' }
  if (index < 16) return { kind: ANSI_FOREGROUND[90 + index - 8] ?? 'plain' }

  if (index < 232) {
    const cubeIndex = index - 16
    const levels = [0, 95, 135, 175, 215, 255]
    const red = levels[Math.floor(cubeIndex / 36)] ?? 0
    const green = levels[Math.floor((cubeIndex % 36) / 6)] ?? 0
    const blue = levels[cubeIndex % 6] ?? 0
    return { kind: 'ansiCustom', color: `rgb(${red} ${green} ${blue})` }
  }

  const gray = 8 + (index - 232) * 10
  return { kind: 'ansiCustom', color: `rgb(${gray} ${gray} ${gray})` }
}

function resolveAnsiRgbForeground(red: number, green: number, blue: number): Nullable<AnsiForeground> {
  const channels = [red, green, blue]
  if (channels.some((channel) => !Number.isInteger(channel) || channel < 0 || channel > 255))
    return null

  return { kind: 'ansiCustom', color: `rgb(${red} ${green} ${blue})` }
}

function readExtendedAnsiForeground(
  parameters: number[],
  start: number
): { foreground: Nullable<AnsiForeground>; consumedThrough: number } {
  const mode = parameters[start + 1]
  if (mode === 5)
    return {
      foreground: resolveAnsiIndexedForeground(parameters[start + 2] ?? Number.NaN),
      consumedThrough: Math.min(parameters.length - 1, start + 2),
    }

  if (mode === 2) {
    const channels: number[] = []
    let cursor = start + 2
    while (cursor < parameters.length && channels.length < 3) {
      const channel = parameters[cursor]
      if (Number.isFinite(channel)) channels.push(channel ?? Number.NaN)
      cursor += 1
    }

    return {
      foreground: resolveAnsiRgbForeground(
        channels[0] ?? Number.NaN,
        channels[1] ?? Number.NaN,
        channels[2] ?? Number.NaN
      ),
      consumedThrough: Math.max(start, cursor - 1),
    }
  }

  return {
    foreground: null,
    consumedThrough: Math.min(parameters.length - 1, start + 1),
  }
}

function parseAnsiForeground(
  sequence: string,
  current: Nullable<AnsiForeground>
): Nullable<AnsiForeground> {
  const parameters = parseAnsiParameters(sequence)
  let resolved = current

  for (let index = 0; index < parameters.length; index += 1) {
    const code = parameters[index]
    if (!Number.isFinite(code)) continue

    if (code === 0) {
      resolved = null
      continue
    }

    if (code === 39) {
      resolved = null
      continue
    }

    if (code === 38) {
      const extended = readExtendedAnsiForeground(parameters, index)
      if (extended.foreground) resolved = extended.foreground
      index = extended.consumedThrough
      continue
    }

    // Background/underline colors have the same payload shape as foreground colors. Consume their
    // parameters as one unit so palette values such as 31 are not mistaken for foreground red.
    if (code === 48 || code === 58) {
      index = readExtendedAnsiForeground(parameters, index).consumedThrough
      continue
    }

    const mapped = ANSI_FOREGROUND[code]
    if (mapped) resolved = { kind: mapped }
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

function highlightWithAnsi(
  text: string,
  initialForeground: Nullable<AnsiForeground> = null
): { tokens: WorkbenchConsoleOutputToken[]; foreground: Nullable<AnsiForeground> } {
  const tokens: WorkbenchConsoleOutputToken[] = []
  let cursor = 0
  let activeAnsiForeground = initialForeground

  for (const match of text.matchAll(ANSI_PATTERN)) {
    const start = match.index ?? 0
    const chunk = text.slice(cursor, start)

    if (chunk) {
      const semanticTokens = highlightSemanticText(chunk)
      for (const token of semanticTokens) {
        // 链接优先于 ANSI 颜色，保证带色 URL（如 vite 的 Local 地址）仍可点击。
        if (token.kind === 'link' || !activeAnsiForeground) {
          pushToken(tokens, token.text, token.kind, token.color)
        } else {
          pushToken(
            tokens,
            token.text,
            activeAnsiForeground.kind,
            activeAnsiForeground.color
          )
        }
      }
    }

    activeAnsiForeground = parseAnsiForeground(match[0], activeAnsiForeground)
    cursor = start + match[0].length
  }

  const tail = text.slice(cursor)
  if (tail) {
    for (const token of highlightSemanticText(tail)) {
      if (token.kind === 'link' || !activeAnsiForeground) {
        pushToken(tokens, token.text, token.kind, token.color)
      } else {
        pushToken(tokens, token.text, activeAnsiForeground.kind, activeAnsiForeground.color)
      }
    }
  }

  return { tokens, foreground: activeAnsiForeground }
}

export function highlightWorkbenchConsoleOutput(text: string): WorkbenchConsoleOutputToken[] {
  if (!text) return []

  return highlightWithAnsi(text).tokens
}

export function highlightWorkbenchConsoleOutputSequence(
  chunks: readonly string[]
): WorkbenchConsoleOutputToken[][] {
  let foreground: Nullable<AnsiForeground> = null

  return chunks.map((chunk) => {
    const highlighted = highlightWithAnsi(chunk, foreground)
    foreground = highlighted.foreground
    return highlighted.tokens
  })
}
