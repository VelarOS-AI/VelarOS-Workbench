import type { EditorState } from '@codemirror/state'

import type {
  WorkbenchLanguageServiceDiagnostic,
  WorkbenchLanguageServiceEditFormat,
  WorkbenchLanguageServiceOpenFile,
  WorkbenchLanguageServicePositionRequest,
  WorkbenchLanguageServiceRange,
  WorkbenchLanguageServiceTextEdit,
} from '@shared/contracts'
import {
  getWorkbenchPathExtension,
  resolveBuiltinWorkbenchLanguageService,
  type WorkbenchLanguageServiceDescriptor,
} from '@shared/language/workbenchLanguageServices'

import type { WorkbenchOpenEditorTab } from '../../types/workbenchTypes'

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

export function usesWorkbenchSemanticLanguageService(path: Nullable<string>): boolean {
  const runtime = resolveWorkbenchBuiltinLanguageServiceRuntime(path)
  return (
    runtime === 'typescript-language-service' ||
    runtime === 'markdown-language-service' ||
    runtime === 'python-language-server' ||
    runtime === 'lsp-server'
  )
}

export function usesWorkbenchInlayHintLanguageService(path: Nullable<string>): boolean {
  const runtime = resolveWorkbenchBuiltinLanguageServiceRuntime(path)
  return (
    runtime === 'typescript-language-service' ||
    runtime === 'python-language-server' ||
    runtime === 'lsp-server'
  )
}

export function usesWorkbenchExternalLspLanguageService(path: Nullable<string>): boolean {
  return resolveWorkbenchBuiltinLanguageServiceRuntime(path) === 'lsp-server'
}

export function usesWorkbenchExternalSemanticLanguageService(path: Nullable<string>): boolean {
  const runtime = resolveWorkbenchBuiltinLanguageServiceRuntime(path)
  return runtime === 'lsp-server' || runtime === 'python-language-server'
}

export function usesWorkbenchBuiltinLanguageService(path: Nullable<string>): boolean {
  const runtime = resolveWorkbenchBuiltinLanguageServiceRuntime(path)
  return (
    runtime === 'typescript-language-service' ||
    runtime === 'html-language-service' ||
    runtime === 'css-language-service' ||
    runtime === 'markdown-language-service' ||
    runtime === 'python-language-server' ||
    runtime === 'lsp-server'
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

export function buildWorkbenchLanguageServiceRequestBase({
  projectRoot,
  path,
  language,
  content,
  openTabs,
  format,
}: {
  projectRoot: string
  path: string
  language: string
  content: string
  openTabs: readonly WorkbenchOpenEditorTab[]
  /** 这个文件的缩进：要语言服务写代码的请求（格式化、补全）带上，只是查询的不用带。 */
  format?: WorkbenchLanguageServiceEditFormat
}): Pick<
  WorkbenchLanguageServicePositionRequest,
  'projectRoot' | 'path' | 'language' | 'content' | 'openFiles' | 'format'
> {
  return {
    projectRoot,
    path,
    language,
    content,
    openFiles: buildWorkbenchLanguageServiceOpenFiles(openTabs),
    format,
  }
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
  // 从后往前套，前面的位置不受影响；按行、再按列比较（很长的行也不会排错）。
  const sorted = [...edits].sort((left, right) =>
    right.range.startLine - left.range.startLine || right.range.startColumn - left.range.startColumn
  )

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
