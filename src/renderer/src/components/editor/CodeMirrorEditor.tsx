import {
  forwardRef,
  type MouseEvent as ReactMouseEvent,
  type ReactElement,
  type RefObject,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { createPortal } from 'react-dom'
import {
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
  type CompletionContext,
  type CompletionResult,
  type CompletionSource,
  startCompletion,
} from '@codemirror/autocomplete'
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentLess,
  indentMore,
  indentWithTab,
  toggleComment,
} from '@codemirror/commands'
import {
  bracketMatching,
  foldEffect,
  foldGutter,
  foldKeymap,
  indentOnInput,
  indentUnit,
} from '@codemirror/language'
import { type Diagnostic, linter, lintKeymap } from '@codemirror/lint'
import { searchKeymap, selectNextOccurrence } from '@codemirror/search'
import type { Extension } from '@codemirror/state'
import {
  Annotation,
  Compartment,
  EditorSelection,
  EditorState,
  RangeSetBuilder,
} from '@codemirror/state'
import {
  closeHoverTooltips,
  crosshairCursor,
  Decoration,
  type DecorationSet,
  drawSelection,
  dropCursor,
  EditorView,
  highlightSpecialChars,
  keymap,
  type MouseSelectionStyle,
  rectangularSelection,
  tooltips,
  ViewPlugin,
  type ViewUpdate,
} from '@codemirror/view'
import { HammerIcon, PlayIcon } from '@phosphor-icons/react'
import {
  addWorkbenchCommentAnchorEffect,
  anchorFromLineRange,
  createWorkbenchCommentExtension,
  retainWorkbenchCommentAnchorsEffect,
  setWorkbenchCommentAnchorsEffect,
} from '@renderer/components/editor/workbenchCommentExtension'
import {
  buildWorkbenchExplanationAnchors,
  createWorkbenchExplanationExtension,
  setWorkbenchExplanationAnchorsEffect,
} from '@renderer/components/editor/workbenchExplanationExtension'
import { useWorkbenchEditorMetrics } from '@renderer/hooks/useWorkbenchPreferences'
import {
  useWorkbenchHostRuntime,
  type WorkbenchHostRuntime,
} from '@renderer/host'
import { useWorkbenchI18n } from '@renderer/i18n'
import type { PackageManagerCommand } from '@renderer/models/commands/workbenchPackageScriptCommand'
import {
  buildWorkbenchVelarBuildCommand,
  buildWorkbenchVelarRunCommand,
  isWorkbenchVelarFilePath,
} from '@renderer/models/commands/workbenchVelarFileCommand'
import {
  useWorkbenchComments,
  useWorkbenchCommentStore,
} from '@renderer/models/comments/workbenchCommentStore'
import {
  revealWorkbenchActiveLine,
  suppressWorkbenchActiveLine,
  workbenchActiveLineExtension,
} from '@renderer/models/editor/workbenchCodeMirrorActiveLine'
import { getWorkbenchCodeMirrorAutocompleteTheme } from '@renderer/models/editor/workbenchCodeMirrorAutocompleteTheme'
import { createWorkbenchBasicSyntaxExtension } from '@renderer/models/editor/workbenchCodeMirrorBasicSyntax'
import {
  WORKBENCH_COMPLETION_ACTIVATE_ON_TYPING_DELAY_MS,
  WORKBENCH_COMPLETION_UPDATE_SYNC_TIME_MS,
  workbenchCompletionAddToOptions,
  workbenchCompletionOptionClass,
} from '@renderer/models/editor/workbenchCodeMirrorCompletionPresentation'
import { buildWorkbenchCodeMirrorCompletionResult } from '@renderer/models/editor/workbenchCodeMirrorCompletions'
import {
  setWorkbenchDefinitionHoverRange,
  workbenchDefinitionHoverExtension,
  type WorkbenchDefinitionHoverRange,
} from '@renderer/models/editor/workbenchCodeMirrorDefinitionHover'
import {
  createWorkbenchDiagnosticForegroundExtension,
  mapWorkbenchDiagnosticToCodeMirror,
} from '@renderer/models/editor/workbenchCodeMirrorDiagnostics'
import {
  buildWorkbenchExternalValueSyncTransaction,
  resolveWorkbenchExternalValueSyncSelection,
} from '@renderer/models/editor/workbenchCodeMirrorExternalSync'
import { createWorkbenchInlayHintExtension } from '@renderer/models/editor/workbenchCodeMirrorInlayHints'
import {
  workbenchInlineCompletionExtension,
  type WorkbenchInlineCompletionRuntime,
} from '@renderer/models/editor/workbenchCodeMirrorInlineCompletion'
import {
  resolveWorkbenchCodeMirrorLanguage,
} from '@renderer/models/editor/workbenchCodeMirrorLanguage'
import {
  buildWorkbenchEditorHoverDom,
  collectDiagnosticsAtPosition,
  createWorkbenchLanguageServiceHoverTooltip,
  createWorkbenchSignatureHelpExtension,
  findWorkbenchLanguageServiceReferences,
} from '@renderer/models/editor/workbenchCodeMirrorLanguageFeatures'
import {
  applyWorkbenchLanguageServiceEditsToContent,
  buildWorkbenchLanguageServiceRequestBase,
  languageServiceRangeToOffsets,
  mergeWorkbenchLanguageServiceCompletions,
  usesWorkbenchBuiltinLanguageService,
  usesWorkbenchExternalLspLanguageService,
  usesWorkbenchExternalSemanticLanguageService,
  usesWorkbenchHtmlLanguageService,
  usesWorkbenchInlayHintLanguageService,
  usesWorkbenchSemanticLanguageService,
} from '@renderer/models/editor/workbenchCodeMirrorLanguageService'
import { workbenchLineNumbersExtension } from '@renderer/models/editor/workbenchCodeMirrorLineNumberSelection'
import { createWorkbenchCodeMirrorMetricsExtension } from '@renderer/models/editor/workbenchCodeMirrorMetrics'
import {
  createWorkbenchSemanticTokensExtension,
  getWorkbenchSemanticTokenTheme,
} from '@renderer/models/editor/workbenchCodeMirrorSemanticTokens'
import {
  getWorkbenchCodeMirrorLintTheme,
  getWorkbenchCodeMirrorTheme,
} from '@renderer/models/editor/workbenchCodeMirrorTheme'
import { createWorkbenchTokenOccurrenceHighlightExtension } from '@renderer/models/editor/workbenchCodeMirrorTokenOccurrenceHighlight'
import { buildWorkbenchIdeaIndentGuideColumnsForLineRange } from '@renderer/models/editor/workbenchIndentGuides'
import {
  getWorkbenchInlineCompletion,
  getWorkbenchLanguageServiceCodeActions,
  getWorkbenchLanguageServiceCompletions,
  getWorkbenchLanguageServiceDefinition,
  getWorkbenchLanguageServiceDiagnostics,
  getWorkbenchLanguageServiceDocumentHighlights,
  getWorkbenchLanguageServiceFormat,
  getWorkbenchLanguageServiceInlayHints,
  getWorkbenchLanguageServiceReferences,
  getWorkbenchLanguageServiceRename,
  getWorkbenchLanguageServiceSemanticTokens,
} from '@renderer/models/editor/workbenchLanguageServiceIpc'
import {
  createWorkbenchPackageScriptRunGutterExtension,
  shouldShowWorkbenchPackageScriptRunGutter,
} from '@renderer/models/editor/workbenchPackageScriptRunGutter'
import {
  buildWorkbenchSymbolLocationsRequest,
  sameWorkbenchSymbolLocation,
  type WorkbenchSymbolLocationsRequest,
  type WorkbenchSymbolLocationsState,
} from '@renderer/models/editor/workbenchSymbolLocations'
import {
  createWorkbenchVelarMainRunGutterExtension,
  shouldShowWorkbenchVelarMainRunGutter,
} from '@renderer/models/editor/workbenchVelarMainRunGutter'
import {
  createWorkbenchVelarTestRunGutterExtension,
  shouldShowWorkbenchVelarTestRunGutter,
} from '@renderer/models/editor/workbenchVelarTestRunGutter'
import {
  useWorkbenchExplanations,
  useWorkbenchExplanationStore,
} from '@renderer/models/explanations/workbenchExplanationStore'
import type { WorkbenchProjectContextIndex } from '@renderer/models/project/workbenchProjectContextIndex'
import type { WorkbenchThemeId } from '@renderer/models/settings/workbenchPreferences'
import { useStandaloneWorkbenchModelConfig } from '@renderer/runtime/standaloneWorkbenchModelConfig'
import type { WorkbenchOpenEditorTab } from '@renderer/types/workbenchTypes'

import { isEmpty, isPresent, Log, toNullable, toOptional } from '@velaros-ai/core'

import type {
  WorkbenchLanguageServiceCodeAction,
  WorkbenchLanguageServiceDiagnostic,
  WorkbenchLanguageServiceFileEdit,
  WorkbenchLanguageServiceLocation,
} from '@shared/contracts'

import styles from '../../styles/workbenchPageStyles'
import { useLatest, useTimerScope } from '../../support/genericHooks'
import { useBlockWheelScroll } from '../../support/useBlockWheelScroll'
import { useDismissOnWindowInteract } from '../../support/useDismissOnWindowInteract'

import { EditorSymbolLocationsPanel } from './EditorSymbolLocationsPanel'
import { workbenchEditorLanguageFeatureClasses } from './workbenchEditorLanguageFeatureClasses'

/** Agent 带用户看代码时不抢焦点：用户可能正在输入框里打字。 */
export interface CodeMirrorEditorNavigationOptions {
  focus?: boolean
}

export interface CodeMirrorEditorHandle {
  focus: () => void
  moveToLine: (line: number, column?: number, options?: CodeMirrorEditorNavigationOptions) => void
  /** 选中 startLine..endLine 整行并滚到视野中间（指给用户看一段代码）。 */
  selectLines: (
    startLine: number,
    endLine: number,
    options?: CodeMirrorEditorNavigationOptions
  ) => void
  openCompletion: () => void
  selectRange: (from: number, to: number) => void
}

interface CodeMirrorEditorProps {
  projectRoot: string
  path: Nullable<string>
  language: string
  value: string
  readOnly: boolean
  disabled: boolean
  projectContextIndex: WorkbenchProjectContextIndex
  openTabs?: WorkbenchOpenEditorTab[]
  packageManager?: PackageManagerCommand
  workbenchTheme: WorkbenchThemeId
  onChange: (content: string) => void
  onCursorPositionChange?: (position: {
    line: number
    column: number
    selection?: {
      startLine: number
      endLine: number
      startColumn: number
      endColumn: number
    }
  }) => void
  onOpenFind: () => void
  onOpenGoToLine: () => void
  onGoToDefinition: (path: string, line: number, column?: number) => void
  symbolLocations?: Nullable<WorkbenchSymbolLocationsState>
  onOpenSymbolLocations?: (request: WorkbenchSymbolLocationsRequest, visible?: boolean) => void
  onCloseSymbolLocations?: () => void
  onNavigateSymbolLocation?: (location: WorkbenchLanguageServiceLocation) => void
  onApplyLanguageServiceFileChanges?: (changes: WorkbenchLanguageServiceFileEdit[]) => void
  onRunPackageScript?: (command: string) => void
  onOpenFileHistory?: (mode: 'local' | 'git') => void
  onSave: () => void
}

type GetWorkbenchOpenTabs = () => readonly WorkbenchOpenEditorTab[]
type GetWorkbenchProjectContextIndex = () => WorkbenchProjectContextIndex

