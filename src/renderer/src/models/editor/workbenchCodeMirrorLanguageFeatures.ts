import type { Diagnostic } from '@codemirror/lint'
import { forEachDiagnostic } from '@codemirror/lint'
import type { EditorState, Extension, Transaction } from '@codemirror/state'
import {
  type EditorView,
  hoverTooltip,
  type Tooltip,
  ViewPlugin,
  type ViewUpdate,
} from '@codemirror/view'

import { isEmpty } from '@velaros-ai/core'

import type {
  WorkbenchLanguageServiceDisplayPartKind,
  WorkbenchLanguageServiceHoverResult,
  WorkbenchLanguageServiceLocation,
  WorkbenchLanguageServiceSignatureHelpResult,
} from '@shared/contracts'

import type { WorkbenchHostRuntime } from '../../host'
import type { WorkbenchOpenEditorTab } from '../../types/workbenchTypes'

import {
  buildWorkbenchLanguageServiceRequestBase,
  usesWorkbenchSemanticLanguageService,
} from './workbenchCodeMirrorLanguageService'
import {
  appendWorkbenchEditorHoverText,
  type WorkbenchEditorHoverPartStyle,
} from './workbenchEditorHoverHighlight'
import {
  getWorkbenchLanguageServiceHover,
  getWorkbenchLanguageServiceReferences,
  getWorkbenchLanguageServiceSignatureHelp,
} from './workbenchLanguageServiceIpc'

export interface WorkbenchLanguageServiceEditorContext {
  projectRoot: string
  path: Nullable<string>
  language: string
  getOpenTabs: () => readonly WorkbenchOpenEditorTab[]
  hostRuntime?: WorkbenchHostRuntime
}

/** 由产品 UI 注入的语言服务浮层样式；模型不依赖任何宿主 CSS Module。 */
export interface WorkbenchEditorLanguageFeatureClasses {
  editorSignatureTooltip: string
  editorSignatureTooltipHost: string
  editorSignatureTooltipParameter: string
  editorSignatureTooltipSignature: string
  editorSymbolTooltip: string
  editorSymbolTooltipDiagnostic: string
  editorSymbolTooltipDiagnostics: string
  editorSymbolTooltipDivider: string
  editorSymbolTooltipDocs: string
  editorSymbolTooltipLocation: string
  editorSymbolTooltipPartFunction: string
  editorSymbolTooltipPartKeyword: string
  editorSymbolTooltipPartLink: string
  editorSymbolTooltipPartLocation: string
  editorSymbolTooltipPartName: string
  editorSymbolTooltipPartNumber: string
  editorSymbolTooltipPartOperator: string
  editorSymbolTooltipPartPlain: string
  editorSymbolTooltipPartPunctuation: string
  editorSymbolTooltipPartString: string
  editorSymbolTooltipPartType: string
  editorSymbolTooltipTitle: string
}

function positionLineColumnFromState(
  state: EditorState,
  pos: number
): { line: number; column: number; offset: number } {
  const offset = Math.min(Math.max(0, pos), state.doc.length)
  const line = state.doc.lineAt(offset)
  return { line: line.number, column: offset - line.from + 1, offset }
}

function buildLanguageServiceRequest(
  view: EditorView,
  context: WorkbenchLanguageServiceEditorContext,
  position: number
) {
  const path = context.path
  if (!path) return null

  return {
    ...buildWorkbenchLanguageServiceRequestBase({
      projectRoot: context.projectRoot,
      path,
      language: context.language,
      content: view.state.doc.toString(),
      openTabs: context.getOpenTabs(),
    }),
    position: positionLineColumnFromState(view.state, position),
  }
}

interface WorkbenchEditorHoverDiagnosticRange {
  diagnostics: Diagnostic[]
  from: number
  to: number
}

interface WorkbenchEditorHoverSymbolFallback {
  word: string
  path: string
  line: number
  column: number
}

