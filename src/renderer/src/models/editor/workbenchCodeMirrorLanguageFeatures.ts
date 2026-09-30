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

import { getWorkbenchJavaScriptKeywordRangeAtPosition } from './workbenchCodeMirrorBasicSyntax'
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

/** 诊断浮层上的一个修复按钮。 */
export interface WorkbenchEditorHoverAction {
  title: string
  run: () => void
}

/** 诊断浮层向编辑器要修复：这段范围上的诊断此刻有哪些能直接套的修复（只读、没有修复时为空）。 */
export interface WorkbenchEditorHoverCodeActions {
  request: (view: EditorView, from: number, to: number) => Promise<readonly WorkbenchEditorHoverAction[]>
}

export interface WorkbenchLanguageServiceEditorContext {
  projectRoot: string
  path: Nullable<string>
  language: string
  getOpenTabs: () => readonly WorkbenchOpenEditorTab[]
  hostRuntime?: WorkbenchHostRuntime
  hoverDefinitionLabel?: string
  hoverDefinitionPreviewLabel?: string
  /** 给了就在诊断浮层上列出修复按钮。 */
  codeActions?: WorkbenchEditorHoverCodeActions
}

/** 由产品 UI 注入的语言服务浮层样式；模型不依赖任何宿主 CSS Module。 */
export interface WorkbenchEditorLanguageFeatureClasses {
  editorSignatureTooltip: string
  editorSignatureTooltipHost: string
  editorSignatureTooltipParameter: string
  editorSignatureTooltipSignature: string
  editorSymbolTooltip: string
  editorSymbolTooltipAction: string
  editorSymbolTooltipActions: string
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

/** 段落里的 `\n` 是说明里的硬换行（参数表、列表逐行排），画成换行。 */
function appendHoverDocumentationLines(container: HTMLElement, text: string): void {
  text.split('\n').forEach((line, index) => {
    if (index > 0) container.append(document.createElement('br'))
    container.append(document.createTextNode(line))
  })
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
    appendHoverDocumentationLines(container, text.slice(cursor, start))
    const code = document.createElement('code')
    code.className = classes.editorSymbolTooltipInlineCode
    code.textContent = match[1] ?? ''
    container.append(code)
    cursor = start + match[0].length
  }
  appendHoverDocumentationLines(container, text.slice(cursor))
}

function hoverDocumentationBlocks(
  hover: WorkbenchLanguageServiceHoverResult
): readonly WorkbenchLanguageServiceHoverDocumentationBlock[] {
  if (hover.documentationBlocks?.length) return hover.documentationBlocks
  // 没有分块的说明（TypeScript 的 JSDoc）按一段连排：注释里的折行只是源码折行。
  const text = (
    hover.documentation
    ?? hover.documentationParts?.map((part) => part.text).join('')
    ?? ''
  ).replace(/[ \t]*\n[ \t]*/gu, ' ')
  return text ? [{ kind: 'paragraph', text }] : []
}

function hoverHasDisplayCode(hover: WorkbenchLanguageServiceHoverResult): boolean {
  return !!(
    hover.displayText.trim()
    || hover.displayParts?.some((part) => part.text.trim())
  )
}