const externalValueSync = Annotation.define<boolean>()
const log = Log.tag('codemirror-editor')
const INDENT_GUIDE_STROKE_PX = 0.75
const INDENT_GUIDE_COLOR = 'rgba(105, 118, 142, 0.26)'
const IDENTIFIER_PATTERN = /[A-Za-z_$][\w$]*/g
const FullSyntaxActivationDelayMs = 90
const SemanticFeaturesActivationDelayMs = 220
const EditorIdleActivationTimeoutMs = 800

function requestWorkbenchEditorIdleTask(callback: () => void): () => void {
  if (!window.requestIdleCallback) {
    callback()
    return () => undefined
  }

  // 文件树加载、索引和 React 渲染可能长期占满主线程；没有 timeout 时 Chromium
  // 允许一直不执行 idle callback，进而让语义能力永久缺席。
  const handle = window.requestIdleCallback(callback, { timeout: EditorIdleActivationTimeoutMs })
  return () => window.cancelIdleCallback(handle)
}

interface WorkbenchIdentifierRange {
  text: string
  from: number
  to: number
}

interface WorkbenchSymbolLocationsAnchor {
  left: number
  top: number
  bottom: number
}

interface EditorContextMenuState {
  x: number
  y: number
  word: Nullable<WorkbenchIdentifierRange>
  canGoToDefinition: boolean
  hasSelection: boolean
}

/** 折叠栏标记使用 DOM 节点，避免默认细字形被主题覆盖后难以辨认。 */
const workbenchFoldGutter = foldGutter({
  markerDOM(open) {
    const span = document.createElement('span')
    span.className = 'cm-workbenchFoldMarker'
    span.textContent = open ? '▾' : '▸'
    return span
  },
})

const workbenchTripleClickLineSelectionExtension = EditorView.mouseSelectionStyle.of(
  (view, event): Nullable<MouseSelectionStyle> => {
    if (event.button !== 0 || event.detail < 3) return null
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return null
    if (!(event.target instanceof Node) || !view.contentDOM.contains(event.target)) return null

    return {
      get(currentEvent) {
        const position =
          view.posAtCoords({ x: currentEvent.clientX, y: currentEvent.clientY }) ??
          view.state.selection.main.head
        const line = view.state.doc.lineAt(position)
        return EditorSelection.create([EditorSelection.range(line.from, line.to)])
      },
      update() {
        return false
      },
    }
  }
)

/** 对齐基础编辑器配置，同时替换折叠栏并保持扩展顺序稳定。 */
const workbenchCodeMirrorBaseExtensions: Extension[] = [
  workbenchLineNumbersExtension,
  workbenchActiveLineExtension,
  highlightSpecialChars(),
  history(),
  workbenchFoldGutter,
  workbenchTripleClickLineSelectionExtension,
  drawSelection(),
  dropCursor(),
  EditorState.allowMultipleSelections.of(true),
  indentOnInput(),
  bracketMatching(),
  closeBrackets(),
  autocompletion({
    activateOnTyping: true,
    activateOnTypingDelay: WORKBENCH_COMPLETION_ACTIVATE_ON_TYPING_DELAY_MS,
    updateSyncTime: WORKBENCH_COMPLETION_UPDATE_SYNC_TIME_MS,
    maxRenderedOptions: 24,
    icons: true,
    defaultKeymap: true,
    selectOnOpen: true,
    optionClass: workbenchCompletionOptionClass,
    addToOptions: workbenchCompletionAddToOptions,
  }),
  rectangularSelection(),
  crosshairCursor(),
  workbenchDefinitionHoverExtension,
  keymap.of([
    ...closeBracketsKeymap,
    ...defaultKeymap,
    ...searchKeymap,
    ...historyKeymap,
    ...foldKeymap,
    ...lintKeymap,
  ]),
]

/** 覆盖编辑器挂载组件的视觉样式；几何尺寸由 metrics compartment 统一管理。 */
const workbenchEditorChromeTheme = EditorView.theme(
  {
    '.cm-cursor': {
      borderLeftStyle: 'solid',
      borderLeftColor: 'var(--workbench-editor-caret)',
    },
    '.cm-tooltip': {
      backgroundColor: 'var(--workbench-editor-tooltip-bg, #ffffff)',
      border: '1px solid var(--workbench-editor-gutter-border, #d0d7e2)',
      borderRadius: '8px',
      boxShadow: '0 12px 28px rgba(15, 23, 42, 0.14)',
      overflow: 'hidden',
    },
    '.cm-tooltip-hover, .cm-tooltip.cm-tooltip-hover': {
      maxHeight: 'min(420px, 50vh)',
      backgroundColor: 'var(--workbench-editor-tooltip-bg, #ffffff)',
    },
  },
  { dark: false }
)

function clampPosition(position: number, docLength: number): number {
  return Math.min(Math.max(0, position), docLength)
}

function positionLineColumnFromState(
  state: EditorState,
  pos: number
): { line: number; column: number; offset: number } {
  const offset = clampPosition(pos, state.doc.length)
  const line = state.doc.lineAt(offset)
  return { line: line.number, column: offset - line.from + 1, offset }
}

function positionLineColumn(view: EditorView, pos: number): { line: number; column: number } {
  return positionLineColumnFromState(view.state, pos)
}

function offsetFromLineColumnState(state: EditorState, lineNumber: number, column: number): number {
  const line = state.doc.line(Math.min(Math.max(1, lineNumber), state.doc.lines))
  return clampPosition(line.from + Math.max(0, column - 1), line.to)
}

function languageServiceEditToCodeMirrorChange(
  state: EditorState,
  edit: {
    range: {
      startLine: number
      startColumn: number
      endLine: number
      endColumn: number
    }
    newText: string
  }
): { from: number; to: number; insert: string } {
  return {
    from: offsetFromLineColumnState(state, edit.range.startLine, edit.range.startColumn),
    to: offsetFromLineColumnState(state, edit.range.endLine, edit.range.endColumn),
    insert: edit.newText,
  }
}

function getIdentifierAt(state: EditorState, position: number): Nullable<WorkbenchIdentifierRange> {
  const content = state.doc.toString()
  const target = clampPosition(position, content.length)

  for (const match of content.matchAll(IDENTIFIER_PATTERN)) {
    const from = match.index ?? 0
    const to = from + match[0].length
    if (target >= from && target <= to) return { text: match[0], from, to }
  }

  return null
}

function findWorkbenchDefinitionTarget({
  word,
  path,
  projectContextIndex,
}: {
  word: string
  path: Nullable<string>
  projectContextIndex: WorkbenchProjectContextIndex
}): Nullable<{ path: string; line: number; column: number }> {
  const candidates = projectContextIndex.symbols.filter((symbol) => symbol.label === word)
  const target = toNullable(
    candidates.find((symbol) => symbol.kind === 'declaration' && symbol.path === path) ??
      candidates.find((symbol) => symbol.kind === 'declaration' && symbol.path !== path) ??
      candidates.find((symbol) => symbol.path === path) ??
      candidates.find((symbol) => symbol.path !== path)
  )

  if (!target) return null

  return {
    path: target.path,
    line: target.line ?? 1,
    column: target.column ?? 1,
  }
}

function buildIdentifierRenameChanges(
  content: string,
  currentName: string,
  nextName: string
): Array<{ from: number; to: number; insert: string }> {
  const changes: Array<{ from: number; to: number; insert: string }> = []

  for (const match of content.matchAll(IDENTIFIER_PATTERN)) {
    if (match[0] !== currentName) {
      continue
    }

    const from = match.index ?? 0
    changes.push({
      from,
      to: from + currentName.length,
      insert: nextName,
    })
  }

  return changes
}

function findImportFoldRange(state: EditorState): Nullable<{ from: number; to: number }> {
  let firstImportLine: Nullable<number> = null
  let lastImportLine: Nullable<number> = null
  let lineNumber = 1

  while (lineNumber <= state.doc.lines) {
    const line = state.doc.line(lineNumber)
    const trimmed = line.text.trim()

    if (!trimmed) {
      lineNumber += 1
      continue
    }

    if (!trimmed.startsWith('import ')) {
      break
    }

    firstImportLine ??= lineNumber
    lastImportLine = lineNumber
    lineNumber += 1
  }

  if (
    !isPresent(firstImportLine) ||
    !isPresent(lastImportLine) ||
    lastImportLine <= firstImportLine
  )
    return null

  const firstLine = state.doc.line(firstImportLine)
  const lastLine = state.doc.line(lastImportLine)

  return { from: firstLine.to, to: lastLine.to }
}

function foldImportBlock(view: EditorView): boolean {
  const range = findImportFoldRange(view.state)
  if (!range || range.to <= range.from) return false

  view.dispatch({ effects: foldEffect.of(range) })
  return true
}

function buildIdentifierSelectionRanges(
  content: string,
  identifier: string
): Array<ReturnType<typeof EditorSelection.range>> {
  const ranges: Array<ReturnType<typeof EditorSelection.range>> = []

  for (const match of content.matchAll(IDENTIFIER_PATTERN)) {
    if (match[0] !== identifier) {
      continue
    }

    const from = match.index ?? 0
    ranges.push(EditorSelection.range(from, from + identifier.length))
  }

  return ranges
}

function emitCursorPosition(
  view: EditorView,
  callback: CodeMirrorEditorProps['onCursorPositionChange']
): void {
  const sel = view.state.selection.main
  const headInfo = positionLineColumn(view, sel.head)
  let selection: LooseOptional<{
    startLine: number
    endLine: number
    startColumn: number
    endColumn: number
  }>
  if (!sel.empty) {
    const startPos = Math.min(sel.anchor, sel.head)
    const endPos = Math.max(sel.anchor, sel.head)
    const start = positionLineColumn(view, startPos)
    const end = positionLineColumn(view, endPos)
    selection = {
      startLine: start.line,
      endLine: end.line,
      startColumn: start.column,
      endColumn: end.column,
    }
  }

  callback?.({
    line: headInfo.line,
    column: headInfo.column,
    selection: selection || undefined,
  })
}

function createWorkbenchCompletionSource({
  projectRoot,
  path,
  language,
  getOpenTabs,
  getProjectContextIndex,
  hostRuntime,
}: {
  projectRoot: string
  path: Nullable<string>
  language: string
  getOpenTabs: GetWorkbenchOpenTabs
  getProjectContextIndex: GetWorkbenchProjectContextIndex
  hostRuntime: WorkbenchHostRuntime
}): CompletionSource {
  let requestGeneration = 0
  let pendingLanguageRequest: Nullable<{ content: string; position: number }> = null
  let cachedLanguageResult: Nullable<{
    content: string
    position: number
    result: CompletionResult
  }> = null

  return (context: CompletionContext) => {
    const selection = context.state.selection.main
    const content = context.state.doc.toString()
    const localResult = buildWorkbenchCodeMirrorCompletionResult({
      path,
      language,
      content,
      selectionStart: selection.from,
      selectionEnd: selection.to,
      explicit: context.explicit,
      projectContextIndex: getProjectContextIndex(),
    })

    if (!path || !usesWorkbenchBuiltinLanguageService(path)) return localResult || null
    if (
      cachedLanguageResult?.content === content
      && cachedLanguageResult.position === selection.head
    ) return cachedLanguageResult.result

    const before =
      context.matchBefore(/<[\w-]*|[A-Za-z_$][\w$./@-]*/) ??
      context.matchBefore(/[A-Za-z_$][\w$./@-]*/)
    const prefix = before?.text ?? ''
    const triggerIndex = (before?.from ?? selection.head) - 1
    const triggerChar = triggerIndex >= 0 ? content[triggerIndex] : ''
    const externalLspStructuralTrigger =
      usesWorkbenchExternalLspLanguageService(path) && [' ', '{', ',', ':'].includes(triggerChar)
    const shouldQueryLanguageService =
      context.explicit ||
      ['.', '@', '/', '<'].includes(triggerChar) ||
      externalLspStructuralTrigger ||
      prefix.length >= 1

    if (!shouldQueryLanguageService || context.aborted) return localResult || null
    if (
      pendingLanguageRequest?.content === content
      && pendingLanguageRequest.position === selection.head
    ) return localResult || null

    const generation = ++requestGeneration
    const requestPosition = selection.head
    pendingLanguageRequest = { content, position: requestPosition }
    const view = context.view
    void getWorkbenchLanguageServiceCompletions({
      ...buildWorkbenchLanguageServiceRequestBase({
        projectRoot,
        path,
        language,
        content,
        openTabs: getOpenTabs(),
      }),
      position: positionLineColumnFromState(context.state, selection.head),
    }, hostRuntime).then((lspResult) => {
      if (generation !== requestGeneration) return
      pendingLanguageRequest = null
      if (!lspResult.ok || isEmpty(lspResult.data.items)) return

      const from = localResult?.from ?? before?.from ?? requestPosition
      const to = localResult?.to ?? requestPosition
      const suppressLocalOptions = usesWorkbenchHtmlLanguageService(path)
      const localOptions = suppressLocalOptions
        ? []
        : ((localResult?.options ?? []) as Array<{
            label: string
            apply?: string
            type?: string
            detail?: string
            boost?: number
          }>)
      const result: CompletionResult = {
        from,
        to,
        validFor: /^[\w$.<>\-:]*$/,
        options: mergeWorkbenchLanguageServiceCompletions({
          path,
          localOptions,
          items: lspResult.data.items,
          from,
          to,
        }),
      }
      cachedLanguageResult = { content, position: requestPosition, result }

      if (
        view
        && view.state.doc.toString() === content
        && view.state.selection.main.head === requestPosition
      ) startCompletion(view)
    }).catch(() => {
      if (generation === requestGeneration) pendingLanguageRequest = null
    })

    // 本地项目索引的候选先同步显示；语言服务结果返回后再无闪烁地刷新同一列表。
    return localResult || null
  }
}