const DIAGNOSTIC_SEVERITY_ORDER: Record<Diagnostic['severity'], number> = {
  error: 0,
  warning: 1,
  info: 2,
  hint: 3,
}

export function collectDiagnosticsAtPosition(
  view: EditorView,
  pos: number
): Nullable<WorkbenchEditorHoverDiagnosticRange> {
  const diagnostics: Diagnostic[] = []
  let from = pos
  let to = pos

  forEachDiagnostic(view.state, (diagnostic, diagnosticFrom, diagnosticTo) => {
    if (pos < diagnosticFrom || pos > diagnosticTo) return

    if (isEmpty(diagnostics)) {
      from = diagnosticFrom
      to = diagnosticTo
    } else {
      from = Math.min(from, diagnosticFrom)
      to = Math.max(to, diagnosticTo)
    }

    if (!diagnostics.includes(diagnostic)) {
      diagnostics.push(diagnostic)
    }
  })

  if (isEmpty(diagnostics)) return null

  diagnostics.sort(
    (left, right) =>
      DIAGNOSTIC_SEVERITY_ORDER[left.severity] - DIAGNOSTIC_SEVERITY_ORDER[right.severity]
  )

  return { diagnostics, from, to }
}

function appendEditorSymbolTooltipSection(
  wrapper: HTMLElement,
  classes: WorkbenchEditorLanguageFeatureClasses
): void {
  const divider = document.createElement('div')
  divider.className = classes.editorSymbolTooltipDivider
  wrapper.append(divider)
}

function createHoverPartClassName(classes: WorkbenchEditorLanguageFeatureClasses) {
  const classByStyle: Readonly<Record<WorkbenchEditorHoverPartStyle, string>> = {
    keyword: classes.editorSymbolTooltipPartKeyword,
    type: classes.editorSymbolTooltipPartType,
    name: classes.editorSymbolTooltipPartName,
    function: classes.editorSymbolTooltipPartFunction,
    number: classes.editorSymbolTooltipPartNumber,
    string: classes.editorSymbolTooltipPartString,
    operator: classes.editorSymbolTooltipPartOperator,
    punctuation: classes.editorSymbolTooltipPartPunctuation,
    plain: classes.editorSymbolTooltipPartPlain,
    link: classes.editorSymbolTooltipPartLink,
    location: classes.editorSymbolTooltipPartLocation,
  }
  return (style: WorkbenchEditorHoverPartStyle): string => classByStyle[style]
}

function createHighlightedHoverSection(
  className: string,
  partClassName: (style: WorkbenchEditorHoverPartStyle) => string,
  {
    parts,
    fallbackText,
  }: {
    parts?: ReadonlyArray<{ text: string; kind: WorkbenchLanguageServiceDisplayPartKind }>
    fallbackText: string
  }
): HTMLElement {
  const section = document.createElement('div')
  section.className = className
  appendWorkbenchEditorHoverText(section, {
    parts,
    fallbackText,
    partClassName,
  })
  return section
}

