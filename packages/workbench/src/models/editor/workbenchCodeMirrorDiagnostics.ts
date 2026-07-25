import { type Diagnostic, forEachDiagnostic, setDiagnosticsEffect } from '@codemirror/lint'
import { type EditorState, type Extension, Prec, RangeSetBuilder } from '@codemirror/state'
import {
  Decoration,
  type DecorationSet,
  type EditorView,
  ViewPlugin,
  type ViewUpdate,
} from '@codemirror/view'

import { isPresent } from '@velaros-ai/core'
import type { WorkbenchLanguageServiceDiagnostic } from '@velaros-ai/core/types'

import { diagnosticToCodeMirrorLintRange } from './workbenchCodeMirrorLanguageService'

/** TypeScript 未使用的局部变量、导入和参数诊断。 */
export const WORKBENCH_TS_UNUSED_DIAGNOSTIC_CODES = new Set([
  6133, // 已声明但未读取。
  6192, // import 声明里的导入全部未使用。
  6196, // 已声明但未使用。
  6198, // 解构元素全部未使用。
])

/** TypeScript 未解析标识符诊断，用红色前景突出。 */
export const WORKBENCH_TS_UNRESOLVED_NAME_DIAGNOSTIC_CODES = new Set([
  2304, // 找不到名称。
  2552, // 找不到名称，可能有近似候选。
  2662, // 找不到名称，可能应使用静态成员。
  2663, // 找不到名称，可能应使用类型成员。
  2580, // 找不到名称，可能缺少类型声明。
])

const UNRESOLVED_NAME_MESSAGE_PATTERN = /^Cannot find name /
const WORKBENCH_TS_DEPRECATED_DIAGNOSTIC_CODES = new Set([6385, 6387])

export function isWorkbenchUnusedVariableDiagnosticCode(code: LooseOptional<number>): boolean {
  return isPresent(code) && WORKBENCH_TS_UNUSED_DIAGNOSTIC_CODES.has(code)
}

export function isWorkbenchUnresolvedNameDiagnosticCode(code: LooseOptional<number>): boolean {
  return isPresent(code) && WORKBENCH_TS_UNRESOLVED_NAME_DIAGNOSTIC_CODES.has(code)
}

export function isWorkbenchUnresolvedNameDiagnostic(
  diagnostic: Pick<WorkbenchLanguageServiceDiagnostic, 'code' | 'severity' | 'message' | 'source'>
): boolean {
  if (isWorkbenchUnresolvedNameDiagnosticCode(diagnostic.code)) return true

  return (
    diagnostic.severity === 'error' &&
    diagnostic.source === 'typescript' &&
    UNRESOLVED_NAME_MESSAGE_PATTERN.test(diagnostic.message)
  )
}

export function isWorkbenchDeprecatedDiagnostic(
  diagnostic: Pick<WorkbenchLanguageServiceDiagnostic, 'code' | 'deprecated' | 'source'>
): boolean {
  if (diagnostic.deprecated) return true

  return (
    diagnostic.source === 'typescript' &&
    isPresent(diagnostic.code) &&
    WORKBENCH_TS_DEPRECATED_DIAGNOSTIC_CODES.has(diagnostic.code)
  )
}

export function mapWorkbenchDiagnosticToCodeMirror(
  state: EditorState,
  diagnostic: WorkbenchLanguageServiceDiagnostic
): Nullable<Diagnostic> {
  const range = diagnosticToCodeMirrorLintRange(state, diagnostic)
  if (!range) return null

  if (isWorkbenchDeprecatedDiagnostic(diagnostic))
    return {
      from: range.from,
      to: range.to,
      severity: 'info',
      markClass: ' cm-workbenchDeprecated',
      message: range.message,
      source: diagnostic.source ?? 'typescript',
    }

  if (isWorkbenchUnusedVariableDiagnosticCode(diagnostic.code))
    return {
      from: range.from,
      to: range.to,
      severity: 'info',
      markClass: ' cm-workbenchUnusedVariable',
      message: range.message,
      source: diagnostic.source ?? 'typescript',
    }

  if (isWorkbenchUnresolvedNameDiagnostic(diagnostic))
    return {
      from: range.from,
      to: range.to,
      severity: 'error',
      markClass: ' cm-workbenchErrorIdentifier',
      message: range.message,
      source: diagnostic.source ?? 'typescript',
    }

  return {
    from: range.from,
    to: range.to,
    severity: range.severity,
    message: range.message,
    source: diagnostic.source,
  }
}