function createWorkbenchLanguageServiceLinter({
  projectRoot,
  path,
  language,
  getOpenTabs,
  getActivePath,
  hostRuntime,
}: {
  projectRoot: string
  path: Nullable<string>
  language: string
  getOpenTabs: GetWorkbenchOpenTabs
  getActivePath: () => Nullable<string>
  hostRuntime: WorkbenchHostRuntime
}) {
  let requestGeneration = 0

  return linter(
    async (view): Promise<Diagnostic[]> => {
      if (!path || !usesWorkbenchBuiltinLanguageService(path)) return []
      // 切换文件时旧 linter 的延迟任务仍可能返回；此时激活的已是别的文件，
      // 别把旧文件的诊断打到刚换入的文档上（否则会短暂爆红后又消失）。
      if (getActivePath() !== path) return []

      const generation = ++requestGeneration
      const result = await getWorkbenchLanguageServiceDiagnostics({
        ...buildWorkbenchLanguageServiceRequestBase({
          projectRoot,
          path,
          language,
          content: view.state.doc.toString(),
          openTabs: getOpenTabs(),
        }),
      }, hostRuntime)
      // 请求返回时若已切走当前文件，同样丢弃结果。
      if (generation !== requestGeneration || !result.ok || getActivePath() !== path) return []

      const languageServiceDiagnostics = result.data.diagnostics.filter(
        (diagnostic) => diagnostic.path === path
      )

      const codeActions = usesWorkbenchExternalSemanticLanguageService(path)
        && languageServiceDiagnostics.length > 0
        ? await getWorkbenchLanguageServiceCodeActions({
            ...buildWorkbenchLanguageServiceRequestBase({
              projectRoot,
              path,
              language,
              content: view.state.doc.toString(),
              openTabs: getOpenTabs(),
            }),
            range: enclosingDiagnosticRange(languageServiceDiagnostics),
            diagnostics: languageServiceDiagnostics,
          }, hostRuntime)
        : null
      if (generation !== requestGeneration || getActivePath() !== path) return []
      const availableActions = codeActions?.ok ? codeActions.data.actions : []
      const actionContent = view.state.doc.toString()

      return languageServiceDiagnostics
        .map((diagnostic) => {
          const mapped = mapWorkbenchDiagnosticToCodeMirror(view.state, diagnostic)
          if (!mapped) return null
          const actions = codeMirrorActionsForDiagnostic(
            actionContent,
            path,
            diagnostic,
            availableActions
          )
          return actions.length > 0 ? { ...mapped, actions } : mapped
        })
        .filter((diagnostic): diagnostic is Diagnostic => isPresent(diagnostic))
    },
    { delay: 500 }
  )
}

function enclosingDiagnosticRange(
  diagnostics: readonly WorkbenchLanguageServiceDiagnostic[]
): WorkbenchLanguageServiceDiagnostic['range'] {
  const starts = diagnostics.map((item) => [item.range.startLine, item.range.startColumn] as const)
  const ends = diagnostics.map((item) => [item.range.endLine, item.range.endColumn] as const)
  starts.sort((left, right) => left[0] - right[0] || left[1] - right[1])
  ends.sort((left, right) => right[0] - left[0] || right[1] - left[1])
  return {
    startLine: starts[0]![0],
    startColumn: starts[0]![1],
    endLine: ends[0]![0],
    endColumn: ends[0]![1],
  }
}

function codeMirrorActionsForDiagnostic(
  content: string,
  path: string,
  diagnostic: WorkbenchLanguageServiceDiagnostic,
  actions: readonly WorkbenchLanguageServiceCodeAction[]
): NonNullable<Diagnostic['actions']> {
  const diagnosticOffsets = languageServiceRangeToOffsets(content, diagnostic.range)
  if (!diagnosticOffsets) return []
  return actions.flatMap((action) => {
    if (action.changes.length !== 1 || action.changes[0]?.path !== path) return []
    const edits = action.changes[0].edits.flatMap((edit) => {
      const range = languageServiceRangeToOffsets(content, edit.range)
      return range ? [{ ...range, insert: edit.newText }] : []
    }).sort((left, right) => left.from - right.from || left.to - right.to)
    if (edits.length === 0 || edits.some((edit, index) => index > 0 && edit.from < edits[index - 1]!.to))
      return []
    if (!edits.some((edit) => edit.from <= diagnosticOffsets.to && edit.to >= diagnosticOffsets.from))
      return []
    return [{
      name: action.title,
      apply: (targetView: EditorView) => {
        if (targetView.state.doc.toString() !== content) return
        targetView.dispatch({ changes: edits.map((edit) => ({ from: edit.from, to: edit.to, insert: edit.insert })) })
      },
    }]
  })
}

function buildReadOnlyExtensions(readOnly: boolean, disabled: boolean): Extension {
  const editable = !readOnly && !disabled

  return [EditorState.readOnly.of(!editable), EditorView.editable.of(editable)]
}

function buildIndentGuideBackgroundLayers(columns: number[]): string {
  const w = INDENT_GUIDE_STROKE_PX
  const color = INDENT_GUIDE_COLOR
  return columns
    .map(
      (col) =>
        `linear-gradient(to right, transparent calc(${col}ch - ${w}px), ${color} calc(${col}ch - ${w}px), ${color} ${col}ch, transparent ${col}ch)`
    )
    .join(', ')
}

function buildIndentGuideDecorationsForViewport(
  view: EditorView,
  columnsByLine: Map<number, number[]>
): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>()

  for (const range of view.visibleRanges) {
    let line = view.state.doc.lineAt(range.from)

    while (line.from <= range.to) {
      const cols = columnsByLine.get(line.number)
      if (cols && cols.length > 0) {
        builder.add(
          line.from,
          line.from,
          Decoration.line({
            class: 'cm-workbenchIndentGuide',
            attributes: {
              style: `background-image: ${buildIndentGuideBackgroundLayers(cols)}; background-size: 100% 100%; background-repeat: no-repeat;`,
            },
          })
        )
      }

      if (line.to >= view.state.doc.length) {
        break
      }
      line = view.state.doc.line(line.number + 1)
    }
  }

  return builder.finish()
}

const workbenchIndentGuideExtension = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet

    constructor(view: EditorView) {
      this.decorations = this.buildDecorations(view)
    }

    public update(update: ViewUpdate): void {
      if (update.docChanged || update.viewportChanged) {
        this.decorations = this.buildDecorations(update.view)
      }
    }

    private buildDecorations(view: EditorView): DecorationSet {
      const firstVisible = view.visibleRanges[0]
      const lastVisible = view.visibleRanges[view.visibleRanges.length - 1]
      if (!firstVisible || !lastVisible) return Decoration.none

      const columnsByLine = buildWorkbenchIdeaIndentGuideColumnsForLineRange(
        view.state.doc,
        view.state.tabSize,
        view.state.doc.lineAt(firstVisible.from).number,
        view.state.doc.lineAt(lastVisible.to).number
      )
      return buildIndentGuideDecorationsForViewport(view, columnsByLine)
    }
  },
  {
    decorations: (plugin) => plugin.decorations,
  }
)

const WorkbenchTypeScriptEditorExtensions = new Set(['ts', 'tsx', 'mts', 'cts'])
const WorkbenchRunnableEditorExtensions = new Set([
  'ts',
  'tsx',
  'mts',
  'cts',
  'js',
  'jsx',
  'mjs',
  'cjs',
  'py',
  'pyw',
])

function editorPathExtension(path: Nullable<string>): string {
  if (!path) return ''
  const index = path.lastIndexOf('.')
  return index === -1 ? '' : path.slice(index + 1).toLowerCase()
}

function isTypeScriptEditorPath(path: Nullable<string>): boolean {
  return WorkbenchTypeScriptEditorExtensions.has(editorPathExtension(path))
}

function isRunnableEditorPath(path: Nullable<string>): boolean {
  return (
    WorkbenchRunnableEditorExtensions.has(editorPathExtension(path))
    || isWorkbenchVelarFilePath(path)
  )
}

/** 「运行」：TypeScript 走 tsx，Python 走 python3，JS 按 Node 直接执行。 */
function buildWorkbenchRunFileCommand(
  path: string,
  packageManager: PackageManagerCommand
): string {
  if (isWorkbenchVelarFilePath(path)) return buildWorkbenchVelarRunCommand(path, packageManager)
  if (isTypeScriptEditorPath(path)) return `npx tsx "${path}"`
  if (['py', 'pyw'].includes(editorPathExtension(path))) return `python3 "${path}"`
  return `node "${path}"`
}

/** 「编译」：把 TypeScript 就地编译成同目录下的 .js。 */
function buildWorkbenchCompileFileCommand(path: string): string {
  return `npx tsc "${path}" --target es2022 --module esnext`
}

/** 重命名符号时的内嵌输入浮层（替代 Electron 不支持的 window.prompt）。 */
function RenameInputPopup({
  initial,
  left,
  top,
  onSubmit,
  onCancel,
}: {
  initial: string
  left: number
  top: number
  onSubmit: (value: string) => void
  onCancel: () => void
}): ReactElement {
  const [value, setValue] = useState(initial)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [])

  return (
    <div className={styles.editorRenamePopup} style={{ left, top }}>
      <input
        ref={inputRef}
        className={styles.editorRenameInput}
        value={value}
        spellCheck={false}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            // 输入法组词期间的 Enter 是选词确认，不应提交重命名，否则中文永远打不进去。
            if (event.nativeEvent.isComposing) return
            event.preventDefault()
            onSubmit(value)
          } else if (event.key === 'Escape') {
            event.preventDefault()
            onCancel()
          }
        }}
        onBlur={onCancel}
      />
    </div>
  )
}

const COMMENT_POPUP_BOUNDARY_INSET = 8
const COMMENT_POPUP_ANCHOR_GAP = 4