export function buildWorkbenchEditorHoverDom({
  hover = null,
  diagnostics = [],
  symbolFallback = null,
}: {
  hover?: Nullable<WorkbenchLanguageServiceHoverResult>
  diagnostics?: readonly Diagnostic[]
  symbolFallback?: Nullable<WorkbenchEditorHoverSymbolFallback>
}, classes: WorkbenchEditorLanguageFeatureClasses): HTMLElement {
  const hoverPartClassName = createHoverPartClassName(classes)
  const wrapper = document.createElement('div')
  wrapper.className = classes.editorSymbolTooltip
  wrapper.addEventListener(
    'wheel',
    (event) => {
      event.stopPropagation()
    },
    { passive: true }
  )

  if (diagnostics.length > 0) {
    const diagnosticSection = document.createElement('div')
    diagnosticSection.className = classes.editorSymbolTooltipDiagnostics

    for (const diagnostic of diagnostics) {
      const item = document.createElement('div')
      item.className = classes.editorSymbolTooltipDiagnostic
      item.dataset.severity = diagnostic.severity
      appendWorkbenchEditorHoverText(item, {
        fallbackText: diagnostic.message,
        partClassName: hoverPartClassName,
      })
      diagnosticSection.append(item)
    }

    wrapper.append(diagnosticSection)
  }

  if (hover) {
    if (diagnostics.length > 0) {
      appendEditorSymbolTooltipSection(wrapper, classes)
    }

    wrapper.append(
      createHighlightedHoverSection(classes.editorSymbolTooltipTitle, hoverPartClassName, {
        parts: hover.displayParts,
        fallbackText: hover.displayText,
      })
    )

    if (hover.documentation || hover.documentationParts?.length) {
      wrapper.append(
        createHighlightedHoverSection(classes.editorSymbolTooltipDocs, hoverPartClassName, {
          parts: hover.documentationParts,
          fallbackText: hover.documentation ?? '',
        })
      )
    }

    if (hover.tags?.length) {
      wrapper.append(
        createHighlightedHoverSection(classes.editorSymbolTooltipLocation, hoverPartClassName, {
          fallbackText: hover.tags.join(' · '),
        })
      )
    }
  } else if (symbolFallback) {
    if (diagnostics.length > 0) {
      appendEditorSymbolTooltipSection(wrapper, classes)
    }

    wrapper.append(
      createHighlightedHoverSection(classes.editorSymbolTooltipTitle, hoverPartClassName, {
        fallbackText: symbolFallback.word,
      })
    )

    wrapper.append(
      createHighlightedHoverSection(classes.editorSymbolTooltipLocation, hoverPartClassName, {
        fallbackText: `${symbolFallback.path}:${symbolFallback.line}:${symbolFallback.column}`,
      })
    )
  }

  return wrapper
}

function buildSignatureHelpDom(
  signatureHelp: WorkbenchLanguageServiceSignatureHelpResult,
  classes: WorkbenchEditorLanguageFeatureClasses
): HTMLElement {
  const wrapper = document.createElement('div')
  wrapper.className = classes.editorSignatureTooltip

  const activeSignature = signatureHelp.signatures[signatureHelp.activeSignature]
  if (!activeSignature) return wrapper

  const signatureLine = document.createElement('div')
  signatureLine.className = classes.editorSignatureTooltipSignature
  signatureLine.textContent = activeSignature.label
  wrapper.append(signatureLine)

  const activeParameter = activeSignature.parameters[signatureHelp.activeParameter]
  if (activeParameter?.documentation) {
    const parameterDocs = document.createElement('div')
    parameterDocs.className = classes.editorSignatureTooltipParameter
    parameterDocs.textContent = `${activeParameter.label}: ${activeParameter.documentation}`
    wrapper.append(parameterDocs)
  } else if (activeSignature.documentation) {
    const docs = document.createElement('div')
    docs.className = classes.editorSignatureTooltipParameter
    docs.textContent = activeSignature.documentation
    wrapper.append(docs)
  }

  return wrapper
}

