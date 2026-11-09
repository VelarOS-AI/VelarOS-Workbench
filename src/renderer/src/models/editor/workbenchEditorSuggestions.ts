import type { WorkbenchProjectContextIndex } from '../project/workbenchProjectContextIndex'

export type WorkbenchEditorSuggestionKind =
  'file' | 'keyword' | 'project-symbol' | 'property' | 'symbol'

export interface WorkbenchEditorSuggestionRequest {
  path: Nullable<string>
  language: string
  content: string
  selectionStart: number
  selectionEnd: number
  replaceStart: number
  replaceEnd: number
  prefix: string
  currentLine: string
  beforeCursor: string
  afterCursor: string
}

export interface WorkbenchEditorSuggestion {
  id: string
  label: string
  insertText: string
  replaceStart: number
  replaceEnd: number
  kind: WorkbenchEditorSuggestionKind
  detail?: string
}

const IDENTIFIER_PATTERN = /[A-Za-z_$][\w$-]*/g
const PREFIX_PATTERN = /[A-Za-z_$][\w$-]*$/
const CONTEXT_WINDOW = 2400
const SUGGESTION_LIMIT = 8
const AUTO_TRIGGER_PREFIX_LENGTH = 2
const AUTO_TRIGGER_CHARACTERS = new Set(['.', '/', '@', '<'])

interface CandidateSuggestion {
  label: string
  insertText: string
  kind: WorkbenchEditorSuggestionKind
  count: number
  sourceWeight: number
  detail?: string
}

export interface WorkbenchEditorSuggestionOptions {
  limit?: number
  projectContext?: WorkbenchProjectContextIndex
}

const LANGUAGE_KEYWORDS: Record<
  string,
  Array<{ label: string; kind: WorkbenchEditorSuggestionKind }>
> = {
  CSS: [
    { label: 'display', kind: 'property' },
    { label: 'position', kind: 'property' },
    { label: 'color', kind: 'property' },
    { label: 'background', kind: 'property' },
    { label: 'border', kind: 'property' },
    { label: 'margin', kind: 'property' },
    { label: 'padding', kind: 'property' },
    { label: 'grid-template-columns', kind: 'property' },
    { label: 'align-items', kind: 'property' },
    { label: 'justify-content', kind: 'property' },
  ],
  JSON: [
    { label: 'true', kind: 'keyword' },
    { label: 'false', kind: 'keyword' },
    { label: 'null', kind: 'keyword' },
  ],
  Markdown: [
    { label: '# ', kind: 'keyword' },
    { label: '## ', kind: 'keyword' },
    { label: '### ', kind: 'keyword' },
    { label: '> ', kind: 'keyword' },
    { label: '- ', kind: 'keyword' },
    { label: '- [ ] ', kind: 'keyword' },
    { label: '[text](path)', kind: 'keyword' },
    { label: '![alt](path)', kind: 'keyword' },
    { label: '**bold**', kind: 'keyword' },
    { label: '`code`', kind: 'keyword' },
    { label: '```', kind: 'keyword' },
  ],
  'Git Ignore': [
    { label: 'node_modules/', kind: 'file' },
    { label: 'dist/', kind: 'file' },
    { label: '*.log', kind: 'keyword' },
    { label: '!.gitkeep', kind: 'keyword' },
    { label: '# ', kind: 'keyword' },
  ],
  Text: [],
  TypeScript: [
    { label: 'const', kind: 'keyword' },
    { label: 'let', kind: 'keyword' },
    { label: 'function', kind: 'keyword' },
    { label: 'return', kind: 'keyword' },
    { label: 'async', kind: 'keyword' },
    { label: 'await', kind: 'keyword' },
    { label: 'import', kind: 'keyword' },
    { label: 'export', kind: 'keyword' },
    { label: 'interface', kind: 'keyword' },
    { label: 'type', kind: 'keyword' },
  ],
  JavaScript: [
    { label: 'const', kind: 'keyword' },
    { label: 'let', kind: 'keyword' },
    { label: 'function', kind: 'keyword' },
    { label: 'return', kind: 'keyword' },
    { label: 'async', kind: 'keyword' },
    { label: 'await', kind: 'keyword' },
    { label: 'import', kind: 'keyword' },
    { label: 'export', kind: 'keyword' },
  ],
}

function clamp(value: number, content: string): number {
  return Math.min(Math.max(value, 0), content.length)
}

function getLineAtCursor(content: string, cursor: number): string {
  const lineStart = content.lastIndexOf('\n', Math.max(0, cursor - 1)) + 1
  const lineEnd = content.indexOf('\n', cursor)
  return content.slice(lineStart, lineEnd === -1 ? content.length : lineEnd)
}

function getPrefixRange(content: string, selectionStart: number, selectionEnd: number) {
  const start = clamp(Math.min(selectionStart, selectionEnd), content)
  const end = clamp(Math.max(selectionStart, selectionEnd), content)

  if (start !== end)
    return {
      replaceStart: start,
      replaceEnd: end,
      prefix: content.slice(start, end),
    }

  const beforeCursor = content.slice(0, start)
  const match = beforeCursor.match(PREFIX_PATTERN)
  const prefix = match?.[0] ?? ''

  return {
    replaceStart: start - prefix.length,
    replaceEnd: start,
    prefix,
  }
}

