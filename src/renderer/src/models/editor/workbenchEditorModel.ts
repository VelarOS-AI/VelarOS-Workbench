export interface WorkbenchEditorGoToLineTarget {
  line: number
  column: number
}

export type WorkbenchEditorOutlineKind =
  | 'class'
  | 'constant'
  | 'enum'
  | 'function'
  | 'heading'
  | 'interface'
  | 'method'
  | 'type'

export interface WorkbenchEditorOutlineItem {
  id: string
  label: string
  kind: WorkbenchEditorOutlineKind
  line: number
  column: number
  depth?: number
}

export type WorkbenchEditorProblemKind = 'console' | 'debugger' | 'todo' | 'trailing-whitespace'

export interface WorkbenchEditorProblemItem {
  id: string
  kind: WorkbenchEditorProblemKind
  severity: 'hint' | 'warning'
  line: number
  column: number
  excerpt: string
}

const MAX_EDITOR_OUTLINE_ITEMS = 120
const MAX_EDITOR_PROBLEMS = 120
const SYMBOL_LINE_PATTERNS: Array<{
  kind: WorkbenchEditorOutlineKind
  pattern: RegExp
}> = [
  { kind: 'class', pattern: /^\s*(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/ },
  { kind: 'interface', pattern: /^\s*(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/ },
  { kind: 'type', pattern: /^\s*(?:export\s+)?type\s+([A-Za-z_$][\w$]*)/ },
  { kind: 'enum', pattern: /^\s*(?:export\s+)?enum\s+([A-Za-z_$][\w$]*)/ },
  {
    kind: 'function',
    pattern: /^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/,
  },
  {
    kind: 'constant',
    pattern: /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::|=|\()/,
  },
  {
    kind: 'method',
    pattern:
      /^\s*(?:public\s+|private\s+|protected\s+|static\s+|async\s+)*([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*(?::[^{]+)?\{/,
  },
]

export function getWorkbenchEditorLineCount(content: string): number {
  return content ? content.split('\n').length : 1
}

export function parseWorkbenchGoToLineInput(
  input: string,
  maxLine: number
): Nullable<WorkbenchEditorGoToLineTarget> {
  const trimmedInput = input.trim()
  if (!trimmedInput) return null

  const match = /^(\d+)(?:\s*[:,]\s*(\d+))?$/.exec(trimmedInput)
  if (!match) return null

  const line = Number.parseInt(match[1], 10)
  const column = match[2] ? Number.parseInt(match[2], 10) : 1
  if (line < 1 || column < 1) return null

  return {
    line: Math.min(Math.max(1, Math.floor(maxLine)), line),
    column,
  }
}

function matchMarkdownHeading(line: string): Nullable<{ label: string; column: number }> {
  const match = /^(#{1,6})\s+(.+?)\s*$/.exec(line)
  if (!match) return null

  return {
    label: match[2],
    column: match[1].length + 2,
  }
}

function matchCodeSymbol(
  line: string
): Nullable<{ kind: WorkbenchEditorOutlineKind; label: string; column: number }> {
  for (const candidate of SYMBOL_LINE_PATTERNS) {
    const match = candidate.pattern.exec(line)
    const label = match?.[1]
    if (!label) {
      continue
    }

    return {
      kind: candidate.kind,
      label,
      column: Math.max(1, line.indexOf(label) + 1),
    }
  }

  return null
}

function mapLanguageServiceSymbolKind(
  kind: string
): WorkbenchEditorOutlineKind {
  switch (kind) {
    case 'class':
    case 'constant':
    case 'enum':
    case 'function':
    case 'interface':
    case 'method':
      return kind
    default:
      return 'type'
  }
}

export function buildWorkbenchEditorOutlineFromLanguageService(
  symbols: ReadonlyArray<{
    name: string
    kind: string
    depth: number
    line: number
    column: number
  }>
): WorkbenchEditorOutlineItem[] {
  return symbols
    .map((symbol) => ({
      id: `${symbol.line}:${symbol.kind}:${symbol.name}`,
      label: symbol.name,
      kind: mapLanguageServiceSymbolKind(symbol.kind),
      line: symbol.line,
      column: symbol.column,
      depth: symbol.depth,
    }))
    .slice(0, MAX_EDITOR_OUTLINE_ITEMS)
}

export function buildWorkbenchEditorOutline(
  content: string,
  path: string,
  languageServiceSymbols?: ReadonlyArray<{
    name: string
    kind: string
    depth: number
    line: number
    column: number
  }>
): WorkbenchEditorOutlineItem[] {
  if (languageServiceSymbols && languageServiceSymbols.length > 0) return buildWorkbenchEditorOutlineFromLanguageService(languageServiceSymbols)
  const isMarkdown = /\.(md|mdx)$/i.test(path)
  const items: WorkbenchEditorOutlineItem[] = []

  content.split('\n').forEach((line, index) => {
    const lineNumber = index + 1
    const markdownHeading = isMarkdown ? matchMarkdownHeading(line) : null
    if (markdownHeading) {
      items.push({
        id: `${lineNumber}:heading:${markdownHeading.label}`,
        label: markdownHeading.label,
        kind: 'heading',
        line: lineNumber,
        column: markdownHeading.column,
      })
      return
    }

    const codeSymbol = matchCodeSymbol(line)
    if (codeSymbol) {
      items.push({
        id: `${lineNumber}:${codeSymbol.kind}:${codeSymbol.label}`,
        label: codeSymbol.label,
        kind: codeSymbol.kind,
        line: lineNumber,
        column: codeSymbol.column,
      })
    }
  })

  return items.slice(0, MAX_EDITOR_OUTLINE_ITEMS)
}

export function buildWorkbenchEditorProblems(content: string): WorkbenchEditorProblemItem[] {
  const problems: WorkbenchEditorProblemItem[] = []

  content.split('\n').forEach((line, index) => {
    if (problems.length >= MAX_EDITOR_PROBLEMS) return

    const lineNumber = index + 1
    const todoMatch = /\b(TODO|FIXME|HACK|XXX)\b:?/i.exec(line)
    if (todoMatch) {
      problems.push({
        id: `${lineNumber}:todo:${todoMatch.index}`,
        kind: 'todo',
        severity: 'hint',
        line: lineNumber,
        column: todoMatch.index + 1,
        excerpt: line.trim(),
      })
    }

    const consoleMatch = /\bconsole\.(log|debug|warn|error)\s*\(/.exec(line)
    if (consoleMatch && problems.length < MAX_EDITOR_PROBLEMS) {
      problems.push({
        id: `${lineNumber}:console:${consoleMatch.index}`,
        kind: 'console',
        severity: 'warning',
        line: lineNumber,
        column: consoleMatch.index + 1,
        excerpt: line.trim(),
      })
    }

    const debuggerIndex = line.indexOf('debugger')
    if (debuggerIndex !== -1 && problems.length < MAX_EDITOR_PROBLEMS) {
      problems.push({
        id: `${lineNumber}:debugger:${debuggerIndex}`,
        kind: 'debugger',
        severity: 'warning',
        line: lineNumber,
        column: debuggerIndex + 1,
        excerpt: line.trim(),
      })
    }

    const trailingWhitespaceMatch = /[ \t]+$/.exec(line)
    if (trailingWhitespaceMatch && problems.length < MAX_EDITOR_PROBLEMS) {
      problems.push({
        id: `${lineNumber}:trailing-whitespace:${trailingWhitespaceMatch.index}`,
        kind: 'trailing-whitespace',
        severity: 'hint',
        line: lineNumber,
        column: trailingWhitespaceMatch.index + 1,
        excerpt: line.trim(),
      })
    }
  })

  return problems.slice(0, MAX_EDITOR_PROBLEMS)
}