function shouldRequestSignatureHelp(state: EditorState, position: number): boolean {
  const line = state.doc.lineAt(position)
  const before = line.text.slice(0, position - line.from)
  return /[(,]\s*$/.test(before)
}

export function hasWorkbenchPointerSelection(
  transactions: ReadonlyArray<Pick<Transaction, 'isUserEvent'>>
): boolean {
  return transactions.some((transaction) => transaction.isUserEvent('select.pointer'))
}

export function createWorkbenchLanguageServiceHoverTooltip(
  context: WorkbenchLanguageServiceEditorContext,
  classes: WorkbenchEditorLanguageFeatureClasses,
  fallbackHover?: (view: EditorView, position: number) => Tooltip | null
): Extension {
  let requestGeneration = 0

  return hoverTooltip(
    async (view, position): Promise<Tooltip | null> => {
      const diagnosticRange = collectDiagnosticsAtPosition(view, position)
      let hover: Nullable<WorkbenchLanguageServiceHoverResult> = null

      if (context.path && usesWorkbenchSemanticLanguageService(context.path)) {
        const request = buildLanguageServiceRequest(view, context, position)
        if (request) {
          const generation = ++requestGeneration
          const result = await getWorkbenchLanguageServiceHover(request, context.hostRuntime)
          if (generation !== requestGeneration) return null
          hover = result.ok ? result.data.hover : null
        }
      }

      if (!diagnosticRange && !hover) return fallbackHover?.(view, position) ?? null

      return {
        pos: diagnosticRange?.from ?? position,
        end: diagnosticRange?.to ?? Math.min(position + 1, view.state.doc.length),
        above: true,
        create: () => ({
          dom: buildWorkbenchEditorHoverDom({
            hover,
            diagnostics: diagnosticRange?.diagnostics,
          }, classes),
        }),
      }
    },
    { hoverTime: 420 }
  )
}

export function createWorkbenchSignatureHelpExtension(
  context: WorkbenchLanguageServiceEditorContext,
  classes: WorkbenchEditorLanguageFeatureClasses
): Extension {
  let requestGeneration = 0
  let tooltip: HTMLElement | null = null

  return ViewPlugin.fromClass(
    class {
      constructor(readonly view: EditorView) {
        void this.sync()
      }

      public update(update: ViewUpdate): void {
        if (update.selectionSet && hasWorkbenchPointerSelection(update.transactions)) {
          this.hide()
          return
        }

        if (update.docChanged || update.selectionSet) {
          void this.sync()
        }
      }

      public destroy(): void {
        tooltip?.remove()
        tooltip = null
      }

      public async sync(): Promise<void> {
        const path = context.path
        const position = this.view.state.selection.main.head
        if (!path || !usesWorkbenchSemanticLanguageService(path)) {
          this.hide()
          return
        }

        if (!shouldRequestSignatureHelp(this.view.state, position)) {
          this.hide()
          return
        }

        const request = buildLanguageServiceRequest(this.view, context, position)
        if (!request) {
          this.hide()
          return
        }

        const generation = ++requestGeneration
        const result = await getWorkbenchLanguageServiceSignatureHelp(request, context.hostRuntime)
        if (generation !== requestGeneration) return

        const signatureHelp = result.ok ? result.data.signatureHelp : null
        if (!signatureHelp || isEmpty(signatureHelp.signatures)) {
          this.hide()
          return
        }

        this.show(signatureHelp, position)
      }

      public show(signatureHelp: WorkbenchLanguageServiceSignatureHelpResult, position: number): void {
        if (!tooltip) {
          tooltip = document.createElement('div')
          tooltip.className = classes.editorSignatureTooltipHost
          this.view.dom.append(tooltip)
        }

        tooltip.replaceChildren(buildSignatureHelpDom(signatureHelp, classes))
        const coords = this.view.coordsAtPos(position)
        if (!coords) return

        const editorRect = this.view.dom.getBoundingClientRect()
        tooltip.style.left = `${coords.left - editorRect.left}px`
        tooltip.style.top = `${coords.top - editorRect.top - tooltip.offsetHeight - 8}px`
        tooltip.style.display = 'block'
      }

      public hide(): void {
        requestGeneration += 1
        if (!tooltip) return
        tooltip.style.display = 'none'
      }
    }
  )
}

export async function findWorkbenchLanguageServiceReferences({
  view,
  context,
  position,
}: {
  view: EditorView
  context: WorkbenchLanguageServiceEditorContext
  position: number
}): Promise<readonly WorkbenchLanguageServiceLocation[]> {
  const path = context.path
  if (!path || !usesWorkbenchSemanticLanguageService(path)) return []

  const request = buildLanguageServiceRequest(view, context, position)
  if (!request) return []

  const result = await getWorkbenchLanguageServiceReferences(request, context.hostRuntime)
  return result.ok ? result.data.locations : []
}
