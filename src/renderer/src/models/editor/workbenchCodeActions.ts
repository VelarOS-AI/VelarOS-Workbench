/**
 * 光标菜单（⌥↩ / ⌘.）与诊断浮层上的修复按钮共用的纯逻辑：问语言服务要带什么、回来的动作怎么列、
 * 它们的改动怎么落到编辑器里。请求、菜单和落盘在编辑器组件那边。
 */
import { forEachDiagnostic } from '@codemirror/lint'
import type { EditorState } from '@codemirror/state'

import type {
  WorkbenchLanguageServiceCodeAction,
  WorkbenchLanguageServiceDiagnostic,
  WorkbenchLanguageServiceFileEdit,
  WorkbenchLanguageServiceNewFile,
  WorkbenchLanguageServiceRange,
  WorkbenchLanguageServiceTextEdit,
} from '@shared/contracts'

import type { WorkbenchCodeMirrorDiagnostic } from './workbenchCodeMirrorDiagnostics'
import { resolveWorkbenchBuiltinLanguageServiceRuntime } from './workbenchCodeMirrorLanguageService'

/** 一个文件能用哪几样：快速修复内置 TypeScript 与外部语言服务器都有。 */
export interface WorkbenchCodeActionSupport {
  quickFix: boolean
}

export function resolveWorkbenchCodeActionSupport(path: Nullable<string>): WorkbenchCodeActionSupport {
  const runtime = resolveWorkbenchBuiltinLanguageServiceRuntime(path)
  return {
    quickFix:
      runtime === 'typescript-language-service'
      || runtime === 'lsp-server'
      || runtime === 'python-language-server',
  }
}

function positionOf(state: EditorState, offset: number): { line: number; column: number } {
  const line = state.doc.lineAt(Math.min(Math.max(0, offset), state.doc.length))
  return { line: line.number, column: offset - line.from + 1 }
}

export function workbenchRangeFromOffsets(
  state: EditorState,
  from: number,
  to: number
): WorkbenchLanguageServiceRange {
  const start = positionOf(state, Math.min(from, to))
  const end = positionOf(state, Math.max(from, to))
  return {
    startLine: start.line,
    startColumn: start.column,
    endLine: end.line,
    endColumn: end.column,
  }
}

/**
 * 编辑器里落在 `from..to` 上的诊断，换成语言服务认的样子。位置按此刻的正文算（诊断的范围跟着编辑走过），
 * 诊断码、来源取语言服务当初给的那一条；没有那一条的（不是语言服务的诊断）不算。
 */
export function collectWorkbenchDiagnosticsInRange(
  state: EditorState,
  from: number,
  to: number
): WorkbenchLanguageServiceDiagnostic[] {
  const diagnostics: WorkbenchLanguageServiceDiagnostic[] = []
  const seen = new Set<unknown>()
  forEachDiagnostic(state, (diagnostic: WorkbenchCodeMirrorDiagnostic, diagnosticFrom, diagnosticTo) => {
    const source = diagnostic.workbenchDiagnostic
    if (!source || seen.has(diagnostic)) return
    if (diagnosticFrom > Math.max(from, to) || diagnosticTo < Math.min(from, to)) return
    seen.add(diagnostic)
    diagnostics.push({ ...source, range: workbenchRangeFromOffsets(state, diagnosticFrom, diagnosticTo) })
  })
  return diagnostics
}

/**
 * 一份动到编辑器之外的改动（别的文件、要新建的文件），交给页面去落。页面先把新文件建好，建成了才让编辑器套上
 * 当前文件的那部分，再改别的文件——新文件没建成时，「移到新文件」不会先把原处的代码删掉。
 */