export function shouldUseWorkbenchSingleCodeHoverLayout(
  hover: Nullable<WorkbenchLanguageServiceHoverResult>,
  {
    hasDiagnostics = false,
    showDefinitionPreview = false,
  }: {
    hasDiagnostics?: boolean
    showDefinitionPreview?: boolean
  } = {}
): boolean {
  if (
    !hover
    || hasDiagnostics
    || hover.definition
    || hover.tags?.length
    || (showDefinitionPreview && hover.definitionPreview?.text.trim())
  ) return false

  const blocks = hoverDocumentationBlocks(hover).filter((block) => block.text.trim())
  if (hoverHasDisplayCode(hover)) return blocks.length === 0
  return blocks.length === 1 && blocks[0]?.kind === 'code'
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

function replaceHoverTooltipDom(target: HTMLElement, source: HTMLElement): void {
  target.className = source.className
  target.replaceChildren(...source.childNodes)
}

export function buildWorkbenchEditorHoverDom({
  hover = null,
  diagnostics = [],
  diagnosticActions = [],
  symbolFallback = null,
  definitionLabel = 'Definition',
  definitionPreviewLabel = 'Definition',
  showDefinitionPreview = false,
}: {
  hover?: Nullable<WorkbenchLanguageServiceHoverResult>
  diagnostics?: readonly Diagnostic[]
  /** 这些诊断的修复，列成按钮排在诊断下面。 */
  diagnosticActions?: readonly WorkbenchEditorHoverAction[]
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

    if (diagnosticActions.length > 0) {
      const actions = document.createElement('div')
      actions.className = classes.editorSymbolTooltipActions
      for (const action of diagnosticActions) {
        const button = document.createElement('button')
        button.type = 'button'
        button.className = classes.editorSymbolTooltipAction
        button.textContent = action.title
        button.title = action.title
        // 按下时不把焦点从编辑器里拿走：点完接着就能敲。
        button.addEventListener('mousedown', (event) => event.preventDefault())
        button.addEventListener('click', () => action.run())
        actions.append(button)
      }
      diagnosticSection.append(actions)
    }

    wrapper.append(diagnosticSection)
  }

  if (hover) {
    if (diagnostics.length > 0) {
      appendEditorSymbolTooltipSection(wrapper, classes)
    }

    if (shouldUseWorkbenchSingleCodeHoverLayout(hover, {
      hasDiagnostics: diagnostics.length > 0,
      showDefinitionPreview,
    })) wrapper.dataset.layout = 'single-code'

    if (hoverHasDisplayCode(hover)) {
      wrapper.append(
        createHighlightedHoverSection(classes.editorSymbolTooltipTitle, hoverPartClassName, {
          parts: hover.displayParts,
          fallbackText: hover.displayText,
        })
      )
    }

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
      const tags = document.createElement('div')
      tags.className = classes.editorSymbolTooltipDocs
      for (const tag of hover.tags) {
        const item = document.createElement('p')
        item.className = classes.editorSymbolTooltipDocsParagraph
        item.textContent = tag
        tags.append(item)
      }
      wrapper.append(tags)
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

/** 点了浮层上的修复按钮：先收起浮层（它指着的代码就要变了），再套修复。 */
function closeHoverOnRun(
  view: EditorView,
  actions: readonly WorkbenchEditorHoverAction[]
): WorkbenchEditorHoverAction[] {
  return actions.map((action) => ({
    title: action.title,
    run: () => {
      view.dispatch({ effects: closeHoverTooltips })
      action.run()
    },
  }))
}

export function createWorkbenchLanguageServiceHoverTooltip(
  context: WorkbenchLanguageServiceEditorContext,
  classes: WorkbenchEditorLanguageFeatureClasses,
  fallbackHover?: (view: EditorView, position: number) => Tooltip | null
): Extension {
  let requestGeneration = 0

  return hoverTooltip(
    async (view, position): Promise<Tooltip | null> => {
      const generation = ++requestGeneration
      const diagnosticRange = collectDiagnosticsAtPosition(view, position)
      const keywordRange = getWorkbenchJavaScriptKeywordRangeAtPosition(
        view.state.doc,
        position,
        context.language
      )
      if (keywordRange && !diagnosticRange) return null

      // 诊断的修复与悬浮说明一起问：浮层不等修复，先显示诊断，修复回来再把按钮补上。
      const actionsRequest = diagnosticRange && context.codeActions
        ? context.codeActions
            .request(view, diagnosticRange.from, diagnosticRange.to)
            .then((actions) => closeHoverOnRun(view, actions))
            .catch((): readonly WorkbenchEditorHoverAction[] => [])
        : null

      const request = !keywordRange
        && context.path
        && usesWorkbenchSemanticLanguageService(context.path)
        ? buildLanguageServiceRequest(view, context, position)
        : null
      if (!request) {
        const fallback = fallbackHover?.(view, position) ?? null
        if (fallback || !diagnosticRange) return fallback
        return {
          pos: diagnosticRange.from,
          end: diagnosticRange.to,
          above: false,
          create: () => {
            const { diagnostics } = diagnosticRange
            const dom = buildWorkbenchEditorHoverDom({ diagnostics }, classes)
            let destroyed = false
            void actionsRequest?.then((diagnosticActions) => {
              if (destroyed || isEmpty(diagnosticActions)) return
              replaceHoverTooltipDom(
                dom,
                buildWorkbenchEditorHoverDom({ diagnostics, diagnosticActions }, classes)
              )
              view.requestMeasure()
            })
            return {
              dom,
              destroy: () => {
                destroyed = true
              },
            }
          },
        }
      }

      const sourceDocument = view.state.doc
      const tokenRange = getWorkbenchHoverTokenRange(view.state, position)
      let resolvedHover: Nullable<WorkbenchLanguageServiceHoverResult> = null
      try {
        const result = await getWorkbenchLanguageServiceHover(request, context.hostRuntime)
        if (generation !== requestGeneration || view.state.doc !== sourceDocument) return null
        resolvedHover = result.ok ? result.data.hover : null
      } catch {
        if (generation !== requestGeneration || view.state.doc !== sourceDocument) return null
      }
      if (!diagnosticRange && !resolvedHover) return null

      return {
        pos: diagnosticRange?.from ?? tokenRange.from,
        end: diagnosticRange?.to ?? tokenRange.to,
        above: false,
        create: () => {
          let definitionPreviewExpanded = false
          const diagnostics = diagnosticRange?.diagnostics ?? []
          let diagnosticActions: readonly WorkbenchEditorHoverAction[] = []
          const dom = buildWorkbenchEditorHoverDom({
            hover: resolvedHover,
            diagnostics,
            definitionLabel: context.hoverDefinitionLabel,
            definitionPreviewLabel: context.hoverDefinitionPreviewLabel,
            showDefinitionPreview: definitionPreviewExpanded,
          }, classes)
          if (resolvedHover?.definitionPreview) dom.dataset.hasDefinitionPreview = 'true'
          let hoveredTypeTarget: Nullable<HTMLElement> = null
          let modifierTypeTarget: Nullable<HTMLElement> = null
          let modifierActive = false
          let previewRenderFrame: Nullable<number> = null
          let destroyed = false
          const syncModifierTarget = (): void => {
            const nextTarget = (
              modifierActive
              && hoveredTypeTarget
              && dom.contains(hoveredTypeTarget)
              && resolvedHover?.definitionPreview
            ) ? hoveredTypeTarget : null
            if (modifierTypeTarget === nextTarget) return

            modifierTypeTarget?.removeAttribute('data-hover-modifier-target')
            nextTarget?.setAttribute('data-hover-modifier-target', 'true')
            modifierTypeTarget = nextTarget
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
              diagnosticActions,
              definitionLabel: context.hoverDefinitionLabel,
              definitionPreviewLabel: context.hoverDefinitionPreviewLabel,
              showDefinitionPreview: definitionPreviewExpanded,
            }, classes))
            if (resolvedHover?.definitionPreview) dom.dataset.hasDefinitionPreview = 'true'
            else delete dom.dataset.hasDefinitionPreview
            hoveredTypeTarget = null
            modifierTypeTarget = null
            syncModifierTarget()
          }
          const scheduleResolvedHoverRender = (): void => {
            if (previewRenderFrame !== null || destroyed) return
            previewRenderFrame = window.requestAnimationFrame(() => {
              previewRenderFrame = null
              if (destroyed || !dom.isConnected) return
              renderResolvedHover()
              view.requestMeasure()
            })
          }
          const handleTypeDefinitionPointerDown = (event: PointerEvent): void => {
            if (event.button !== 0 || (!event.metaKey && !event.ctrlKey)) return
            const target = event.target instanceof Element
              ? event.target.closest('[data-hover-part="type"]')
              : null
            if (!target || !dom.contains(target) || !resolvedHover?.definitionPreview) return

            event.preventDefault()
            event.stopPropagation()
            if (definitionPreviewExpanded) return
            definitionPreviewExpanded = true
            scheduleResolvedHoverRender()
          }
          const handleHoverMouseMove = (event: MouseEvent): void => {
            hoveredTypeTarget = event.target instanceof Element
              ? event.target.closest<HTMLElement>('[data-hover-part="type"]')
              : null
            updateModifierState(event.metaKey || event.ctrlKey)
          }
          const handleHoverMouseLeave = (): void => {
            hoveredTypeTarget = null
            syncModifierTarget()
          }
          dom.addEventListener('mousemove', handleHoverMouseMove)
          dom.addEventListener('mouseleave', handleHoverMouseLeave)
          dom.addEventListener('pointerdown', handleTypeDefinitionPointerDown, true)
          window.addEventListener('keydown', handleWindowKeyDown, true)
          window.addEventListener('keyup', handleWindowKeyUp, true)
          window.addEventListener('blur', handleWindowBlur)
          void actionsRequest?.then((actions) => {
            if (destroyed || isEmpty(actions)) return
            diagnosticActions = actions
            scheduleResolvedHoverRender()
          })

          return {
            dom,
            destroy: () => {
              destroyed = true
              if (previewRenderFrame !== null) {
                window.cancelAnimationFrame(previewRenderFrame)
                previewRenderFrame = null
              }
              dom.removeEventListener('mousemove', handleHoverMouseMove)
              dom.removeEventListener('mouseleave', handleHoverMouseLeave)
              dom.removeEventListener('pointerdown', handleTypeDefinitionPointerDown, true)
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
