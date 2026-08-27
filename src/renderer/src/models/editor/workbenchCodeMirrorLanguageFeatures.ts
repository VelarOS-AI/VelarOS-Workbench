import type { Diagnostic } from '@codemirror/lint'
import { forEachDiagnostic } from '@codemirror/lint'
import type { EditorState, Extension, Transaction } from '@codemirror/state'
import {
  closeHoverTooltips,
  type EditorView,
  hoverTooltip,
  type Tooltip,
  ViewPlugin,
  type ViewUpdate,
} from '@codemirror/view'

import { isEmpty } from '@velaros-ai/core'

import type {
  WorkbenchLanguageServiceDisplayPartKind,
  WorkbenchLanguageServiceHoverDocumentationBlock,
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
  hoverLoadingLabel?: string
  hoverUnavailableLabel?: string
  hoverDefinitionLabel?: string
  hoverDefinitionPreviewLabel?: string
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
  editorSymbolTooltipCode: string
  editorSymbolTooltipDivider: string
  editorSymbolTooltipDocs: string
  editorSymbolTooltipDocsParagraph: string
  editorSymbolTooltipInlineCode: string
  editorSymbolTooltipLocation: string
  editorSymbolTooltipLocationLabel: string
  editorSymbolTooltipSectionLabel: string
  editorSymbolTooltipPartBuiltinType: string
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
  editorSymbolTooltipStatus: string
  editorSymbolTooltipStatusDot: string
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

function createEditorSymbolTooltipWrapper(
  classes: WorkbenchEditorLanguageFeatureClasses
): HTMLDivElement {
  const wrapper = document.createElement('div')
  wrapper.className = classes.editorSymbolTooltip
  wrapper.addEventListener(
    'wheel',
    (event) => {
      event.stopPropagation()
    },
    { passive: true }
  )
  return wrapper
}

function createHoverPartClassName(classes: WorkbenchEditorLanguageFeatureClasses) {
  const classByStyle: Readonly<Record<WorkbenchEditorHoverPartStyle, string>> = {
    keyword: classes.editorSymbolTooltipPartKeyword,
    builtinType: classes.editorSymbolTooltipPartBuiltinType,
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

function appendHoverDocumentationText(
  container: HTMLElement,
  text: string,
  classes: WorkbenchEditorLanguageFeatureClasses
): void {
  const inlineCodePattern = /`([^`\n]+)`/gu
  let cursor = 0
  for (const match of text.matchAll(inlineCodePattern)) {
    const start = match.index ?? 0
    container.append(document.createTextNode(text.slice(cursor, start)))
    const code = document.createElement('code')
    code.className = classes.editorSymbolTooltipInlineCode
    code.textContent = match[1] ?? ''
    container.append(code)
    cursor = start + match[0].length
  }
  container.append(document.createTextNode(text.slice(cursor)))
}

function hoverDocumentationBlocks(
  hover: WorkbenchLanguageServiceHoverResult
): readonly WorkbenchLanguageServiceHoverDocumentationBlock[] {
  if (hover.documentationBlocks?.length) return hover.documentationBlocks
  const text = hover.documentation
    ?? hover.documentationParts?.map((part) => part.text).join('')
    ?? ''
  return text ? [{ kind: 'paragraph', text }] : []
}

function createHoverDocumentationSection(
  hover: WorkbenchLanguageServiceHoverResult,
  classes: WorkbenchEditorLanguageFeatureClasses,
  hoverPartClassName: (style: WorkbenchEditorHoverPartStyle) => string
): Nullable<HTMLElement> {
  const blocks = hoverDocumentationBlocks(hover)
  if (blocks.length === 0) return null

  const section = document.createElement('div')
  section.className = classes.editorSymbolTooltipDocs
  for (const block of blocks) {
    if (block.kind === 'code') {
      const code = document.createElement('pre')
      code.className = classes.editorSymbolTooltipCode
      if (block.language) code.dataset.language = block.language
      appendWorkbenchEditorHoverText(code, {
        fallbackText: block.text,
        partClassName: hoverPartClassName,
      })
      section.append(code)
      continue
    }

    const paragraph = document.createElement('p')
    paragraph.className = classes.editorSymbolTooltipDocsParagraph
    appendHoverDocumentationText(paragraph, block.text, classes)
    section.append(paragraph)
  }
  return section
}

function createHoverDefinitionPreviewSection(
  hover: WorkbenchLanguageServiceHoverResult,
  labelText: string,
  classes: WorkbenchEditorLanguageFeatureClasses,
  hoverPartClassName: (style: WorkbenchEditorHoverPartStyle) => string
): Nullable<HTMLElement> {
  const preview = hover.definitionPreview
  if (!preview?.text) return null

  const section = document.createElement('div')
  section.className = classes.editorSymbolTooltipDocs
  const label = document.createElement('div')
  label.className = classes.editorSymbolTooltipSectionLabel
  label.textContent = labelText
  const code = document.createElement('pre')
  code.className = classes.editorSymbolTooltipCode
  if (preview.language) code.dataset.language = preview.language
  appendWorkbenchEditorHoverText(code, {
    fallbackText: preview.text,
    partClassName: hoverPartClassName,
  })
  section.append(label, code)
  return section
}

function appendHoverStatus(
  wrapper: HTMLElement,
  message: string,
  tone: 'loading' | 'error',
  classes: WorkbenchEditorLanguageFeatureClasses
): void {
  if (wrapper.childElementCount > 0) appendEditorSymbolTooltipSection(wrapper, classes)
  const status = document.createElement('div')
  status.className = classes.editorSymbolTooltipStatus
  status.dataset.tone = tone
  status.setAttribute('role', 'status')
  status.setAttribute('aria-live', 'polite')
  const dot = document.createElement('span')
  dot.className = classes.editorSymbolTooltipStatusDot
  dot.setAttribute('aria-hidden', 'true')
  const label = document.createElement('span')
  label.textContent = message
  status.append(dot, label)
  wrapper.append(status)
}

function replaceHoverTooltipDom(target: HTMLElement, source: HTMLElement): void {
  target.className = source.className
  target.replaceChildren(...source.childNodes)
}

export function buildWorkbenchEditorHoverDom({
  hover = null,
  diagnostics = [],
  symbolFallback = null,
  definitionLabel = 'Definition',
  definitionPreviewLabel = 'Definition',
  showDefinitionPreview = false,
}: {
  hover?: Nullable<WorkbenchLanguageServiceHoverResult>
  diagnostics?: readonly Diagnostic[]
  symbolFallback?: Nullable<WorkbenchEditorHoverSymbolFallback>
  definitionLabel?: string
  definitionPreviewLabel?: string
  showDefinitionPreview?: boolean
}, classes: WorkbenchEditorLanguageFeatureClasses): HTMLElement {
  const hoverPartClassName = createHoverPartClassName(classes)
  const wrapper = createEditorSymbolTooltipWrapper(classes)

  if (diagnostics.length > 0) {
    const diagnosticSection = document.createElement('div')
    diagnosticSection.className = classes.editorSymbolTooltipDiagnostics

    for (const diagnostic of diagnostics) {
      const item = document.createElement('div')
      item.className = classes.editorSymbolTooltipDiagnostic
      item.dataset.severity = diagnostic.severity
      item.textContent = diagnostic.message
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

    const documentation = createHoverDocumentationSection(hover, classes, hoverPartClassName)
    if (documentation) wrapper.append(documentation)

    if (showDefinitionPreview) {
      const definitionPreview = createHoverDefinitionPreviewSection(
        hover,
        definitionPreviewLabel,
        classes,
        hoverPartClassName
      )
      if (definitionPreview) wrapper.append(definitionPreview)
    }

    if (hover.definition) {
      const location = document.createElement('div')
      location.className = classes.editorSymbolTooltipLocation
      const label = document.createElement('span')
      label.className = classes.editorSymbolTooltipLocationLabel
      label.textContent = definitionLabel
      const target = document.createElement('span')
      target.textContent = `${hover.definition.path}:${hover.definition.line}:${hover.definition.column}`
      location.append(label, target)
      wrapper.append(location)
    }

    if (hover.tags?.length) {
      const location = document.createElement('div')
      location.className = classes.editorSymbolTooltipLocation
      location.textContent = hover.tags.join(' · ')
      wrapper.append(location)
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

function buildWorkbenchEditorHoverStatusDom({
  diagnostics = [],
  message,
  tone,
}: {
  diagnostics?: readonly Diagnostic[]
  message: string
  tone: 'loading' | 'error'
}, classes: WorkbenchEditorLanguageFeatureClasses): HTMLElement {
  const wrapper = buildWorkbenchEditorHoverDom({ diagnostics }, classes)
  wrapper.dataset.state = tone
  appendHoverStatus(wrapper, message, tone, classes)
  return wrapper
}

export function isWorkbenchTypeHover(
  hover: Nullable<WorkbenchLanguageServiceHoverResult>
): boolean {
  return !!hover && /^(?:export\s+)?(?:type|interface|class|enum|record|struct|protocol)\b/u.test(
    hover.displayText.trim()
  )
}

const HOVER_TOKEN_CHARACTER = /[\p{L}\p{N}_$@]/u

export function getWorkbenchHoverTokenRange(
  state: EditorState,
  position: number
): { from: number; to: number } {
  const offset = Math.min(Math.max(0, position), state.doc.length)
  const line = state.doc.lineAt(offset)
  let from = offset
  let to = offset
  while (from > line.from && HOVER_TOKEN_CHARACTER.test(state.sliceDoc(from - 1, from))) from--
  while (to < line.to && HOVER_TOKEN_CHARACTER.test(state.sliceDoc(to, to + 1))) to++
  return from < to
    ? { from, to }
    : { from: offset, to: Math.min(offset + 1, state.doc.length) }
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
    (view, position): Tooltip | null => {
      const diagnosticRange = collectDiagnosticsAtPosition(view, position)
      const request = context.path && usesWorkbenchSemanticLanguageService(context.path)
        ? buildLanguageServiceRequest(view, context, position)
        : null
      if (!request) {
        const fallback = fallbackHover?.(view, position) ?? null
        if (fallback || !diagnosticRange) return fallback
        return {
          pos: diagnosticRange.from,
          end: diagnosticRange.to,
            above: false,
          create: () => ({
            dom: buildWorkbenchEditorHoverDom({ diagnostics: diagnosticRange.diagnostics }, classes),
          }),
        }
      }

      const generation = ++requestGeneration
      const tokenRange = getWorkbenchHoverTokenRange(view.state, position)

      return {
        pos: diagnosticRange?.from ?? tokenRange.from,
        end: diagnosticRange?.to ?? tokenRange.to,
        above: false,
        create: () => {
          let destroyed = false
          let resolvedHover: Nullable<WorkbenchLanguageServiceHoverResult> = null
          let definitionPreviewExpanded = false
          const diagnostics = diagnosticRange?.diagnostics ?? []
          const dom = buildWorkbenchEditorHoverStatusDom({
            diagnostics,
            message: context.hoverLoadingLabel ?? 'Loading language information…',
            tone: 'loading',
          }, classes)
          let hoveredTypeTarget: Nullable<HTMLElement> = null
          let modifierActive = false
          const syncModifierTarget = (): void => {
            for (const target of dom.querySelectorAll('[data-hover-modifier-target]')) {
              target.removeAttribute('data-hover-modifier-target')
            }
            if (
              modifierActive
              && hoveredTypeTarget
              && dom.contains(hoveredTypeTarget)
              && resolvedHover?.definitionPreview
            ) {
              hoveredTypeTarget.dataset.hoverModifierTarget = 'true'
            }
          }
          const updateModifierState = (active: boolean): void => {
            modifierActive = active
            syncModifierTarget()
          }
          const handleWindowKeyDown = (event: KeyboardEvent): void => {
            updateModifierState(event.metaKey || event.ctrlKey)
          }
          const handleWindowKeyUp = (event: KeyboardEvent): void => {
            updateModifierState(event.metaKey || event.ctrlKey)
          }
          const handleWindowBlur = (): void => updateModifierState(false)
          const renderResolvedHover = (): void => {
            replaceHoverTooltipDom(dom, buildWorkbenchEditorHoverDom({
              hover: resolvedHover,
              diagnostics,
              definitionLabel: context.hoverDefinitionLabel,
              definitionPreviewLabel: context.hoverDefinitionPreviewLabel,
              showDefinitionPreview: definitionPreviewExpanded,
            }, classes))
            if (resolvedHover?.definitionPreview) dom.dataset.hasDefinitionPreview = 'true'
            else delete dom.dataset.hasDefinitionPreview
            hoveredTypeTarget = null
            syncModifierTarget()
          }
          const handleTypeDefinitionPointerDown = (event: PointerEvent): void => {
            if (event.button !== 0 || (!event.metaKey && !event.ctrlKey)) return
            const target = event.target instanceof Element
              ? event.target.closest('[data-hover-part="type"]')
              : null
            if (!target || !dom.contains(target) || !resolvedHover?.definitionPreview) return

            event.preventDefault()
            event.stopPropagation()
            event.stopImmediatePropagation()
            definitionPreviewExpanded = true
            renderResolvedHover()
            view.requestMeasure()
          }
          dom.addEventListener('mousemove', (event) => {
            hoveredTypeTarget = event.target instanceof Element
              ? event.target.closest<HTMLElement>('[data-hover-part="type"]')
              : null
            updateModifierState(event.metaKey || event.ctrlKey)
          })
          dom.addEventListener('mouseleave', () => {
            hoveredTypeTarget = null
            syncModifierTarget()
          })
          dom.addEventListener('pointerdown', handleTypeDefinitionPointerDown, true)
          window.addEventListener('keydown', handleWindowKeyDown, true)
          window.addEventListener('keyup', handleWindowKeyUp, true)
          window.addEventListener('blur', handleWindowBlur)

          void getWorkbenchLanguageServiceHover(request, context.hostRuntime).then(
            (result) => {
              if (destroyed || generation !== requestGeneration) return
              if (!result.ok) {
                replaceHoverTooltipDom(dom, buildWorkbenchEditorHoverStatusDom({
                  diagnostics,
                  message: context.hoverUnavailableLabel ?? result.error.message,
                  tone: 'error',
                }, classes))
                view.requestMeasure()
                return
              }

              const hover = result.data.hover
              resolvedHover = hover
              if (!diagnosticRange && !hover) {
                view.dispatch({ effects: closeHoverTooltips })
                return
              }

              renderResolvedHover()
              view.requestMeasure()
            },
            () => {
              if (destroyed || generation !== requestGeneration) return
              replaceHoverTooltipDom(dom, buildWorkbenchEditorHoverStatusDom({
                diagnostics,
                message: context.hoverUnavailableLabel ?? 'Language information is unavailable.',
                tone: 'error',
              }, classes))
              view.requestMeasure()
            }
          )

          return {
            dom,
            destroy: () => {
              destroyed = true
              window.removeEventListener('keydown', handleWindowKeyDown, true)
              window.removeEventListener('keyup', handleWindowKeyUp, true)
              window.removeEventListener('blur', handleWindowBlur)
            },
          }
        },
      }
    },
    { hoverTime: 240 }
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