function CommentInputPopup({
  left,
  anchorTop,
  anchorBottom,
  boundaryRef,
  placeholder,
  submitLabel,
  cancelLabel,
  onSubmit,
  onCancel,
}: {
  left: number
  anchorTop: number
  anchorBottom: number
  boundaryRef: RefObject<Nullable<HTMLDivElement>>
  placeholder: string
  submitLabel: string
  cancelLabel: string
  onSubmit: (value: string) => void
  onCancel: () => void
}): ReactElement {
  const [value, setValue] = useState('')
  const popupRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const [position, setPosition] = useState({
    left,
    top: anchorBottom + COMMENT_POPUP_ANCHOR_GAP,
    maxWidth: undefined as number | undefined,
    maxHeight: undefined as number | undefined,
  })

  useLayoutEffect(() => {
    const popup = popupRef.current
    const boundary = boundaryRef.current
    if (!popup || !boundary) return

    const updatePosition = (): void => {
      const boundaryRect = boundary.getBoundingClientRect()
      const popupRect = popup.getBoundingClientRect()
      const minLeft = boundaryRect.left + COMMENT_POPUP_BOUNDARY_INSET
      const minTop = boundaryRect.top + COMMENT_POPUP_BOUNDARY_INSET
      const maxWidth = Math.max(0, boundaryRect.width - COMMENT_POPUP_BOUNDARY_INSET * 2)
      const maxHeight = Math.max(0, boundaryRect.height - COMMENT_POPUP_BOUNDARY_INSET * 2)
      const fittedWidth = Math.min(popupRect.width, maxWidth)
      const fittedHeight = Math.min(popupRect.height, maxHeight)
      const maxLeft = Math.max(
        minLeft,
        boundaryRect.right - COMMENT_POPUP_BOUNDARY_INSET - fittedWidth
      )
      const maxTop = Math.max(
        minTop,
        boundaryRect.bottom - COMMENT_POPUP_BOUNDARY_INSET - fittedHeight
      )
      const belowTop = anchorBottom + COMMENT_POPUP_ANCHOR_GAP
      const aboveTop = anchorTop - COMMENT_POPUP_ANCHOR_GAP - fittedHeight
      const top =
        belowTop <= maxTop
          ? belowTop
          : aboveTop >= minTop
            ? aboveTop
            : Math.min(Math.max(belowTop, minTop), maxTop)

      setPosition({
        left: Math.min(Math.max(left, minLeft), maxLeft),
        top,
        maxWidth,
        maxHeight,
      })
    }

    updatePosition()
    const resizeObserver = new ResizeObserver(updatePosition)
    resizeObserver.observe(popup)
    resizeObserver.observe(boundary)
    window.addEventListener('resize', updatePosition)
    return () => {
      resizeObserver.disconnect()
      window.removeEventListener('resize', updatePosition)
    }
  }, [anchorBottom, anchorTop, boundaryRef, left])

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const trimmed = value.trim()

  return (
    <div ref={popupRef} className={styles.editorCommentPopup} style={position}>
      <textarea
        ref={inputRef}
        className={styles.editorCommentInput}
        value={value}
        placeholder={placeholder}
        spellCheck={false}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
            if (event.nativeEvent.isComposing) return
            event.preventDefault()
            if (trimmed) onSubmit(value)
          } else if (event.key === 'Escape') {
            event.preventDefault()
            onCancel()
          }
        }}
      />
      <div className={styles.editorCommentActions}>
        <button type="button" onMouseDown={(event) => event.preventDefault()} onClick={onCancel}>
          {cancelLabel}
        </button>
        <button
          type="button"
          data-variant="primary"
          disabled={!trimmed}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => onSubmit(value)}
        >
          {submitLabel}
        </button>
      </div>
    </div>
  )
}