function normalizeLanguage(language: string): string {
  if (language === 'TSX' || language === 'JSX')
    return language === 'TSX' ? 'TypeScript' : 'JavaScript'

  return language
}

function languageKeywords(
  language: string
): Array<{ label: string; kind: WorkbenchEditorSuggestionKind }> {
  const normalizedLanguage = normalizeLanguage(language)
  return LANGUAGE_KEYWORDS[normalizedLanguage] ?? LANGUAGE_KEYWORDS.Text
}

function scoreCandidate(candidate: CandidateSuggestion, prefix: string): number {
  const searchableText = `${candidate.label} ${candidate.detail ?? ''} ${candidate.insertText}`

  if (!prefix) return candidate.sourceWeight + candidate.count

  if (candidate.label === prefix) return -1

  if (candidate.label.startsWith(prefix)) return 1000 + candidate.sourceWeight + candidate.count

  if (candidate.label.toLowerCase().startsWith(prefix.toLowerCase()))
    return 700 + candidate.sourceWeight + candidate.count

  if (searchableText.toLowerCase().includes(prefix.toLowerCase()))
    return 300 + candidate.sourceWeight + candidate.count

  return -1
}

export function buildWorkbenchEditorSuggestionRequest({
  path,
  language,
  content,
  selectionStart,
  selectionEnd,
}: {
  path: Nullable<string>
  language: string
  content: string
  selectionStart: number
  selectionEnd: number
}): WorkbenchEditorSuggestionRequest {
  const start = clamp(selectionStart, content)
  const end = clamp(selectionEnd, content)
  const range = getPrefixRange(content, start, end)

  return {
    path,
    language: normalizeLanguage(language),
    content,
    selectionStart: start,
    selectionEnd: end,
    replaceStart: range.replaceStart,
    replaceEnd: range.replaceEnd,
    prefix: range.prefix,
    currentLine: getLineAtCursor(content, start),
    beforeCursor: content.slice(Math.max(0, start - CONTEXT_WINDOW), start),
    afterCursor: content.slice(end, Math.min(content.length, end + CONTEXT_WINDOW)),
  }
}

export function buildLocalWorkbenchEditorSuggestions(
  request: WorkbenchEditorSuggestionRequest,
  options: WorkbenchEditorSuggestionOptions = {}
): WorkbenchEditorSuggestion[] {
  const limit = options.limit ?? SUGGESTION_LIMIT
  const { projectContext } = options
  const counts = new Map<string, number>()

  for (const match of request.content.matchAll(IDENTIFIER_PATTERN)) {
    const label = match[0]
    if (label === request.prefix || label.length < 2) {
      continue
    }

    counts.set(label, (counts.get(label) ?? 0) + 1)
  }

  const currentFileCandidates: CandidateSuggestion[] = Array.from(counts.entries()).map(
    ([label, count]) => ({
      label,
      insertText: label,
      count,
      kind: 'symbol',
      sourceWeight: 40,
    })
  )
  const keywordCandidates: CandidateSuggestion[] = languageKeywords(request.language).map(
    (keyword) => ({
      label: keyword.label,
      insertText: keyword.label,
      count: 1,
      kind: keyword.kind,
      sourceWeight: 20,
    })
  )
  const projectSymbolCandidates: CandidateSuggestion[] =
    projectContext?.symbols
      .filter((symbol) => symbol.path !== request.path)
      .map((symbol) => ({
        label: symbol.label,
        insertText: symbol.label,
        count: symbol.count,
        kind: 'project-symbol',
        sourceWeight: 30,
        detail: symbol.path,
      })) ?? []
  const fileCandidates: CandidateSuggestion[] =
    projectContext?.files.map((file) => ({
      label: file.name,
      insertText: file.path,
      count: 1,
      kind: 'file',
      sourceWeight: 10,
      detail: file.path,
    })) ?? []

  const candidates = [
    ...currentFileCandidates,
    ...projectSymbolCandidates,
    ...fileCandidates,
    ...keywordCandidates,
  ]

  const seen = new Set<string>()
  return candidates
    .map((candidate) => ({
      ...candidate,
      score: scoreCandidate(candidate, request.prefix),
    }))
    .filter((candidate) => candidate.score > 0)
    .sort((left, right) => right.score - left.score || left.label.localeCompare(right.label))
    .filter((candidate) => {
      const key = `${candidate.kind}:${candidate.insertText.toLowerCase()}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    .slice(0, limit)
    .map((candidate) => ({
      id: `${candidate.kind}:${candidate.label}:${request.replaceStart}:${request.replaceEnd}`,
      label: candidate.label,
      insertText: candidate.insertText,
      replaceStart: request.replaceStart,
      replaceEnd: request.replaceEnd,
      kind: candidate.kind,
      detail: candidate.detail,
    }))
}

export function shouldAutoOpenWorkbenchEditorSuggestions(
  request: WorkbenchEditorSuggestionRequest,
  suggestions: readonly WorkbenchEditorSuggestion[]
): boolean {
  if (!suggestions.length || request.selectionStart !== request.selectionEnd) return false

  if (request.prefix.length >= AUTO_TRIGGER_PREFIX_LENGTH) return true

  const previousCharacter = request.beforeCursor.at(-1) ?? ''
  return AUTO_TRIGGER_CHARACTERS.has(previousCharacter)
}
