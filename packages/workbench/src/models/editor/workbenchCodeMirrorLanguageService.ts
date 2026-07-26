import type { Completion, CompletionContext } from '@codemirror/autocomplete'
import { pickedCompletion } from '@codemirror/autocomplete'
import type { ChangeSpec, EditorState } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'

import { isPresent } from '@velaros-ai/core'

import type {
  WorkbenchLanguageServiceCompletionItem,
  WorkbenchLanguageServiceCompletionTextEdit,
  WorkbenchLanguageServiceDiagnostic,
  WorkbenchLanguageServiceOpenFile,
  WorkbenchLanguageServicePositionRequest,
  WorkbenchLanguageServiceRange,
  WorkbenchLanguageServiceTextEdit,
} from '../../contracts/index'
import {
  getWorkbenchPathExtension,
  resolveBuiltinWorkbenchLanguageService,
  type WorkbenchLanguageServiceDescriptor,
} from '../../language/workbenchLanguageServices'
import type { WorkbenchOpenEditorTab } from '../../types/workbenchTypes'

import {
  WORKBENCH_COMPLETION_RETURN_TYPE,
  type WorkbenchCompletionPresentation,
} from './workbenchCodeMirrorCompletionPresentation'

export function resolveWorkbenchBuiltinLanguageServiceRuntime(
  path: Nullable<string>
): Nullable<WorkbenchLanguageServiceDescriptor['runtime']> {
  const extension = getWorkbenchPathExtension(path)
  if (!extension) return null
  return resolveBuiltinWorkbenchLanguageService(extension)?.runtime ?? null
}

export function usesWorkbenchTypeScriptLanguageService(path: Nullable<string>): boolean {
  return resolveWorkbenchBuiltinLanguageServiceRuntime(path) === 'typescript-language-service'
}

export function usesWorkbenchBuiltinLanguageService(path: Nullable<string>): boolean {
  const runtime = resolveWorkbenchBuiltinLanguageServiceRuntime(path)
  return (
    runtime === 'typescript-language-service' ||
    runtime === 'html-language-service' ||
    runtime === 'css-language-service'
  )
}

export function usesWorkbenchHtmlLanguageService(path: Nullable<string>): boolean {
  return resolveWorkbenchBuiltinLanguageServiceRuntime(path) === 'html-language-service'
}

const MaxDirtyOpenFilesForLanguageService = 16

export function buildWorkbenchLanguageServiceOpenFiles(
  openTabs: readonly WorkbenchOpenEditorTab[]
): WorkbenchLanguageServiceOpenFile[] {
  return openTabs
    .filter((tab) => tab.content !== tab.file.content)
    .slice(0, MaxDirtyOpenFilesForLanguageService)
    .map((tab) => ({
      path: tab.path,
      content: tab.content,
    }))
}

export function waitForWorkbenchLanguageServiceRequest(
  context: { aborted: boolean; explicit: boolean; addEventListener: CompletionContext['addEventListener'] },
  delayMs: number
): Promise<boolean> {
  if (context.explicit || delayMs <= 0) return Promise.resolve(true)

  return new Promise((resolve) => {
    let settled = false
    const finish = (value: boolean): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }

    const timer = setTimeout(() => finish(!context.aborted), delayMs)
    context.addEventListener('abort', () => finish(false), { onDocChange: true })
  })
}

export function buildWorkbenchLanguageServiceRequestBase({
  projectRoot,
  path,
  language,
  content,
  openTabs,
}: {
  projectRoot: string
  path: string
  language: string
  content: string
  openTabs: readonly WorkbenchOpenEditorTab[]
}): Pick<
  WorkbenchLanguageServicePositionRequest,
  'projectRoot' | 'path' | 'language' | 'content' | 'openFiles'
> {
  return {
    projectRoot,
    path,
    language,
    content,
    openFiles: buildWorkbenchLanguageServiceOpenFiles(openTabs),
  }
}

