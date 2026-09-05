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
const STACK_PREFIX = /^(\s*at\s+)/u
const STACK_LOCATION = /^(.*):(\d+):(\d+)$/u
const STACK_PSEUDO_LOCATION = /^(?:<anonymous>|native|index\s+\d+)$/iu
const QUOTED_JSON_KEY = /"(?:[^"\\]|\\.)*"\s*:|'(?:[^'\\]|\\.)*'\s*:/g
const UNQUOTED_JSON_KEY =
  /[{,](\s*)([A-Za-z_$][\w$]*\s*:)(?=\s*(?:["'[{]|-?\d|true\b|false\b|null\b|undefined\b))/g
const QUOTED_STRING = /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g
const NUMBER_LITERAL =
  /(?<![\w.])-?(?:0[xX][\dA-Fa-f]+|0[bB][01]+|0[oO][0-7]+|(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)(?![\w.])/g
const BOOLEAN_LITERAL = /\b(?:true|false|null|undefined)\b/g
// http(s) URL；结尾去掉常见句读（. , ; : ! ? ) ] }）避免把句尾标点吞进链接。
const URL_LITERAL = /https?:\/\/[^\s<>"'`\])}]*[^\s<>"'`\])}.,;:!?]/gi
// eslint-disable-next-line no-control-regex -- buffers a trailing ESC until the next process chunk.
const INCOMPLETE_ANSI_SUFFIX = /\x1b(?:\[[0-9;:]*)?$/u
const MAX_PENDING_ANSI_LENGTH = 64
const MAX_SEMANTIC_TEXT_LENGTH = 64 * 1024
const MAX_RENDERED_SEMANTIC_TOKENS = 4096

interface SemanticMatch {
  start: number
  end: number
  kind: WorkbenchConsoleOutputTokenKind
  priority: number
}

interface AnsiForeground {
  kind: WorkbenchConsoleOutputTokenKind
  color?: string
}

interface AnsiStreamState {
  foreground: Nullable<AnsiForeground>
  pendingSequence: string
}

export type WorkbenchConsoleOutputStream = 'stdout' | 'stderr' | 'system' | 'input'

export interface WorkbenchConsoleOutputChunk {
  text: string
  stream: WorkbenchConsoleOutputStream
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
  kind:
    WorkbenchConsoleOutputTokenKind | ((match: RegExpExecArray) => WorkbenchConsoleOutputTokenKind),
  priority: number
): SemanticMatch[] {
  const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`
  const regex = new RegExp(pattern.source, flags)
  const matches: SemanticMatch[] = []

  for (const match of text.matchAll(regex)) {
    const start = match.index ?? 0
    const end = start + match[0].length
    const resolvedKind = typeof kind === 'function' ? kind(match) : kind

    matches.push({ start, end, kind: resolvedKind, priority })
  }

  return matches
}

function collectUnquotedJsonKeyMatches(text: string): SemanticMatch[] {
  const matches: SemanticMatch[] = []

  for (const match of text.matchAll(UNQUOTED_JSON_KEY)) {
    const wholeStart = match.index ?? 0
    const leadingWhitespace = match[1] ?? ''
    const key = match[2] ?? ''
    const delimiterLength = match[0].length - leadingWhitespace.length - key.length
    const start = wholeStart + delimiterLength + leadingWhitespace.length

    matches.push({
      start,
      end: start + key.length,
      kind: 'jsonKey',
      priority: 80,
    })
  }

  return matches
}

function mergeSemanticMatches(text: string, matches: SemanticMatch[]): WorkbenchConsoleOutputToken[] {
  const selected: SemanticMatch[] = []
  const occupied = new Uint8Array(text.length)
  const byPriority = matches.toSorted(
    (left, right) =>
      right.priority - left.priority ||
      right.end - right.start - (left.end - left.start) ||
      left.start - right.start
  )

  for (const candidate of byPriority) {
    let segmentStart = -1

    for (let index = candidate.start; index < candidate.end; index += 1) {
      if (occupied[index]) {
        if (segmentStart >= 0) {
          selected.push({ ...candidate, start: segmentStart, end: index })
          occupied.fill(1, segmentStart, index)
          segmentStart = -1
        }
      } else if (segmentStart < 0) {
        segmentStart = index
      }
    }

    if (segmentStart >= 0) {
      selected.push({ ...candidate, start: segmentStart })
      occupied.fill(1, segmentStart, candidate.end)
    }
  }

  const sorted = selected.toSorted((left, right) => left.start - right.start)
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

function highlightStackLocation(location: string): Nullable<WorkbenchConsoleOutputToken[]> {
  const positioned = location.match(STACK_LOCATION)
  if (positioned) {
    const [, path, lineNo, columnNo] = positioned
    if (!path) return null

    return [
      { text: path, kind: 'stackPath' },
      { text: `:${lineNo ?? ''}:${columnNo ?? ''}`, kind: 'plain' },
    ]
  }

  if (STACK_PSEUDO_LOCATION.test(location)) return [{ text: location, kind: 'stackPath' }]

  return null
}

/**
 * Parses V8/Node/Bun stack frames without ever dispatching back into the general highlighter.
 * Returning null is intentional: malformed `at ...` text is then rendered by the finite generic
 * path instead of making the stack and semantic paths recursively call one another.
 */
function tryHighlightStackTraceLine(line: string): Nullable<WorkbenchConsoleOutputToken[]> {
  const prefixMatch = line.match(STACK_PREFIX)
  if (!prefixMatch) return null

  const prefix = prefixMatch[0]
  const frame = line.slice(prefix.length)
  if (!frame) return null

  const withFunction = /^(.+?) \((.*)\)(.*)$/u.exec(frame)
  if (withFunction) {
    const [, functionName = '', location = '', trailing = ''] = withFunction
    if (!functionName || !location) return null

    const locationTokens = highlightStackLocation(location) ?? [
      { text: location, kind: 'stackPath' as const },
    ]
    const tokens: WorkbenchConsoleOutputToken[] = []
    pushToken(tokens, prefix, 'plain')
    pushToken(tokens, functionName, 'stackFunction')
    pushToken(tokens, ' (', 'plain')
    for (const token of locationTokens) pushToken(tokens, token.text, token.kind)
    pushToken(tokens, `)${trailing}`, 'plain')
    return tokens
  }

  const locationTokens = highlightStackLocation(frame)
  if (!locationTokens) return null

  return [{ text: prefix, kind: 'plain' }, ...locationTokens]
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

    const spacing = line.slice(index).match(/^[\t ]+/u)?.[0] ?? ''
    if (spacing) {
      tokens.push({ text: spacing, kind: 'plain' })
      index += spacing.length
    }
  } else {
    const clockMatch = line.slice(index).match(CLOCK_TIMESTAMP)
    if (clockMatch?.index === 0) {
      tokens.push({ text: clockMatch[0], kind: 'timestamp' })
      index += clockMatch[0].length

      const spacing = line.slice(index).match(/^[\t ]+/u)?.[0] ?? ''
      if (spacing) {
        tokens.push({ text: spacing, kind: 'plain' })
        index += spacing.length
      }
    }
  }

  const levelMatch = line.slice(index).match(LOG_LEVEL)
  if (levelMatch?.index === 0) {
    tokens.push({
      text: levelMatch[0],
      kind: resolveLogLevelKind(levelMatch[1] ?? ''),
    })
    index += levelMatch[0].length
  }

  return { consumed: index, tokens }
}

function highlightGeneralSemanticLine(line: string): WorkbenchConsoleOutputToken[] {
  const { consumed, tokens: prefixTokens } = highlightLogPrefix(line)
  const remainder = line.slice(consumed)

  if (!remainder) return prefixTokens

  const remainderTokens = mergeSemanticMatches(remainder, [
    // URL 优先级最高：整段 URL 先占位，避免内部的数字/字符串把它切碎。
    ...collectRegexMatches(remainder, URL_LITERAL, 'link', 100),
    ...collectRegexMatches(remainder, QUOTED_JSON_KEY, 'jsonKey', 80),
    ...collectUnquotedJsonKeyMatches(remainder),
    ...collectRegexMatches(remainder, QUOTED_STRING, 'string', 60),
    ...collectRegexMatches(remainder, BOOLEAN_LITERAL, 'boolean', 40),
    ...collectRegexMatches(remainder, NUMBER_LITERAL, 'number', 40),
  ])

  return [...prefixTokens, ...remainderTokens]
}

function highlightSemanticLine(line: string): WorkbenchConsoleOutputToken[] {
  return tryHighlightStackTraceLine(line) ?? highlightGeneralSemanticLine(line)
}

function highlightSemanticText(text: string): WorkbenchConsoleOutputToken[] {
  const analyzedText = text.slice(0, MAX_SEMANTIC_TEXT_LENGTH)
  const lines = analyzedText.split('\n')
  const tokens: WorkbenchConsoleOutputToken[] = []

  lines.forEach((line, lineIndex) => {
    if (lineIndex > 0) pushToken(tokens, '\n', 'plain')
    for (const token of highlightSemanticLine(line)) {
      pushToken(tokens, token.text, token.kind)
    }
  })

  if (tokens.length > MAX_RENDERED_SEMANTIC_TOKENS) {
    const limited = tokens.slice(0, MAX_RENDERED_SEMANTIC_TOKENS)
    const consumed = limited.reduce((length, token) => length + token.text.length, 0)
    pushToken(limited, text.slice(consumed), 'plain')
    return limited
  }

  pushToken(tokens, text.slice(analyzedText.length), 'plain')

  return tokens
}

function splitIncompleteAnsiSuffix(text: string): {
  complete: string
  pending: string
} {
  const match = text.match(INCOMPLETE_ANSI_SUFFIX)
  const pending = match?.[0] ?? ''
  if (!pending || pending.length > MAX_PENDING_ANSI_LENGTH) return { complete: text, pending: '' }

  return { complete: text.slice(0, -pending.length), pending }
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
          pushToken(tokens, token.text, activeAnsiForeground.kind, activeAnsiForeground.color)
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

  try {
    return highlightWithAnsi(text).tokens
  } catch {
    // Console decoration must never be able to take down the entire renderer.
    return [{ text, kind: 'plain' }]
  }
}

export function highlightWorkbenchConsoleOutputSequence(
  chunks: ReadonlyArray<string | WorkbenchConsoleOutputChunk>
): WorkbenchConsoleOutputToken[][] {
  const states = new Map<string, AnsiStreamState>()

  return chunks.map((chunk) => {
    const text = typeof chunk === 'string' ? chunk : chunk.text
    const stream = typeof chunk === 'string' ? 'default' : chunk.stream
    const carriesState = stream === 'default' || stream === 'stdout' || stream === 'stderr'

    if (!carriesState) return highlightWorkbenchConsoleOutput(text)

    const state = states.get(stream) ?? {
      foreground: null,
      pendingSequence: '',
    }
    const buffered = splitIncompleteAnsiSuffix(`${state.pendingSequence}${text}`)

    try {
      const highlighted = highlightWithAnsi(buffered.complete, state.foreground)
      states.set(stream, {
        foreground: highlighted.foreground,
        pendingSequence: buffered.pending,
      })
      return highlighted.tokens
    } catch {
      states.set(stream, { foreground: null, pendingSequence: '' })
      return text ? [{ text, kind: 'plain' }] : []
    }
  })
}