export const CodeMirrorEditor = forwardRef<CodeMirrorEditorHandle, CodeMirrorEditorProps>(
  function CodeMirrorEditor(
    {
      projectRoot,
      path,
      language,
      value,
      readOnly,
      disabled,
      projectContextIndex,
      openTabs = [],
      packageManager = 'npm',
      workbenchTheme,
      onChange,
      onCursorPositionChange,
      onOpenFind,
      onOpenGoToLine,
      onGoToDefinition,
      symbolLocations = null,
      onOpenSymbolLocations,
      onCloseSymbolLocations,
      onNavigateSymbolLocation,
      onApplyLanguageServiceFileChanges,
      onRunPackageScript,
      onOpenFileHistory,
      onSave,
    },
    ref
  ): ReactElement {
    const { t } = useWorkbenchI18n()
    const hostRuntime = useWorkbenchHostRuntime()
    const commentStore = useWorkbenchCommentStore()
    const containerRef = useRef<HTMLDivElement>(null)
    const contextMenuRef = useRef<HTMLDivElement>(null)
    const viewRef = useRef<EditorView>(null)
    const definitionRequestGenerationRef = useRef(0)
    const autoFoldedPathRef = useRef<string>(null)
    const synchronizedPathRef = useRef(path)
    const pathRef = useLatest(path)
    const openTabsLatest = useLatest(openTabs)
    const projectContextIndexRef = useLatest(projectContextIndex)
    const callbacksRef = useLatest({
      onChange,
      onCursorPositionChange,
      onOpenFind,
      onOpenGoToLine,
      onGoToDefinition,
      onOpenSymbolLocations,
      onCloseSymbolLocations,
      onNavigateSymbolLocation,
      onApplyLanguageServiceFileChanges,
      onRunPackageScript,
      onOpenFileHistory,
      onSave,
    })
    const languageCompartment = useMemo(() => new Compartment(), [])
    const readOnlyCompartment = useMemo(() => new Compartment(), [])
    const completionCompartment = useMemo(() => new Compartment(), [])
    const lintCompartment = useMemo(() => new Compartment(), [])
    const packageScriptRunCompartment = useMemo(() => new Compartment(), [])
    const velarMainRunCompartment = useMemo(() => new Compartment(), [])
    const velarTestRunCompartment = useMemo(() => new Compartment(), [])
    const autocompleteThemeCompartment = useMemo(() => new Compartment(), [])
    const languageHoverCompartment = useMemo(() => new Compartment(), [])
    const languageServiceCompartment = useMemo(() => new Compartment(), [])
    const syntaxThemeCompartment = useMemo(() => new Compartment(), [])
    const editorMetricsCompartment = useMemo(() => new Compartment(), [])
    const editorMetrics = useWorkbenchEditorMetrics()
    const progressiveLoadTimers = useTimerScope('WorkbenchEditorProgressiveLoad')
    const languageSupport = useMemo(
      () => resolveWorkbenchCodeMirrorLanguage(path, language),
      [language, path]
    )
    const languageSupportRef = useLatest(languageSupport)
    const languageExtension = languageSupport.extension
    const basicLanguageExtension = useMemo(
      () => createWorkbenchBasicSyntaxExtension(languageSupport.languageId),
      [languageSupport.languageId]
    )

    const projectRootRef = useLatest(projectRoot)
    const completionModel = useStandaloneWorkbenchModelConfig().completionModel
    // 只读、禁用或补全模型为“无”时不请求内联补全；ViewPlugin 每次调用时实时读取。
    const inlineCompletionEnabledRef = useLatest(
      !!completionModel.trim() && !readOnly && !disabled
    )
    const inlineCompletionRuntime = useMemo<WorkbenchInlineCompletionRuntime>(
      () => ({
        isEnabled: () => inlineCompletionEnabledRef.current,
        request: async ({ prefix, suffix }) => {
          const result = await getWorkbenchInlineCompletion({
            projectRoot: projectRootRef.current,
            path: pathRef.current,
            language: languageSupportRef.current.languageId || 'plaintext',
            prefix,
            suffix,
          }, hostRuntime)
          return result.ok ? result.data.completion || null : null
        },
      }),
      [hostRuntime, inlineCompletionEnabledRef, languageSupportRef, pathRef, projectRootRef]
    )
    const completionSource = useMemo(
      () =>
        createWorkbenchCompletionSource({
          projectRoot,
          path,
          language,
          getOpenTabs: () => openTabsLatest.current,
          getProjectContextIndex: () => projectContextIndexRef.current,
          hostRuntime,
        }),
      [hostRuntime, language, openTabsLatest, path, projectContextIndexRef, projectRoot]
    )
    const languageServiceLinter = useMemo(
      () =>
        createWorkbenchLanguageServiceLinter({
          projectRoot,
          path,
          language,
          getOpenTabs: () => openTabsLatest.current,
          getActivePath: () => pathRef.current,
          hostRuntime,
        }),
      [hostRuntime, language, openTabsLatest, path, pathRef, projectRoot]
    )
    const packageScriptRunContent = shouldShowWorkbenchPackageScriptRunGutter(path) ? value : ''
    const packageScriptRunExtension = useMemo(
      () =>
        createWorkbenchPackageScriptRunGutterExtension({
          content: packageScriptRunContent,
          disabled: disabled || !callbacksRef.current.onRunPackageScript,
          onRunScript: (command) => callbacksRef.current.onRunPackageScript?.(command),
          packageManager,
          path: onRunPackageScript ? path : null,
        }),
      [disabled, onRunPackageScript, packageManager, packageScriptRunContent, path]
    )
    const velarTestRunContent = shouldShowWorkbenchVelarTestRunGutter(path) ? value : ''
    const velarMainRunContent = shouldShowWorkbenchVelarMainRunGutter(path) ? value : ''
    const velarMainRunExtension = useMemo(
      () =>
        createWorkbenchVelarMainRunGutterExtension({
          content: velarMainRunContent,
          disabled: disabled || !callbacksRef.current.onRunPackageScript,
          onRunMain: (command) => callbacksRef.current.onRunPackageScript?.(command),
          packageManager,
          path: onRunPackageScript ? path : null,
        }),
      [disabled, onRunPackageScript, packageManager, path, velarMainRunContent]
    )
    const velarTestRunExtension = useMemo(
      () =>
        createWorkbenchVelarTestRunGutterExtension({
          content: velarTestRunContent,
          disabled: disabled || !callbacksRef.current.onRunPackageScript,
          onRunTest: (command) => callbacksRef.current.onRunPackageScript?.(command),
          packageManager,
          path: onRunPackageScript ? path : null,
        }),
      [disabled, onRunPackageScript, packageManager, path, velarTestRunContent]
    )
    const diagnosticForegroundExtension = useMemo(
      () => createWorkbenchDiagnosticForegroundExtension(),
      []
    )
    const lintTheme = useMemo(
      () => getWorkbenchCodeMirrorLintTheme(workbenchTheme),
      [workbenchTheme]
    )
    const autocompleteTheme = useMemo(
      () => getWorkbenchCodeMirrorAutocompleteTheme(workbenchTheme),
      [workbenchTheme]
    )
    const [contextMenu, setContextMenu] = useState<Nullable<EditorContextMenuState>>(null)
    const [symbolLocationsAnchor, setSymbolLocationsAnchor] =
      useState<Nullable<WorkbenchSymbolLocationsAnchor>>(null)
    const [renamePopup, setRenamePopup] =
      useState<Nullable<{ identifier: WorkbenchIdentifierRange; left: number; top: number }>>(null)
    const [commentDraft, setCommentDraft] = useState<
      Nullable<{
        from: number
        to: number
        startLine: number
        endLine: number
        snippet: string
        left: number
        anchorTop: number
        anchorBottom: number
      }>
    >(null)
    const renamePopupRef = useLatest(renamePopup)
    const commentDraftRef = useLatest(commentDraft)

    useLayoutEffect(() => {
      const view = viewRef.current
      if (!view) return

      view.dom.classList.add('cm-workbenchMetricsRefreshing')
      view.dispatch({
        effects: editorMetricsCompartment.reconfigure(
          createWorkbenchCodeMirrorMetricsExtension(editorMetrics)
        ),
      })

      // 右键菜单没有稳定的文档锚点，缩放时直接收起；评论草稿和重命名框则保留
      // 用户输入，并在 CodeMirror 完成新字号的内部测量后重新读取其文档坐标。
      setContextMenu(null)
      view.requestMeasure({
        key: 'workbench-editor-metrics-and-overlays',
        read: (measuredView) => {
          const draft = commentDraftRef.current
          const rename = renamePopupRef.current
          const draftFrom = draft
            ? Math.min(Math.max(0, draft.from), measuredView.state.doc.length)
            : null
          const draftTo = draft
            ? Math.min(Math.max(0, draft.to), measuredView.state.doc.length)
            : null
          const draftStartCoords = draftFrom === null ? null : measuredView.coordsAtPos(draftFrom)
          const draftEndCoords = draftTo === null ? null : measuredView.coordsAtPos(draftTo)
          const renamePosition = rename
            ? Math.min(Math.max(0, rename.identifier.from), measuredView.state.doc.length)
            : null
          const renameCoords =
            renamePosition === null ? null : measuredView.coordsAtPos(renamePosition)

          return {
            comment:
              draft && (draftStartCoords || draftEndCoords)
                ? {
                    left: draftStartCoords?.left ?? draftEndCoords!.left,
                    anchorTop: draftStartCoords?.top ?? draftEndCoords!.top,
                    anchorBottom: draftEndCoords?.bottom ?? draftStartCoords!.bottom,
                  }
                : null,
            rename:
              rename && renameCoords
                ? { left: renameCoords.left, top: renameCoords.bottom + 4 }
                : null,
          }
        },
        write: (measure) => {
          if (viewRef.current !== view) return
          view.dom.classList.remove('cm-workbenchMetricsRefreshing')
          if (measure.comment) {
            setCommentDraft((current) =>
              current ? { ...current, ...measure.comment } : current
            )
          }
          if (measure.rename) {
            setRenamePopup((current) => (current ? { ...current, ...measure.rename } : current))
          }
        },
      })
    }, [
      commentDraftRef,
      editorMetrics,
      editorMetricsCompartment,
      renamePopupRef,
    ])

    const commentEditLabelRef = useLatest(t('workbench.editorCommentEdit'))
    const commentSaveLabelRef = useLatest(t('workbench.editorCommentSave'))
    const commentCancelLabelRef = useLatest(t('workbench.editorCommentCancel'))
    const commentDeleteLabelRef = useLatest(t('workbench.editorCommentDelete'))
    const workbenchCommentExtension = useMemo(
      () =>
        createWorkbenchCommentExtension({
          getComment: commentStore.get,
          onAnchorsRemoved: (ids) => ids.forEach(commentStore.remove),
          onAnchorLinesChanged: (updates) =>
            updates.forEach((update) =>
              commentStore.updateAnchor(update.id, {
                startLine: update.startLine,
                endLine: update.endLine,
              })
            ),
          onUpdateComment: commentStore.updateBody,
          onDeleteComment: commentStore.remove,
          resolveEditLabel: () => commentEditLabelRef.current,
          resolveSaveLabel: () => commentSaveLabelRef.current,
          resolveCancelLabel: () => commentCancelLabelRef.current,
          resolveDeleteLabel: () => commentDeleteLabelRef.current,
          isExternalDocReplace: (tr) => tr.annotation(externalValueSync) === true,
        }),
      [
        commentCancelLabelRef,
        commentDeleteLabelRef,
        commentEditLabelRef,
        commentSaveLabelRef,
        commentStore,
      ]
    )

    const explanationStore = useWorkbenchExplanationStore()
    const explanationLabelsRef = useLatest({
      badge: t('workbench.explanationBadge'),
      previous: t('workbench.explanationPrevious'),
      next: t('workbench.explanationNext'),
      collapse: t('workbench.explanationCollapse'),
      finish: t('workbench.explanationFinish'),
      expand: t('workbench.explanationExpand'),
    })
    const workbenchExplanationExtension = useMemo(
      () =>
        createWorkbenchExplanationExtension({
          onActivate: explanationStore.activate,
          onStep: explanationStore.step,
          onCollapse: () => explanationStore.activate(null),
          onFinish: () => explanationStore.clear(projectRootRef.current),
          resolveLabels: () => explanationLabelsRef.current,
          onAnchorsRemoved: explanationStore.removeMany,
          onAnchorLinesChanged: explanationStore.updateLines,
          isExternalDocReplace: (tr) => tr.annotation(externalValueSync) === true,
        }),
      [explanationLabelsRef, explanationStore, projectRootRef]
    )
    /** 已经把哪一次「切到某条讲解」带进过视野；切文件后补做一次。 */
    const appliedExplanationFocusRef = useRef(0)

    // 按存储行号把当前文件的讲解锚定成装饰；有新的「切到某条讲解」且它就在这个文件里时，把它滚到视野上方。
    const syncWorkbenchExplanations = (view: EditorView): void => {
      const currentPath = pathRef.current
      const snapshot = explanationStore.getSnapshot()
      const tour = explanationStore.listForProject(projectRootRef.current)
      const anchors = currentPath
        ? buildWorkbenchExplanationAnchors(view.state.doc, currentPath, tour, snapshot.activeId)
        : []
      const activeAnchor = anchors.find((anchor) => anchor.active)
      const shouldFocus =
        !!activeAnchor && snapshot.focusRevision > appliedExplanationFocusRef.current
      if (shouldFocus) appliedExplanationFocusRef.current = snapshot.focusRevision
      view.dispatch({
        effects: [
          setWorkbenchExplanationAnchorsEffect.of(anchors),
          ...(shouldFocus && activeAnchor
            ? [EditorView.scrollIntoView(activeAnchor.from, { y: 'start', yMargin: 72 })]
            : []),
        ],
      })
    }

    const openFileHistory = (mode: 'local' | 'git'): void => {
      setContextMenu(null)
      if (path) callbacksRef.current.onOpenFileHistory?.(mode)
    }

    // 按存储里的行号，把当前文件的评论重新锚定成实时块（打开文件/外部整篇替换后调用）。
    const reanchorWorkbenchComments = (view: EditorView): void => {
      const currentPath = pathRef.current
      const anchors = !currentPath
        ? []
        : commentStore.listForPath(projectRootRef.current, currentPath)
            .map((comment) =>
              anchorFromLineRange(view.state.doc, comment.id, comment.startLine, comment.endLine)
            )
            .filter(isPresent)
      view.dispatch({ effects: setWorkbenchCommentAnchorsEffect.of(anchors) })
    }

    const getDefinitionTarget = (
      word: Nullable<WorkbenchIdentifierRange>
    ): Nullable<{ path: string; line: number; column: number }> => {
      if (!word) return null

      return findWorkbenchDefinitionTarget({
        word: word.text,
        path: pathRef.current,
        projectContextIndex: projectContextIndexRef.current,
      })
    }

    const getCurrentIdentifier = (): Nullable<WorkbenchIdentifierRange> => {
      const view = viewRef.current
      if (!view) return null

      return getIdentifierAt(view.state, view.state.selection.main.head)
    }

    const languageServiceContext = useMemo(
      () => ({
        projectRoot,
        path,
        language,
        getOpenTabs: () => openTabsLatest.current,
        hostRuntime,
        hoverDefinitionLabel: t('workbench.editorHoverDefinition'),
        hoverDefinitionPreviewLabel: t('workbench.editorHoverDefinitionPreview'),
      }),
      [hostRuntime, language, openTabsLatest, path, projectRoot, t]
    )

    const semanticLanguageService = path && usesWorkbenchSemanticLanguageService(path)

    const languageServiceHoverExtension = useMemo(
      () => createWorkbenchLanguageServiceHoverTooltip(
        languageServiceContext,
        workbenchEditorLanguageFeatureClasses,
        semanticLanguageService ? undefined : (view, position) => {
          const diagnosticRange = collectDiagnosticsAtPosition(view, position)
          const word = getIdentifierAt(view.state, position)
          const target = !word
            ? null
            : findWorkbenchDefinitionTarget({
                word: word.text,
                path: pathRef.current,
                projectContextIndex: projectContextIndexRef.current,
              })
          if (!diagnosticRange && (!word || !target)) return null

          return {
            pos: diagnosticRange?.from ?? word!.from,
            end: diagnosticRange?.to ?? word!.to,
            above: true,
            create: () => ({
              dom: buildWorkbenchEditorHoverDom(
                {
                  diagnostics: diagnosticRange?.diagnostics,
                  symbolFallback:
                    word && target
                      ? {
                          word: word.text,
                          path: target.path,
                          line: target.line,
                          column: target.column,
                        }
                      : null,
                },
                workbenchEditorLanguageFeatureClasses
              ),
            }),
          }
        }
      ),
      [languageServiceContext, pathRef, projectContextIndexRef, semanticLanguageService]
    )
    const languageServiceExtensions = useMemo(() => {

      let syncedInlayHintOpenFiles: Nullable<Map<string, string>> = null

      return [
        semanticLanguageService
          ? [
              createWorkbenchSemanticTokensExtension({
                request: async (content) => {
                  const result = await getWorkbenchLanguageServiceSemanticTokens(
                    buildWorkbenchLanguageServiceRequestBase({
                      projectRoot,
                      path,
                      language,
                      content,
                      // 当前正文已经由 content 提供；这里只同步其余脏标签，避免每次输入
                      // 都把同一份大文件重复发送给语义分析 worker。
                      openTabs: openTabsLatest.current.filter((tab) => tab.path !== path),
                    }),
                    hostRuntime
                  )
                  return result.ok && result.data.path === path ? result.data.tokens : null
                },
              }),
              getWorkbenchSemanticTokenTheme(workbenchTheme),
            ]
          : [],
        createWorkbenchTokenOccurrenceHighlightExtension(
          path && usesWorkbenchSemanticLanguageService(path)
            ? {
                request: async (content, position) => {
                  const result = await getWorkbenchLanguageServiceDocumentHighlights({
                    ...buildWorkbenchLanguageServiceRequestBase({
                      projectRoot,
                      path,
                      language,
                      content,
                      openTabs: openTabsLatest.current,
                    }),
                    position,
                  }, hostRuntime)
                  return result.ok && result.data.path === path ? result.data.highlights : null
                },
              }
            : null
        ),
        createWorkbenchSignatureHelpExtension(
          languageServiceContext,
          workbenchEditorLanguageFeatureClasses
        ),
        createWorkbenchInlayHintExtension({
          cacheKey: `${projectRoot}\u0000${path ?? ''}`,
          request: async (content, ranges) => {
            if (!path || !usesWorkbenchInlayHintLanguageService(path)) return []

            const currentOpenTabs = openTabsLatest.current
            const siblingOpenTabs = currentOpenTabs.filter((tab) => tab.path !== path)
            const syncOpenFiles =
              !syncedInlayHintOpenFiles ||
              syncedInlayHintOpenFiles.size !== siblingOpenTabs.length ||
              siblingOpenTabs.some(
                (tab) => syncedInlayHintOpenFiles?.get(tab.path) !== tab.content
              )
            if (syncOpenFiles) {
              syncedInlayHintOpenFiles = new Map(
                siblingOpenTabs.map((tab) => [tab.path, tab.content])
              )
            }
            const request = buildWorkbenchLanguageServiceRequestBase({
              projectRoot,
              path,
              language,
              content,
              openTabs: syncOpenFiles ? siblingOpenTabs : [],
            })
            if (!syncOpenFiles) delete request.openFiles

            const result = await getWorkbenchLanguageServiceInlayHints({
              ...request,
              ranges: [...ranges],
              syncOpenFiles,
            }, hostRuntime)

            return result.ok && result.data.path === path ? result.data.hints : []
          },
        }),
      ]
    }, [
      hostRuntime,
      language,
      languageServiceContext,
      openTabsLatest,
      path,
      projectRoot,
      semanticLanguageService,
      workbenchTheme,
    ])

    const runCurrentFile = (): void => {
      const currentPath = pathRef.current
      const runScript = callbacksRef.current.onRunPackageScript
      if (!currentPath || !runScript) return

      setContextMenu(null)
      runScript(buildWorkbenchRunFileCommand(currentPath, packageManager))
    }

    const buildCurrentFile = (): void => {
      const currentPath = pathRef.current
      const runScript = callbacksRef.current.onRunPackageScript
      if (!currentPath || !runScript) return

      setContextMenu(null)
      if (isWorkbenchVelarFilePath(currentPath)) {
        runScript(buildWorkbenchVelarBuildCommand(currentPath, packageManager))
      } else if (isTypeScriptEditorPath(currentPath)) {
        runScript(buildWorkbenchCompileFileCommand(currentPath))
      }
    }

    // 评论只对选中的块生效：打开输入浮层收集正文，确认后落成锚定评论。
    const startCommentForSelection = (): void => {
      const view = viewRef.current
      const currentPath = pathRef.current
      if (!view || !currentPath) return

      const selection = view.state.selection.main
      if (selection.from === selection.to) return

      const doc = view.state.doc
      const startCoords = view.coordsAtPos(selection.from)
      const endCoords = view.coordsAtPos(selection.to)
      setContextMenu(null)
      setCommentDraft({
        from: selection.from,
        to: selection.to,
        startLine: doc.lineAt(selection.from).number,
        endLine: doc.lineAt(selection.to).number,
        snippet: view.state.sliceDoc(selection.from, selection.to),
        // 横向对齐选区起点，避免长选区的评论框贴着最后一个字符偏到右侧。
        left: startCoords?.left ?? endCoords?.left ?? 120,
        anchorTop: startCoords?.top ?? endCoords?.top ?? 120,
        anchorBottom: endCoords?.bottom ?? startCoords?.bottom ?? 120,
      })
    }

    const commitComment = (rawBody: string): void => {
      const draft = commentDraft
      setCommentDraft(null)
      const view = viewRef.current
      const currentPath = pathRef.current
      const body = rawBody.trim()
      if (!draft || !view || !currentPath || !body) return

      const comment = commentStore.add({
        projectRoot,
        path: currentPath,
        startLine: draft.startLine,
        endLine: draft.endLine,
        snippet: draft.snippet,
        body,
        language: languageSupportRef.current.languageId || 'text',
      })
      view.dispatch({
        effects: addWorkbenchCommentAnchorEffect.of({
          id: comment.id,
          from: draft.from,
          to: draft.to,
        }),
      })
      view.focus()
    }

    const goToDefinitionForWord = async (
      word: Nullable<WorkbenchIdentifierRange>
    ): Promise<void> => {
      const view = viewRef.current
      const identifier = word ?? getCurrentIdentifier()

      if (view && pathRef.current && identifier) {
        const requestGeneration = ++definitionRequestGenerationRef.current
        try {
          const currentPath = pathRef.current
          const sourceDocument = view.state.doc
          const position = positionLineColumnFromState(view.state, identifier.from)
          const origin = {
            path: currentPath,
            line: position.line,
            column: position.column,
          }
          const request = {
            ...buildWorkbenchLanguageServiceRequestBase({
              projectRoot,
              path: currentPath,
              language,
              content: view.state.doc.toString(),
              openTabs: openTabsLatest.current,
            }),
            position,
          }
          const definitionResult = await getWorkbenchLanguageServiceDefinition(request, hostRuntime)
          if (
            requestGeneration !== definitionRequestGenerationRef.current
            || viewRef.current !== view
            || view.state.doc !== sourceDocument
            || pathRef.current !== currentPath
          ) return
          const definitions = definitionResult.ok ? definitionResult.data.locations : []
          const location = definitions[0]
          if (location) {
            setContextMenu(null)
            view.dispatch({ effects: closeHoverTooltips })
            const isDefinition = definitions.some((definition) =>
              sameWorkbenchSymbolLocation(origin, definition)
            )
            callbacksRef.current.onOpenSymbolLocations?.(buildWorkbenchSymbolLocationsRequest({
              symbol: identifier.text,
              origin,
              ...(isDefinition ? {} : { destination: location }),
              definitions,
              references: [],
            }), isDefinition)

            if (!isDefinition)
              callbacksRef.current.onGoToDefinition(location.path, location.line, location.column)

            // Definition navigation must not wait for a project-wide reference scan. Fill the
            // panel in after the jump/open has happened, while rejecting results for an edited,
            // replaced, or superseded source document.
            void getWorkbenchLanguageServiceReferences(request, hostRuntime).then((referencesResult) => {
              if (
                !referencesResult.ok
                || requestGeneration !== definitionRequestGenerationRef.current
                || viewRef.current !== view
                || view.state.doc !== sourceDocument
                || pathRef.current !== currentPath
              ) return
              callbacksRef.current.onOpenSymbolLocations?.(buildWorkbenchSymbolLocationsRequest({
                symbol: identifier.text,
                origin,
                ...(isDefinition ? {} : { destination: location }),
                definitions,
                references: referencesResult.data.locations,
              }))
            }).catch((error) => {
              if (requestGeneration !== definitionRequestGenerationRef.current) return
              log.debug('查询语言服务引用失败，保留定义跳转结果', {
                projectRoot,
                path: currentPath,
                language,
                error,
              })
            })
            return
          }
        } catch (error) {
          if (requestGeneration !== definitionRequestGenerationRef.current) return
          log.debug('查询语言服务定义失败，回退到索引', {
            projectRoot,
            path: pathRef.current,
            language,
            error,
          })
          // Fall back to the lightweight project index below.
        }
      }

      const target = getDefinitionTarget(identifier)
      if (!target) return

      setContextMenu(null)
      callbacksRef.current.onGoToDefinition(target.path, target.line, target.column)
    }

    const renameIdentifier = (word: Nullable<WorkbenchIdentifierRange>): void => {
      const view = viewRef.current
      const identifier = word ?? getCurrentIdentifier()
      if (!view || !identifier || view.state.facet(EditorState.readOnly)) return

      // Electron 禁用了 window.prompt，改用内嵌输入浮层收集新名字。
      setContextMenu(null)
      const coords = view.coordsAtPos(identifier.from)
      setRenamePopup({
        identifier,
        left: coords?.left ?? 120,
        top: (coords?.bottom ?? 120) + 4,
      })
    }

    const commitRename = async (
      identifier: WorkbenchIdentifierRange,
      rawName: string
    ): Promise<void> => {
      const view = viewRef.current
      setRenamePopup(null)
      if (!view || view.state.facet(EditorState.readOnly)) return

      const nextName = rawName.trim()
      const semanticRename = usesWorkbenchSemanticLanguageService(pathRef.current)
      // 允许 Unicode 标识符（JS/TS 合法，含中文），仅排除以数字开头/含空白等非法名。
      if (
        !nextName ||
        nextName === identifier.text ||
        !/^[\p{L}\p{Nl}_$][\p{L}\p{Nl}\p{Mn}\p{Mc}\p{Nd}\p{Pc}$]*$/u.test(nextName)
      )
        return

      if (pathRef.current) {
        try {
          const result = await getWorkbenchLanguageServiceRename({
            ...buildWorkbenchLanguageServiceRequestBase({
              projectRoot,
              path: pathRef.current,
              language,
              content: view.state.doc.toString(),
              openTabs: openTabsLatest.current,
            }),
            position: positionLineColumnFromState(view.state, identifier.from),
            newName: nextName,
          }, hostRuntime)
          if (result.ok && !isEmpty(result.data.changes)) {
            const currentFileChange = pathRef.current
              ? result.data.changes.find((change) => change.path === pathRef.current)
              : null
            const currentFileEdits = currentFileChange?.edits ?? []
            const otherFileChanges = result.data.changes.filter(
              (change) => change.path !== pathRef.current && !isEmpty(change.edits)
            )

            if (!isEmpty(otherFileChanges)) {
              callbacksRef.current.onApplyLanguageServiceFileChanges?.(otherFileChanges)
            }

            if (!isEmpty(currentFileEdits)) {
              const changes = currentFileEdits
                .map((edit) => languageServiceEditToCodeMirrorChange(view.state, edit))
                .sort((a, b) => b.from - a.from)
              setContextMenu(null)
              view.dispatch({
                changes,
                selection: { anchor: identifier.from + nextName.length },
              })
              view.focus()
              return
            }

            if (!isEmpty(otherFileChanges)) {
              setContextMenu(null)
              view.focus()
              return
            }
          }
          if (semanticRename) return
        } catch (error) {
          log.debug('查询语言服务重命名失败，回退到本地重命名', {
            projectRoot,
            path: pathRef.current,
            language,
            error,
          })
          if (semanticRename) return
        }
      }

      const changes = buildIdentifierRenameChanges(
        view.state.doc.toString(),
        identifier.text,
        nextName
      )
      if (isEmpty(changes)) return

      setContextMenu(null)
      view.dispatch({
        changes,
        selection: { anchor: identifier.from + nextName.length },
      })
      view.focus()
    }

    const selectAllOccurrences = (word: Nullable<WorkbenchIdentifierRange>): void => {
      const view = viewRef.current
      const identifier = word ?? getCurrentIdentifier()
      if (!view || !identifier) return

      const ranges = buildIdentifierSelectionRanges(view.state.doc.toString(), identifier.text)
      if (isEmpty(ranges)) return

      setContextMenu(null)
      view.dispatch({
        selection: EditorSelection.create(ranges),
        effects: EditorView.scrollIntoView(identifier.from, { y: 'center', x: 'nearest' }),
      })
      view.focus()
    }

    const selectReferenceOccurrences = async (
      word: Nullable<WorkbenchIdentifierRange>
    ): Promise<void> => {
      const view = viewRef.current
      const identifier = word ?? getCurrentIdentifier()
      if (!view || !identifier) return

      const references = await findWorkbenchLanguageServiceReferences({
        view,
        context: {
          projectRoot,
          path,
          language,
          getOpenTabs: () => openTabsLatest.current,
          hostRuntime,
        },
        position: identifier.from,
      })
      const currentFileReferences = references.filter(
        (location) => location.path === pathRef.current && location.range
      )

      if (!isEmpty(currentFileReferences)) {
        const content = view.state.doc.toString()
        const ranges = currentFileReferences
          .map((location) =>
            location.range ? languageServiceRangeToOffsets(content, location.range) : null
          )
          .filter((range): range is NonNullable<typeof range> => isPresent(range))
          .map((range) => EditorSelection.range(range.from, range.to))

        if (!isEmpty(ranges)) {
          setContextMenu(null)
          view.dispatch({
            selection: EditorSelection.create(ranges),
            effects: EditorView.scrollIntoView(identifier.from, { y: 'center', x: 'nearest' }),
          })
          view.focus()
          return
        }
      }

      if (!usesWorkbenchSemanticLanguageService(pathRef.current)) selectAllOccurrences(word)
    }

    const formatDocument = async (): Promise<void> => {
      // 无论是否有可格式化改动，点击都要关闭右键菜单（用户反馈「点了没反应」的主因之一）。
      setContextMenu(null)
      const view = viewRef.current
      if (!view || view.state.facet(EditorState.readOnly) || !pathRef.current) return

      // 后端统一按「项目 Prettier 优先 / 内置规则回退」返回整篇格式化编辑，前端只负责应用。
      const content = view.state.doc.toString()
      try {
        const result = await getWorkbenchLanguageServiceFormat({
          ...buildWorkbenchLanguageServiceRequestBase({
            projectRoot,
            path: pathRef.current,
            language,
            content,
            openTabs: openTabsLatest.current,
          }),
        }, hostRuntime)
        const currentFileChange =
          result.ok && pathRef.current
            ? result.data.changes.find((change) => change.path === pathRef.current)
            : null
        if (!currentFileChange || isEmpty(currentFileChange.edits)) return

        const nextContent = applyWorkbenchLanguageServiceEditsToContent(
          content,
          currentFileChange.edits
        )
        // 语言服务的内容可能已滞后于最新编辑；从当前实时文档重新取一次基准再比对。
        const liveContent = view.state.doc.toString()
        if (nextContent === liveContent) return

        view.dispatch({
          changes: { from: 0, to: view.state.doc.length, insert: nextContent },
        })
        view.focus()
      } catch (error) {
        log.debug('格式化文档失败', {
          projectRoot,
          path: pathRef.current,
          language,
          error,
        })
      }
    }

    const openEditorContextMenu = (event: ReactMouseEvent<HTMLDivElement>): void => {
      const view = viewRef.current
      if (!view) return

      event.preventDefault()
      const position = view.posAtCoords({ x: event.clientX, y: event.clientY })
      const word = !isPresent(position) ? null : getIdentifierAt(view.state, position)
      const x = Math.min(event.clientX, window.innerWidth - 188)
      const y = Math.min(event.clientY, window.innerHeight - 344)
      const selection = view.state.selection.main
      setContextMenu({
        x: Math.max(8, x),
        y: Math.max(8, y),
        word,
        canGoToDefinition: isPresent(word) || isPresent(getDefinitionTarget(word)),
        hasSelection: selection.from !== selection.to,
      })
    }

    useDismissOnWindowInteract({
      enabled: isPresent(contextMenu),
      onDismiss: () => setContextMenu(null),
      ignoreMouseDown: (event) =>
        event.target instanceof Node && !!contextMenuRef.current?.contains(event.target),
    })
    useBlockWheelScroll(contextMenuRef, isPresent(contextMenu))
    useImperativeHandle(ref, () => ({
      focus: () => {
        viewRef.current?.focus()
      },
      moveToLine: (line, column = 1, options) => {
        const view = viewRef.current
        if (!view) return

        const targetLine = view.state.doc.line(Math.min(Math.max(1, line), view.state.doc.lines))
        const targetPosition = clampPosition(
          targetLine.from + Math.max(0, column - 1),
          targetLine.to
        )

        view.dispatch({
          selection: { anchor: targetPosition },
          effects: EditorView.scrollIntoView(targetPosition, { y: 'center', x: 'nearest' }),
        })
        revealWorkbenchActiveLine(view)
        if (options?.focus !== false) view.focus()
        emitCursorPosition(view, callbacksRef.current.onCursorPositionChange)
      },
      selectLines: (startLine, endLine, options) => {
        const view = viewRef.current
        if (!view) return

        const lines = view.state.doc.lines
        const first = view.state.doc.line(Math.min(Math.max(1, startLine), lines))
        const last = view.state.doc.line(Math.min(Math.max(first.number, endLine), lines))
        view.dispatch({
          selection: { anchor: first.from, head: last.to },
          effects: EditorView.scrollIntoView(first.from, { y: 'center', x: 'nearest' }),
        })
        revealWorkbenchActiveLine(view)
        if (options?.focus !== false) view.focus()
        emitCursorPosition(view, callbacksRef.current.onCursorPositionChange)
      },
      openCompletion: () => {
        const view = viewRef.current
        if (!view) return

        view.focus()
        startCompletion(view)
      },
      selectRange: (from, to) => {
        const view = viewRef.current
        if (!view) return

        const start = clampPosition(from, view.state.doc.length)
        const end = clampPosition(to, view.state.doc.length)
        view.dispatch({
          selection: { anchor: start, head: end },
          effects: EditorView.scrollIntoView(start, { y: 'center', x: 'nearest' }),
        })
        revealWorkbenchActiveLine(view)
        view.focus()
        emitCursorPosition(view, callbacksRef.current.onCursorPositionChange)
      },
    }))

    useEffect(() => {
      const container = containerRef.current
      if (!container || viewRef.current) return

      const updateListener = EditorView.updateListener.of((update: ViewUpdate) => {
        if (update.docChanged) {
          const isExternalSync = update.transactions.some((transaction) =>
            transaction.annotation(externalValueSync)
          )
          if (!isExternalSync) {
            callbacksRef.current.onChange(update.state.doc.toString())
          }
        }

        if (update.selectionSet || update.docChanged) {
          emitCursorPosition(update.view, callbacksRef.current.onCursorPositionChange)
        }
      })

      const customKeymap = keymap.of([
        {
          key: 'Mod-Space',
          preventDefault: true,
          run: (view) => {
            startCompletion(view)
            return true
          },
        },
        {
          key: 'F12',
          preventDefault: true,
          run: () => {
            void goToDefinitionForWord(getCurrentIdentifier())
            return true
          },
        },
        {
          key: 'Shift-F6',
          preventDefault: true,
          run: () => {
            renameIdentifier(getCurrentIdentifier())
            return true
          },
        },
        {
          key: 'Shift-F12',
          preventDefault: true,
          run: () => {
            void selectReferenceOccurrences(getCurrentIdentifier())
            return true
          },
        },
        {
          key: 'Mod-d',
          preventDefault: true,
          run: (view) => {
            selectNextOccurrence(view)
            return true
          },
        },
        {
          key: 'Mod-/',
          preventDefault: true,
          run: (view) => toggleComment(view),
        },
        {
          key: 'Mod-Alt-l',
          preventDefault: true,
          run: () => {
            void formatDocument()
            return true
          },
        },
        {
          key: 'Mod-]',
          preventDefault: true,
          run: (view) => indentMore(view),
        },
        {
          key: 'Mod-[',
          preventDefault: true,
          run: (view) => indentLess(view),
        },
        {
          key: 'Mod-s',
          preventDefault: true,
          run: () => {
            callbacksRef.current.onSave()
            return true
          },
        },
        {
          key: 'Mod-f',
          preventDefault: true,
          run: () => {
            callbacksRef.current.onOpenFind()
            return true
          },
        },
        {
          key: 'Mod-g',
          preventDefault: true,
          run: () => {
            callbacksRef.current.onOpenGoToLine()
            return true
          },
        },
        {
          key: 'Mod-l',
          preventDefault: true,
          run: () => {
            callbacksRef.current.onOpenGoToLine()
            return true
          },
        },
        indentWithTab,
      ])

      let activeDefinitionHoverRange: Nullable<WorkbenchDefinitionHoverRange> = null
      let lastDefinitionHoverCoords: Nullable<{ x: number; y: number }> = null
      const setDefinitionHoverRange = (
        view: EditorView,
        range: Nullable<WorkbenchDefinitionHoverRange>
      ): void => {
        if (
          activeDefinitionHoverRange?.from === range?.from &&
          activeDefinitionHoverRange?.to === range?.to
        )
          return

        activeDefinitionHoverRange = range
        view.dispatch({ effects: setWorkbenchDefinitionHoverRange.of(range) })
      }
      const updateDefinitionHoverFromCoords = (
        view: EditorView,
        coords: Nullable<{ x: number; y: number }>,
        isModifierActive: boolean
      ): void => {
        if (!isModifierActive || !coords) {
          setDefinitionHoverRange(view, null)
          return
        }

        const position = view.posAtCoords(coords)
        const word = !isPresent(position) ? null : getIdentifierAt(view.state, position)
        setDefinitionHoverRange(view, word ? { from: word.from, to: word.to } : null)
      }

      const mouseHandlers = EditorView.domEventHandlers({
        mousemove: (event, view) => {
          lastDefinitionHoverCoords = { x: event.clientX, y: event.clientY }
          updateDefinitionHoverFromCoords(
            view,
            lastDefinitionHoverCoords,
            event.metaKey || event.ctrlKey
          )
          return false
        },
        mouseleave: (_event, view) => {
          lastDefinitionHoverCoords = null
          setDefinitionHoverRange(view, null)
          return false
        },
        keydown: (event, view) => {
          updateDefinitionHoverFromCoords(
            view,
            lastDefinitionHoverCoords,
            event.metaKey || event.ctrlKey
          )
          return false
        },
        keyup: (event, view) => {
          if (!event.metaKey && !event.ctrlKey) {
            setDefinitionHoverRange(view, null)
          }
          return false
        },
        blur: (_event, view) => {
          setDefinitionHoverRange(view, null)
          return false
        },
        mousedown: (event, view) => {
          if (event.button !== 0 || (!event.metaKey && !event.ctrlKey)) return false

          const position = view.posAtCoords({ x: event.clientX, y: event.clientY })
          const word = !isPresent(position) ? null : getIdentifierAt(view.state, position)
          if (!word) return false

          event.preventDefault()
          void goToDefinitionForWord(word)
          return true
        },
      })

      const state = EditorState.create({
        doc: value,
        extensions: [
          customKeymap,
          ...workbenchCodeMirrorBaseExtensions,
          tooltips({
            parent: toOptional(container),
            // The container clips with overflow:hidden, but CodeMirror defaults its
            // available space to the whole window and lets tooltips grow rightward off
            // the pane. Constrain the space to the editor rect so tooltips near the
            // right edge shift left to stay inside instead of being clipped.
            tooltipSpace: () => {
              const rect = container.getBoundingClientRect()
              const margin = 8
              return {
                top: rect.top + margin,
                left: rect.left + margin,
                bottom: rect.bottom - margin,
                right: rect.right - margin,
              }
            },
          }),
          editorMetricsCompartment.of(createWorkbenchCodeMirrorMetricsExtension(editorMetrics)),
          syntaxThemeCompartment.of(getWorkbenchCodeMirrorTheme(workbenchTheme)),
          autocompleteThemeCompartment.of(autocompleteTheme),
          indentUnit.of('  '),
          EditorState.tabSize.of(2),
          workbenchIndentGuideExtension,
          workbenchCommentExtension,
          workbenchExplanationExtension,
          mouseHandlers,
          languageHoverCompartment.of(languageServiceHoverExtension),
          languageServiceCompartment.of([]),
          packageScriptRunCompartment.of(packageScriptRunExtension),
          velarMainRunCompartment.of(velarMainRunExtension),
          velarTestRunCompartment.of(velarTestRunExtension),
          updateListener,
          languageCompartment.of(basicLanguageExtension),
          readOnlyCompartment.of(buildReadOnlyExtensions(readOnly, disabled)),
          completionCompartment.of(
            EditorState.languageData.of(() => [{ autocomplete: completionSource }])
          ),
          // linter 自身已有请求防抖，挂载扩展不会同步启动语言服务。这里必须立即挂载，
          // 否则繁忙项目拿不到 idle 时隙时，错误下划线和悬浮提示会永久缺席。
          lintCompartment.of([
            languageServiceLinter,
            lintTheme,
            diagnosticForegroundExtension,
          ]),
          workbenchInlineCompletionExtension(inlineCompletionRuntime),
          workbenchEditorChromeTheme,
        ],
      })
      const view = new EditorView({
        state,
        parent: container,
      })

      viewRef.current = view
      reanchorWorkbenchComments(view)
      syncWorkbenchExplanations(view)
      emitCursorPosition(view, callbacksRef.current.onCursorPositionChange)
      if (path) {
        autoFoldedPathRef.current = path
        foldImportBlock(view)
      }

      return () => {
        view.destroy()
        viewRef.current = null
      }
    }, [])

    useLayoutEffect(() => {
      const view = viewRef.current
      const container = containerRef.current
      const location = symbolLocations?.activeLocation
      const currentPath = path?.replaceAll('\\', '/').replace(/^\.\//u, '')
      const locationPath = location?.path.replaceAll('\\', '/').replace(/^\.\//u, '')
      const pathMatches = !!currentPath && !!locationPath && (
        currentPath === locationPath
        || currentPath.endsWith(`/${locationPath}`)
        || locationPath.endsWith(`/${currentPath}`)
      )
      if (!view || !container || !location || !pathMatches) {
        setSymbolLocationsAnchor(null)
        return undefined
      }

      const updateAnchor = (): void => {
        const currentView = viewRef.current
        const currentContainer = containerRef.current
        if (!currentView || !currentContainer) return
        const line = currentView.state.doc.line(
          Math.min(Math.max(1, location.line), currentView.state.doc.lines)
        )
        const position = clampPosition(line.from + Math.max(0, location.column - 1), line.to)
        const coords = currentView.coordsAtPos(position)
        if (!coords) {
          setSymbolLocationsAnchor(null)
          return
        }

        const boundary = currentContainer.getBoundingClientRect()
        const nextAnchor = {
          left: coords.left - boundary.left,
          top: coords.top - boundary.top,
          bottom: coords.bottom - boundary.top,
        }
        setSymbolLocationsAnchor((current) =>
          current
          && current.left === nextAnchor.left
          && current.top === nextAnchor.top
          && current.bottom === nextAnchor.bottom
            ? current
            : nextAnchor
        )
      }

      updateAnchor()
      const animationFrame = window.requestAnimationFrame(updateAnchor)
      const resizeObserver = new ResizeObserver(updateAnchor)
      resizeObserver.observe(container)
      view.scrollDOM.addEventListener('scroll', updateAnchor, { passive: true })
      window.addEventListener('resize', updateAnchor)
      return () => {
        window.cancelAnimationFrame(animationFrame)
        resizeObserver.disconnect()
        view.scrollDOM.removeEventListener('scroll', updateAnchor)
        window.removeEventListener('resize', updateAnchor)
      }
    }, [path, symbolLocations, value])

    useEffect(() => {
      viewRef.current?.dispatch({
        effects: languageHoverCompartment.reconfigure(languageServiceHoverExtension),
      })
    }, [languageHoverCompartment, languageServiceHoverExtension])

    useEffect(() => {
      const view = viewRef.current
      if (!view) return

      const fileChanged = synchronizedPathRef.current !== path
      synchronizedPathRef.current = path
      const currentValue = view.state.doc.toString()
      if (currentValue === value && !fileChanged) return

      view.dispatch(
        buildWorkbenchExternalValueSyncTransaction({
          state: view.state,
          value,
          selection: resolveWorkbenchExternalValueSyncSelection(
            view.state,
            value.length,
            fileChanged
          ),
          annotations: externalValueSync.of(true),
        })
      )
      if (fileChanged) {
        suppressWorkbenchActiveLine(view)
        setContextMenu(null)
        setRenamePopup(null)
        setCommentDraft(null)
        view.scrollDOM.scrollTo({ left: 0, top: 0 })
      }
      // 外部整篇替换会清空评论锚点，按存储行号重新锚定当前文件的评论（讲解同理）。
      reanchorWorkbenchComments(view)
      syncWorkbenchExplanations(view)
      emitCursorPosition(view, callbacksRef.current.onCursorPositionChange)
    }, [path, value])

    // 讲解加了、换了、切到下一条：重新锚定，必要时把当前讲解带进视野。
    const workbenchExplanations = useWorkbenchExplanations()
    useEffect(() => {
      const view = viewRef.current
      if (view) syncWorkbenchExplanations(view)
    }, [workbenchExplanations])

    // 存储侧评论被删除/消费时，回收对应的编辑器锚点装饰。
    const workbenchComments = useWorkbenchComments(projectRoot)
    useEffect(() => {
      const view = viewRef.current
      const currentPath = pathRef.current
      if (!view || !currentPath) return

      const desired = new Set(
        workbenchComments
          .filter((comment) => comment.path === currentPath)
          .map((comment) => comment.id)
      )
      view.dispatch({ effects: retainWorkbenchCommentAnchorsEffect.of(desired) })
    }, [workbenchComments, pathRef])

    useEffect(() => {
      viewRef.current?.dispatch({
        effects: readOnlyCompartment.reconfigure(buildReadOnlyExtensions(readOnly, disabled)),
      })
    }, [disabled, readOnly, readOnlyCompartment])

    useEffect(() => {
      viewRef.current?.dispatch({
        effects: completionCompartment.reconfigure(
          EditorState.languageData.of(() => [{ autocomplete: completionSource }])
        ),
      })
    }, [completionCompartment, completionSource])

    useEffect(() => {
      viewRef.current?.dispatch({
        effects: lintCompartment.reconfigure([
          languageServiceLinter,
          lintTheme,
          diagnosticForegroundExtension,
        ]),
      })
    }, [diagnosticForegroundExtension, languageServiceLinter, lintCompartment, lintTheme])

    useEffect(() => {
      const view = viewRef.current
      if (!view) return

      view.dispatch({
        effects: [
          languageCompartment.reconfigure(basicLanguageExtension),
          languageServiceCompartment.reconfigure([]),
        ],
      })

      let cancelSyntaxIdle = (): void => undefined
      let cancelSemanticIdle = (): void => undefined
      const syntaxLease = progressiveLoadTimers.after(
        FullSyntaxActivationDelayMs,
        () => {
          if (viewRef.current !== view) return
          cancelSyntaxIdle = requestWorkbenchEditorIdleTask(() => {
            if (viewRef.current !== view) return
            view.dispatch({ effects: languageCompartment.reconfigure(languageExtension) })
          })
        },
        { label: 'workbench.editor.activateFullSyntax' }
      )
      const semanticLease = progressiveLoadTimers.after(
        SemanticFeaturesActivationDelayMs,
        () => {
          if (viewRef.current !== view) return
          cancelSemanticIdle = requestWorkbenchEditorIdleTask(() => {
            if (viewRef.current !== view) return
            view.dispatch({
              effects: [
                languageServiceCompartment.reconfigure(languageServiceExtensions),
              ],
            })
          })
        },
        { label: 'workbench.editor.activateSemanticFeatures' }
      )

      return () => {
        syntaxLease.cancel()
        semanticLease.cancel()
        cancelSyntaxIdle()
        cancelSemanticIdle()
      }
    }, [
      basicLanguageExtension,
      languageCompartment,
      languageExtension,
      languageServiceCompartment,
      languageServiceExtensions,
      progressiveLoadTimers,
    ])

    useEffect(() => {
      viewRef.current?.dispatch({
        effects: packageScriptRunCompartment.reconfigure(packageScriptRunExtension),
      })
    }, [packageScriptRunCompartment, packageScriptRunExtension])

    useEffect(() => {
      viewRef.current?.dispatch({
        effects: velarMainRunCompartment.reconfigure(velarMainRunExtension),
      })
    }, [velarMainRunCompartment, velarMainRunExtension])

    useEffect(() => {
      viewRef.current?.dispatch({
        effects: velarTestRunCompartment.reconfigure(velarTestRunExtension),
      })
    }, [velarTestRunCompartment, velarTestRunExtension])

    useEffect(() => {
      viewRef.current?.dispatch({
        effects: syntaxThemeCompartment.reconfigure(getWorkbenchCodeMirrorTheme(workbenchTheme)),
      })
    }, [syntaxThemeCompartment, workbenchTheme])

    useEffect(() => {
      viewRef.current?.dispatch({
        effects: autocompleteThemeCompartment.reconfigure(autocompleteTheme),
      })
    }, [autocompleteTheme, autocompleteThemeCompartment])

    useEffect(() => {
      const view = viewRef.current
      if (!view || !path || autoFoldedPathRef.current === path) return

      autoFoldedPathRef.current = path
      foldImportBlock(view)
    }, [path, value])

    return (
      <>
        <div
          ref={containerRef}
          className={styles.codeMirrorEditor}
          data-language-support={languageSupport.mode}
          onContextMenu={openEditorContextMenu}
        />
        {!!(
          containerRef.current
          && symbolLocations
          && symbolLocationsAnchor
          && onCloseSymbolLocations
          && onNavigateSymbolLocation
        ) && createPortal(
          <EditorSymbolLocationsPanel
            anchor={symbolLocationsAnchor}
            boundaryRef={containerRef}
            projectRoot={projectRoot}
            state={symbolLocations}
            onClose={onCloseSymbolLocations}
            onNavigate={onNavigateSymbolLocation}
          />,
          containerRef.current
        )}
        {!!contextMenu && (
          <div
            ref={contextMenuRef}
            className={styles.editorContextMenu}
            style={{ left: contextMenu.x, top: contextMenu.y }}
            role="menu"
          >
            <button
              type="button"
              role="menuitem"
              disabled={!contextMenu.word || readOnly || disabled}
              onClick={() => renameIdentifier(contextMenu.word)}
            >
              {t('workbench.editorContextRenameSymbol')}
            </button>
            <button
              type="button"
              role="menuitem"
              disabled={!contextMenu.canGoToDefinition}
              onClick={() => void goToDefinitionForWord(contextMenu.word)}
            >
              {t('workbench.editorContextGoToDefinition')}
            </button>
            <div className={styles.editorContextMenuDivider} />
            <button
              type="button"
              role="menuitem"
              disabled={!path}
              onClick={() => openFileHistory('local')}
            >
              {t('workbench.editorContextLocalHistory')}
            </button>
            <button
              type="button"
              role="menuitem"
              disabled={!path}
              onClick={() => openFileHistory('git')}
            >
              {t('workbench.editorContextGitHistory')}
            </button>
            <button
              type="button"
              role="menuitem"
              disabled={readOnly || disabled}
              onClick={() => void formatDocument()}
            >
              {t('workbench.editorContextFormatDocument')}
            </button>
            {isRunnableEditorPath(path) && (
              <button
                type="button"
                role="menuitem"
                disabled={!path || !onRunPackageScript}
                onClick={runCurrentFile}
              >
                <PlayIcon
                  size={14}
                  weight="regular"
                  className={styles.editorContextActionIcon}
                  aria-hidden="true"
                />
                {t('workbench.editorContextRun')}
              </button>
            )}
            {(isTypeScriptEditorPath(path) || isWorkbenchVelarFilePath(path)) && (
              <button
                type="button"
                role="menuitem"
                disabled={!path || !onRunPackageScript}
                onClick={buildCurrentFile}
              >
                <HammerIcon
                  size={14}
                  weight="regular"
                  className={styles.editorContextActionIcon}
                  aria-hidden="true"
                />
                {isWorkbenchVelarFilePath(path)
                  ? t('workbench.editorContextBuild')
                  : t('workbench.editorContextCompile')}
              </button>
            )}
            <div className={styles.editorContextMenuDivider} />
            <button
              type="button"
              role="menuitem"
              disabled={!path || readOnly || disabled || !contextMenu.hasSelection}
              onClick={startCommentForSelection}
            >
              {t('workbench.editorContextComment')}
            </button>
          </div>
        )}
        {!!renamePopup && (
          <RenameInputPopup
            initial={renamePopup.identifier.text}
            left={renamePopup.left}
            top={renamePopup.top}
            onSubmit={(value) => void commitRename(renamePopup.identifier, value)}
            onCancel={() => setRenamePopup(null)}
          />
        )}
        {!!commentDraft && (
          <CommentInputPopup
            left={commentDraft.left}
            anchorTop={commentDraft.anchorTop}
            anchorBottom={commentDraft.anchorBottom}
            boundaryRef={containerRef}
            placeholder={t('workbench.editorCommentPlaceholder')}
            submitLabel={t('workbench.editorCommentSubmit')}
            cancelLabel={t('workbench.editorCommentCancel')}
            onSubmit={commitComment}
            onCancel={() => setCommentDraft(null)}
          />
        )}
      </>
    )
  }
)