function mapVscodeCompletionItemKind(kind: string | undefined): string | undefined {
  switch (kind) {
    case '2':
      return 'method'
    case '3':
      return 'function'
    case '6':
      return 'variable'
    case '7':
      return 'class'
    case '8':
      return 'interface'
    case '9':
      return 'namespace'
    case '10':
      return 'tag'
    case '12':
      return 'constant'
    case '13':
      return 'enum'
    case '14':
      return 'keyword'
    case '17':
      return 'file'
    case '21':
      return 'constant'
    default:
      return undefined
  }
}

function mapLanguageServiceCompletionType(kind: string | undefined, path: string): string {
  const vscodeKind = mapVscodeCompletionItemKind(kind)
  if (vscodeKind) return vscodeKind

  if (!kind) return usesWorkbenchHtmlLanguageService(path) ? 'tag' : 'text'

  const normalized = kind.toLowerCase()
  if (normalized === 'tag') return 'tag'
  if (
    normalized.includes('keyword') ||
    normalized.includes('scriptelementkind.keyword')
  ) return 'keyword'
  if (normalized.includes('function')) return 'function'
  if (normalized.includes('method')) return 'method'
  if (normalized.includes('class')) return 'class'
  if (normalized.includes('interface')) return 'interface'
  if (normalized.includes('enum')) return 'enum'
  if (normalized.includes('module') || normalized.includes('namespace')) return 'namespace'
  if (normalized.includes('property')) return 'property'
  if (normalized.includes('variable')) return 'variable'
  if (normalized.includes('type')) return 'type'
  if (normalized.includes('constant')) return 'constant'
  return usesWorkbenchHtmlLanguageService(path) ? 'tag' : 'text'
}

function rangeToOffsets(
  state: EditorState,
  path: string,
  edit: WorkbenchLanguageServiceCompletionTextEdit
): Nullable<{ from: number; to: number }> {
  if (edit.path !== path) return null

  const doc = state.doc
  const startLine = Math.min(Math.max(edit.range.startLine, 1), doc.lines)
  const endLine = Math.min(Math.max(edit.range.endLine, 1), doc.lines)
  const startLineInfo = doc.line(startLine)
  const endLineInfo = doc.line(endLine)
  const from = startLineInfo.from + Math.max(edit.range.startColumn - 1, 0)
  const to = endLineInfo.from + Math.max(edit.range.endColumn - 1, 0)

  return { from: Math.min(from, doc.length), to: Math.min(to, doc.length) }
}

function applySnippetText(text: string): string {
  return text.replace(/\$\{(\d+)(?::([^}]*))?\}/g, (_, index, placeholder) => {
    if (placeholder) return placeholder
    return `$${index}`
  })
}

function createCompletionApply({
  path,
  insertText,
  isSnippet,
  additionalTextEdits,
}: {
  path: string
  insertText: string
  isSnippet?: boolean
  additionalTextEdits?: WorkbenchLanguageServiceCompletionTextEdit[]
}): Completion['apply'] {
  return (view: EditorView, _completion: Completion, from: number, to: number) => {
    const changes: ChangeSpec[] = []
    const currentFileEdits =
      additionalTextEdits
        ?.filter((edit) => edit.path === path)
        .map((edit) => rangeToOffsets(view.state, path, edit))
        .filter((range): range is NonNullable<typeof range> => isPresent(range))
        .sort((left, right) => right.from - left.from) ?? []

    for (const edit of currentFileEdits) {
      changes.push({ from: edit.from, to: edit.to, insert: '' })
    }

    const resolvedInsertText = isSnippet ? applySnippetText(insertText) : insertText
    changes.push({ from, to, insert: resolvedInsertText })

    const cursor =
      from +
      (isSnippet
        ? resolvedInsertText.includes('$1')
          ? resolvedInsertText.indexOf('$1')
          : resolvedInsertText.length
        : resolvedInsertText.length)

    view.dispatch({
      changes,
      selection: { anchor: Math.max(from, cursor) },
      annotations: pickedCompletion.of(_completion),
    })
  }
}