const WORKBENCH_ERROR_IDENTIFIER_COLOR = 'var(--workbench-editor-diagnostic-error-fg, #8b0000)'
const WORKBENCH_UNUSED_VARIABLE_COLOR = 'var(--workbench-editor-unused-fg, #6e7681)'

const ERROR_IDENTIFIER_FOREGROUND_MARK = Decoration.mark({
  class: 'cm-workbenchErrorIdentifier',
  attributes: {
    style: `color: ${WORKBENCH_ERROR_IDENTIFIER_COLOR}`,
  },
})
const UNUSED_VARIABLE_FOREGROUND_MARK = Decoration.mark({
  class: 'cm-workbenchUnusedVariable',
  attributes: {
    style: `color: ${WORKBENCH_UNUSED_VARIABLE_COLOR}`,
  },
})
const DEPRECATED_FOREGROUND_MARK = Decoration.mark({
  class: 'cm-workbenchDeprecated',
  attributes: {
    style: 'text-decoration-line: line-through; text-decoration-thickness: 1px;',
  },
})

function diagnosticForegroundMark(diagnostic: Diagnostic): Nullable<Decoration> {
  const markClass = diagnostic.markClass?.trim() ?? ''
  if (!markClass) return null
  if (markClass.includes('cm-workbenchErrorIdentifier')) return ERROR_IDENTIFIER_FOREGROUND_MARK
  if (markClass.includes('cm-workbenchUnusedVariable')) return UNUSED_VARIABLE_FOREGROUND_MARK
  if (markClass.includes('cm-workbenchDeprecated')) return DEPRECATED_FOREGROUND_MARK
  return null
}

export function buildWorkbenchDiagnosticForegroundDecorations(
  diagnostics: readonly Diagnostic[]
): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>()
  const sorted = [...diagnostics].sort(
    (left, right) => left.from - right.from || left.to - right.to
  )

  for (const diagnostic of sorted) {
    const mark = diagnosticForegroundMark(diagnostic)
    if (!mark || diagnostic.from >= diagnostic.to) continue
    builder.add(diagnostic.from, diagnostic.to, mark)
  }

  return builder.finish()
}

function diagnosticForegroundNeedsSync(update: ViewUpdate): boolean {
  if (update.docChanged || update.geometryChanged) return true

  return update.transactions.some((transaction) =>
    transaction.effects.some((effect) => effect.is(setDiagnosticsEffect))
  )
}

function collectDiagnosticsForForeground(view: EditorView): Diagnostic[] {
  const diagnostics: Diagnostic[] = []

  forEachDiagnostic(view.state, (diagnostic, from, to) => {
    diagnostics.push({ ...diagnostic, from, to })
  })

  return diagnostics
}

export function createWorkbenchDiagnosticForegroundExtension(): Extension {
  return Prec.highest(
    ViewPlugin.fromClass(
      class {
        decorations: DecorationSet

        constructor(private readonly view: EditorView) {
          this.decorations = buildWorkbenchDiagnosticForegroundDecorations(
            collectDiagnosticsForForeground(view)
          )
        }

        public update(update: ViewUpdate): void {
          if (!diagnosticForegroundNeedsSync(update)) return

          this.decorations = buildWorkbenchDiagnosticForegroundDecorations(
            collectDiagnosticsForForeground(update.view)
          )
        }
      },
      {
        decorations: (plugin) => plugin.decorations,
      }
    )
  )
}