export interface WorkbenchLanguageServiceWorkspaceEditRequest {
  /** 别的文件上的改动（开着的改编辑缓冲，没开着的写盘）。 */
  changes: readonly WorkbenchLanguageServiceFileEdit[]
  createFiles: readonly WorkbenchLanguageServiceNewFile[]
  /**
   * 套上当前文件的那部分，返回编辑器里改了几个文件（0 或 1）；正文在这期间变了就不套，返回 null，整份改动作废。
   */
  applyToEditor: () => Nullable<number>
}

/** 光标菜单里的一行：分组标题，或一个能选的动作。 */
export type WorkbenchCodeActionMenuRow =
  | { kind: 'header'; key: string; title: string }
  | { kind: 'action'; key: string; action: WorkbenchLanguageServiceCodeAction }

/** 动作按语言服务给的顺序列；首选的（`preferred`）提到最前。标题与改动都一样的只留一个。 */
export function buildWorkbenchCodeActionMenuRows(
  actions: readonly WorkbenchLanguageServiceCodeAction[]
): WorkbenchCodeActionMenuRow[] {
  const seen = new Set<string>()
  const unique = actions.filter((action) => {
    const key = JSON.stringify([action.title, action.changes, action.resolve ?? null])
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
  return [
    ...unique.filter((action) => action.preferred),
    ...unique.filter((action) => !action.preferred),
  ].map((action, index) => ({ kind: 'action', key: `action:${index}`, action }))
}

/** 菜单里上下移动时落到的行：跳过标题，到头绕回另一头；没有能选的行返回 -1。 */
export function nextWorkbenchCodeActionRowIndex(
  rows: readonly WorkbenchCodeActionMenuRow[],
  current: number,
  offset: 1 | -1
): number {
  if (!rows.some((row) => row.kind === 'action')) return -1
  let index = current
  for (let step = 0; step < rows.length; step += 1) {
    index = (index + offset + rows.length) % rows.length
    if (rows[index]?.kind === 'action') return index
  }
  return -1
}

/** 一个动作的改动分两份：当前文件的由编辑器自己套（一步撤销、光标留在原处），别的文件交给页面。 */
export function partitionWorkbenchCodeActionChanges(
  path: string,
  changes: readonly WorkbenchLanguageServiceFileEdit[]
): { current: WorkbenchLanguageServiceTextEdit[]; others: WorkbenchLanguageServiceFileEdit[] } {
  return {
    current: changes.filter((change) => change.path === path).flatMap((change) => change.edits),
    others: changes.filter((change) => change.path !== path && change.edits.length > 0),
  }
}

export interface WorkbenchCodeMirrorChange {
  from: number
  to: number
  insert: string
}

/**
 * 语言服务的改动（行列范围）换成编辑器的改动（偏移），按位置排好。范围落在文档之外、前后颠倒或互相重叠时
 * 返回 null：这份改动是照着别的正文算的，套上去只会把代码弄坏。
 */
export function buildWorkbenchCodeMirrorChanges(
  state: EditorState,
  edits: readonly WorkbenchLanguageServiceTextEdit[]
): Nullable<WorkbenchCodeMirrorChange[]> {
  const offsetOf = (lineNumber: number, column: number): Nullable<number> => {
    if (!Number.isInteger(lineNumber) || lineNumber < 1 || lineNumber > state.doc.lines) return null
    const line = state.doc.line(lineNumber)
    if (!Number.isInteger(column) || column < 1 || column > line.length + 1) return null
    return line.from + column - 1
  }

  const changes: WorkbenchCodeMirrorChange[] = []
  for (const edit of edits) {
    const from = offsetOf(edit.range.startLine, edit.range.startColumn)
    const to = offsetOf(edit.range.endLine, edit.range.endColumn)
    if (from === null || to === null || from > to) return null
    changes.push({ from, to, insert: edit.newText })
  }
  // 同一个位置上的两处插入保持原来的先后（排序是稳定的）。
  changes.sort((left, right) => left.from - right.from || left.to - right.to)
  for (let index = 1; index < changes.length; index += 1)
    if (changes[index]!.from < changes[index - 1]!.to) return null
  return changes
}