export function mapWorkbenchLanguageServiceCompletionToCodeMirror({
  path,
  item,
}: {
  path: string
  item: WorkbenchLanguageServiceCompletionItem
}): Completion {
  const insertText = item.insertText ?? item.label
  const type = mapLanguageServiceCompletionType(item.kind, path)
  const completion: WorkbenchCompletionPresentation = {
    label: item.label,
    type,
    detail: item.detail,
    [WORKBENCH_COMPLETION_RETURN_TYPE]: item.returnType,
    sortText: item.sortText,
    boost: item.sortText?.startsWith('0') ? 2 : item.sortText?.startsWith('1') ? 1 : 0,
    info: type === 'keyword' ? undefined : item.documentation,
  }

  if (item.additionalTextEdits?.length || item.isSnippet || insertText !== item.label) {
    completion.apply = createCompletionApply({
      path,
      insertText,
      isSnippet: item.isSnippet,
      additionalTextEdits: item.additionalTextEdits,
    })
  } else {
    completion.apply = insertText
  }

  return completion
}

export function mergeWorkbenchLanguageServiceCompletions({
  path,
  localOptions,
  items,
}: {
  path: string
  localOptions: Completion[]
  items: readonly WorkbenchLanguageServiceCompletionItem[]
  from: number
  to: number
}): Completion[] {
  const seen = new Set(localOptions.map((option) => option.label.toLowerCase()))
  const languageServiceOptions = items
    .map((item) => mapWorkbenchLanguageServiceCompletionToCodeMirror({ path, item }))
    .filter((option) => {
      const key = option.label.toLowerCase()
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })

  return [...languageServiceOptions, ...localOptions]
}

export function offsetFromLineColumnInContent(
  content: string,
  lineNumber: number,
  column: number
): number {
  const lines = content.split('\n')
  const lineIndex = Math.min(Math.max(1, lineNumber), Math.max(1, lines.length)) - 1
  const lineStart = lines.slice(0, lineIndex).reduce((sum, line) => sum + line.length + 1, 0)
  const line = lines[lineIndex] ?? ''
  return Math.min(lineStart + Math.max(0, column - 1), lineStart + line.length)
}

export function languageServiceRangeToOffsets(
  content: string,
  range: WorkbenchLanguageServiceRange
): Nullable<{ from: number; to: number }> {
  const from = offsetFromLineColumnInContent(content, range.startLine, range.startColumn)
  const to = offsetFromLineColumnInContent(content, range.endLine, range.endColumn)
  if (from > to) return null

  return { from, to: Math.max(from, to) }
}

export function applyWorkbenchLanguageServiceEditsToContent(
  content: string,
  edits: readonly WorkbenchLanguageServiceTextEdit[]
): string {
  const sorted = [...edits].sort((left, right) => {
    const leftKey = left.range.startLine * 10_000 + left.range.startColumn
    const rightKey = right.range.startLine * 10_000 + right.range.startColumn
    return rightKey - leftKey
  })

  let nextContent = content
  for (const edit of sorted) {
    const range = languageServiceRangeToOffsets(nextContent, edit.range)
    if (!range) continue

    nextContent =
      nextContent.slice(0, range.from) + edit.newText + nextContent.slice(range.to)
  }

  return nextContent
}

export function diagnosticToCodeMirrorLintRange(
  state: EditorState,
  diagnostic: WorkbenchLanguageServiceDiagnostic
): Nullable<{ from: number; to: number; severity: 'error' | 'warning' | 'info'; message: string }> {
  const startLine = Math.min(Math.max(diagnostic.range.startLine, 1), state.doc.lines)
  const endLine = Math.min(Math.max(diagnostic.range.endLine, 1), state.doc.lines)
  const startLineInfo = state.doc.line(startLine)
  const endLineInfo = state.doc.line(endLine)
  const from = startLineInfo.from + Math.max(diagnostic.range.startColumn - 1, 0)
  const to = endLineInfo.from + Math.max(diagnostic.range.endColumn - 1, 0)

  if (from > to) return null

  return {
    from: Math.min(from, state.doc.length),
    to: Math.min(Math.max(to, from + 1), state.doc.length),
    severity: diagnostic.severity,
    message: diagnostic.message,
  }
}
