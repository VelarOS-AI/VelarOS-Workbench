import {
  forwardRef,
  type MouseEvent as ReactMouseEvent,
  type ReactElement,
  type ReactNode,
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
  closeCompletion,
  type CompletionContext,
  type CompletionSource,
  startCompletion,
} from '@codemirror/autocomplete'
import { history, standardKeymap } from '@codemirror/commands'
import {
  bracketMatching,
  foldGutter,
  indentOnInput,
  indentUnit,
  language as languageFacet,
} from '@codemirror/language'
import { type Diagnostic, linter } from '@codemirror/lint'
import {
  findNext,
  findPrevious,
  getSearchQuery,
  replaceAll,
  replaceNext,
  selectSelectionMatches,
} from '@codemirror/search'
import type { Extension } from '@codemirror/state'
import {
  Annotation,
  Compartment,
  EditorSelection,
  EditorState,
  RangeSetBuilder,
  StateEffect,
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
import { ChatCircleTextIcon, HammerIcon, PlayIcon } from '@phosphor-icons/react'
import {
  addWorkbenchCommentAnchorEffect,
  anchorFromLineRange,
  createWorkbenchCommentExtension,
  retainWorkbenchCommentAnchorsEffect,
  setWorkbenchCommentAnchorsEffect,
} from '@renderer/components/editor/workbenchCommentExtension'
import { useWorkbenchEditorConfig } from '@renderer/hooks/useWorkbenchEditorConfig'
import { useWorkbenchKeymapPreset } from '@renderer/hooks/useWorkbenchKeymapController'
import {
  useWorkbenchEditorMetrics,
  useWorkbenchEditorWordWrap,
} from '@renderer/hooks/useWorkbenchPreferences'
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
import type { WorkbenchLanguageServiceWorkspaceEditRequest } from '@renderer/models/editor/workbenchCodeActions'
import {
  isWorkbenchActiveLineSuppressed,
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
  type WorkbenchEditorHostCommands,
  workbenchEditorKeymap,
} from '@renderer/models/editor/workbenchCodeMirrorEditorCommands'
import { buildWorkbenchExternalValueSyncTransaction } from '@renderer/models/editor/workbenchCodeMirrorExternalSync'
import {
  foldWorkbenchImportBlock,
  workbenchImportFoldExtension,
} from '@renderer/models/editor/workbenchCodeMirrorImportFold'
import { createWorkbenchInlayHintExtension } from '@renderer/models/editor/workbenchCodeMirrorInlayHints'
import {
  workbenchInlineCompletionExtension,
  type WorkbenchInlineCompletionRuntime,
} from '@renderer/models/editor/workbenchCodeMirrorInlineCompletion'
import {
  findWorkbenchCodeMirrorLanguage,
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
  usesWorkbenchBuiltinLanguageService,
  usesWorkbenchExternalSemanticLanguageService,
  usesWorkbenchInlayHintLanguageService,
  usesWorkbenchSemanticLanguageService,
} from '@renderer/models/editor/workbenchCodeMirrorLanguageService'
import {
  requestWorkbenchLanguageServiceCompletions,
  shouldRequestWorkbenchLanguageServiceCompletions,
} from '@renderer/models/editor/workbenchCodeMirrorLanguageServiceCompletions'
import { workbenchLineNumbersExtension } from '@renderer/models/editor/workbenchCodeMirrorLineNumberSelection'
import { createWorkbenchCodeMirrorMetricsExtension } from '@renderer/models/editor/workbenchCodeMirrorMetrics'
import { buildWorkbenchReadOnlyExtensions } from '@renderer/models/editor/workbenchCodeMirrorReadOnly'
import {
  createWorkbenchSemanticTokensExtension,
  getWorkbenchSemanticTokenTheme,
} from '@renderer/models/editor/workbenchCodeMirrorSemanticTokens'
import {
  getWorkbenchCodeMirrorLintTheme,
  getWorkbenchCodeMirrorTheme,
} from '@renderer/models/editor/workbenchCodeMirrorTheme'
import { createWorkbenchTokenOccurrenceHighlightExtension } from '@renderer/models/editor/workbenchCodeMirrorTokenOccurrenceHighlight'
import {
  isWorkbenchEditorNavigationCommand,
  type WorkbenchEditorCommandId,
} from '@renderer/models/editor/workbenchEditorCommands'
import { workbenchEditorCoveredScrollMargins } from '@renderer/models/editor/workbenchEditorCoveredScrollMargins'
import { rebuildWorkbenchEditorFileState } from '@renderer/models/editor/workbenchEditorFileStateRebuild'
import {
  type WorkbenchEditorFileState,
  workbenchEditorFileStateKey,
  WorkbenchEditorFileStates,
} from '@renderer/models/editor/workbenchEditorFileStates'
import {
  applyWorkbenchEditorFind,
  closeWorkbenchEditorFind,
  isWorkbenchEditorFindOpen,
  readWorkbenchEditorFindSeed,
  readWorkbenchEditorFindStatus,
  selectWorkbenchEditorFindMatchFrom,
  setWorkbenchEditorFindScope,
  workbenchEditorFindExtension,
} from '@renderer/models/editor/workbenchEditorFind'
import {
  EmptyWorkbenchEditorFindStatus,
  type WorkbenchEditorFindRequest,
  type WorkbenchEditorFindStatus,
} from '@renderer/models/editor/workbenchEditorFindState'
import {
  formatWorkbenchEditorCommandHint,
  type WorkbenchEditorKeymapCommandId,
} from '@renderer/models/editor/workbenchEditorKeymap'
import type { WorkbenchEditorVimHostCommand } from '@renderer/models/editor/workbenchEditorVim'
import {
  setWorkbenchGitBlame,
  workbenchGitBlameGutter,
} from '@renderer/models/editor/workbenchGitBlame'
import {
  setWorkbenchGitChangeBaseEffect,
  workbenchGitChangeGutterExtension,
} from '@renderer/models/editor/workbenchGitChangeGutter'
import {
  buildWorkbenchIndentationConversion,
  detectWorkbenchIndentation,
  resolveWorkbenchIndentation,
  toWorkbenchLanguageServiceEditFormat,
  type WorkbenchIndentation,
  type WorkbenchIndentationOverride,
  type WorkbenchIndentationRequest,
  workbenchIndentUnit,
} from '@renderer/models/editor/workbenchIndentation'
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
  resolveWorkbenchLanguageServiceCompletion,
} from '@renderer/models/editor/workbenchLanguageServiceIpc'
import { workbenchMergeConflictExtension } from '@renderer/models/editor/workbenchMergeConflicts'
import { buildWorkbenchMinimalTextChanges } from '@renderer/models/editor/workbenchMinimalTextChanges'
import {
  createWorkbenchPackageScriptRunGutterExtension,
  shouldShowWorkbenchPackageScriptRunGutter,
} from '@renderer/models/editor/workbenchPackageScriptRunGutter'
import { buildWorkbenchSaveWhitespaceChanges } from '@renderer/models/editor/workbenchSaveWhitespace'
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
import type { WorkbenchProjectContextIndex } from '@renderer/models/project/workbenchProjectContextIndex'
import {
  readWorkbenchPreferences,
  type WorkbenchThemeId,
} from '@renderer/models/settings/workbenchPreferences'
import { useStandaloneWorkbenchModelConfig } from '@renderer/runtime/standaloneWorkbenchModelConfig'
import type { WorkbenchOpenEditorTab } from '@renderer/types/workbenchTypes'

import { isEmpty, isPresent, Log, optionalWhen, toNullable, toOptional } from '@velaros-ai/core'

import type {
  WorkbenchLanguageServiceCodeAction,
  WorkbenchLanguageServiceDiagnostic,
  WorkbenchLanguageServiceEditFormat,
  WorkbenchLanguageServiceFileEdit,
  WorkbenchLanguageServiceLocation,
} from '@shared/contracts'

import { useWorkbenchEditorRunDebugExtension } from '../../hooks/useWorkbenchEditorRunDebug'
import { useWorkbenchEditorVimExtension } from '../../hooks/useWorkbenchEditorVim'
import type { WorkbenchEditorGitBlame } from '../../hooks/useWorkbenchGitBlame'
import type { WorkbenchGitHeadContent } from '../../hooks/useWorkbenchGitHeadContent'
import styles from '../../styles/workbenchPageStyles'
import { useLatest, useTimerScope } from '../../support/genericHooks'
import { useBlockWheelScroll } from '../../support/useBlockWheelScroll'
import { useDismissOnWindowInteract } from '../../support/useDismissOnWindowInteract'

import { EditorSymbolLocationsPanel } from './EditorSymbolLocationsPanel'
import { useEditorCodeActions } from './useEditorCodeActions'
import { useEditorSymbolNavigation } from './useEditorSymbolNavigation'
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
  /** 在光标处做一个代码动作（命令面板里的「快速修复」……）。 */
  runCommand: (command: WorkbenchEditorCommandId) => void
  selectRange: (from: number, to: number) => void
  /** 查找栏的动作：下一处、上一处、替换当前一处（并跳到下一处）、全部替换。 */
  findNext: () => void
  findPrevious: () => void
  replaceNext: () => void
  replaceAll: () => void
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
  /** 工作区在编辑器之外被改动的次数（Agent 写入、磁盘监听）；变了就重新要一次诊断，当前文档没变也要。 */
  externalRevision?: number
  /** 当前文件在 HEAD 里的全文，行号旁的 Git 改动标记拿它对照；不属于当前文件时不用。 */
  gitHeadContent?: Nullable<WorkbenchGitHeadContent>
  /**
   * Git 追溯（blame）。不为 null 就在行号左边显示追溯栏；`blame` 是结果（还在查、文件没纳入版本管理时为 null），
   * 只有属于当前文件的才用。
   */
  gitBlame?: Nullable<WorkbenchEditorGitBlame>
  /** 右键菜单里开关追溯栏；不给就没有这一项。 */
  onToggleGitBlame?: () => void
  /**
   * 各个打开文件的编辑器状态（撤销历史、光标、折叠、滚动位置）。由宿主持有，编辑器卸载再挂载也不丢；
   * 不传时只在这个编辑器实例里记着。
   */
  fileStates?: WorkbenchEditorFileStates
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
  /**
   * 打开查找栏。`seed` 是预填的查找词（选中的文字或光标处的词），`withReplace` 表示连替换行一起展开
   * （⌥⌘F / Ctrl+H）。
   */
  onOpenFind: (seed?: string, withReplace?: boolean) => void
  /** 在编辑区里按 Esc 关掉查找栏。 */
  onCloseFind?: () => void
  /** 查找栏开着时的查找：查找词、替换文本与开关项；null 表示查找栏关着。 */
  find?: Nullable<WorkbenchEditorFindRequest>
  onFindStatusChange?: (status: WorkbenchEditorFindStatus) => void
  onOpenGoToLine: () => void
  /** 当前文件实际用的缩进（报给状态栏）；编辑器卸载时报 null。 */
  onIndentationChange?: (indentation: Nullable<WorkbenchIndentation>) => void
  /** 状态栏缩进菜单的操作：改用某种缩进、转换现有缩进、按内容重新识别。 */
  indentationRequest?: Nullable<WorkbenchIndentationRequest>
  /** 编辑区的后退 / 前进：Windows / Linux 上 Alt+← / Alt+→ 在编辑器里也走它（CodeMirror 本来拿这两个键按语法跳）。 */
  onNavigateBack?: () => void
  onNavigateForward?: () => void
  onGoToDefinition: (path: string, line: number, column?: number) => void
  symbolLocations?: Nullable<WorkbenchSymbolLocationsState>
  onOpenSymbolLocations?: (request: WorkbenchSymbolLocationsRequest, visible?: boolean) => void
  onCloseSymbolLocations?: () => void
  onNavigateSymbolLocation?: (location: WorkbenchLanguageServiceLocation) => void
  /** 跨文件的改名改动；`editedInEditor` 是编辑器自己已经改好的文件数（当前文件），用来报总共改了几个文件。 */
  onApplyLanguageServiceRename?: (
    changes: WorkbenchLanguageServiceFileEdit[],
    options?: { editedInEditor?: number }
  ) => void
  /** 快速修复动到了别的文件、要新建文件：交给页面去落（当前文件的那部分页面会回头让编辑器自己套）。 */
  onApplyLanguageServiceEdit?: (request: WorkbenchLanguageServiceWorkspaceEditRequest) => void
  onRunPackageScript?: (command: string) => void
  onOpenFileHistory?: (mode: 'local' | 'git') => void
  /** 右键「添加到聊天」：把当前文件作为引用挂到聊天输入框（只挂路径）。 */
  onAddToChat?: () => void
  /** 保存；`content` 是这一刻的正文（⌘S 时按设置格式化、按 `.editorconfig` 收拾过空白）。 */
  onSave: (content?: string) => void
  /**
   * Vim 键位方案下 `:q`、`:wq`、`:wa` 要页面做的事（`:w` 走 `onSave`；`:wq` 是先走完保存再报过来）。不给的话
   * 这几个命令在这个编辑器里不起作用。
   */
  onVimCommand?: (command: WorkbenchEditorVimHostCommand) => void
}

/** 编辑器实例建一次、各文件状态共用的扩展（按键、鼠标、更新监听……），它们只通过 ref 读当前的值。 */
interface WorkbenchEditorInstanceExtensions {
  /** 建它们的模块。开发时热更新会换掉整个模块：旧扩展认不出新模块的注解（会把外部同步当成用户输入），得重建。 */
  module: object
  keymap: Extension
  tooltips: Extension
  comments: Extension
  mouseHandlers: Extension
  updateListener: Extension
  inlineCompletion: Extension
  findStatus: Extension
}

type GetWorkbenchOpenTabs = () => readonly WorkbenchOpenEditorTab[]
type GetWorkbenchProjectContextIndex = () => WorkbenchProjectContextIndex

const EditorModule = {}
const externalValueSync = Annotation.define<boolean>()
/** 别的文件在磁盘上变了：linter 据此重跑，不必等当前文档改动。 */
const externalWorkspaceChange = StateEffect.define<number>()
const log = Log.tag('codemirror-editor')
const INDENT_GUIDE_STROKE_PX = 0.75
const INDENT_GUIDE_COLOR = 'rgba(105, 118, 142, 0.26)'
const IDENTIFIER_PATTERN = /[A-Za-z_$][\w$]*/g
const FullSyntaxActivationDelayMs = 90
/** 查找计数合并这么久再报：连续打字、连按下一处只重数一次。 */
const FindStatusDelayMs = 30
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
  workbenchGitChangeGutterExtension,
  workbenchActiveLineExtension,
  highlightSpecialChars(),
  history(),
  workbenchFoldGutter,
  workbenchImportFoldExtension,
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
  workbenchEditorFindExtension,
  // 底部工具窗盖住的那一截不算视野：滚到某一行时让它落在工具窗上面。
  workbenchEditorCoveredScrollMargins(),
  // 这里只留各家都一样的标准键（方向键、Home / End、回车、退格、全选……）。别的键——撤销重做、折叠、移动行、
  // 注释，连同查找、跳行、代码动作——随键位方案变，都在编辑器命令的键位表里（`workbenchEditorKeymap.ts`），
  // 排在这一张前面。
  keymap.of([...closeBracketsKeymap, ...standardKeymap]),
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
  getEditFormat,
  hostRuntime,
}: {
  projectRoot: string
  path: Nullable<string>
  language: string
  getOpenTabs: GetWorkbenchOpenTabs
  getProjectContextIndex: GetWorkbenchProjectContextIndex
  /** 这个文件的缩进：补全里带的整段代码（类成员、对象方法）按它排。 */
  getEditFormat: () => WorkbenchLanguageServiceEditFormat
  hostRuntime: WorkbenchHostRuntime
}): CompletionSource {
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
    if (!shouldRequestWorkbenchLanguageServiceCompletions(context, path)) return localResult || null

    // 交给 CodeMirror 的异步补全：结果回来之前接着打的字由它记着，回来时前缀仍对得上就直接用，不必重新请求。
    const requestBase = buildWorkbenchLanguageServiceRequestBase({
      projectRoot,
      path,
      language,
      content,
      openTabs: getOpenTabs(),
      format: getEditFormat(),
    })
    const position = positionLineColumnFromState(context.state, context.pos)
    return requestWorkbenchLanguageServiceCompletions({
      state: context.state,
      position: context.pos,
      path,
      localResult,
      request: () => getWorkbenchLanguageServiceCompletions({ ...requestBase, position }, hostRuntime),
      resolve: (item) =>
        resolveWorkbenchLanguageServiceCompletion({ ...requestBase, position, item }, hostRuntime),
    })
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
    {
      delay: 500,
      // 依赖文件在磁盘上变了（Agent 修好了它 import 的那个文件）：当前文档没变，诊断也要重算。
      needsRefresh: (update) =>
        update.transactions.some((transaction) =>
          transaction.effects.some((effect) => effect.is(externalWorkspaceChange))
        ),
    }
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
        if (targetView.state.readOnly || targetView.state.doc.toString() !== content) return
        targetView.dispatch({ changes: edits.map((edit) => ({ from: edit.from, to: edit.to, insert: edit.insert })) })
      },
    }]
  })
}

/** compartment 里已经是这份扩展就不动（换回来的文件在换进来时已经配好了）。 */
function reconfigureCompartment(
  view: Nullable<EditorView>,
  compartment: Compartment,
  extension: Extension
): void {
  if (view && compartment.get(view.state) !== extension)
    view.dispatch({ effects: compartment.reconfigure(extension) })
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
      if (
        update.docChanged
        || update.viewportChanged
        || update.startState.tabSize !== update.state.tabSize
      ) {
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
      externalRevision = 0,
      gitHeadContent = null,
      gitBlame = null,
      onToggleGitBlame,
      fileStates,
      onChange,
      onCursorPositionChange,
      onOpenFind,
      onCloseFind,
      find = null,
      onFindStatusChange,
      onOpenGoToLine,
      onNavigateBack,
      onNavigateForward,
      onIndentationChange,
      indentationRequest = null,
      onGoToDefinition,
      symbolLocations = null,
      onOpenSymbolLocations,
      onCloseSymbolLocations,
      onNavigateSymbolLocation,
      onApplyLanguageServiceRename,
      onApplyLanguageServiceEdit,
      onRunPackageScript,
      onOpenFileHistory,
      onAddToChat,
      onSave,
      onVimCommand,
    },
    ref
  ): ReactElement {
    const { t, locale } = useWorkbenchI18n()
    const tLatest = useLatest(t)
    const hostRuntime = useWorkbenchHostRuntime()
    const commentStore = useWorkbenchCommentStore()
    const containerRef = useRef<HTMLDivElement>(null)
    const contextMenuRef = useRef<HTMLDivElement>(null)
    const viewRef = useRef<EditorView>(null)
    const definitionRequestGenerationRef = useRef(0)
    /** 视图里正在显示的文件（项目 + 路径）；没有路径时为 null。 */
    const activeFileKeyRef = useRef<Nullable<string>>(null)
    const instanceExtensionsRef = useRef<Nullable<WorkbenchEditorInstanceExtensions>>(null)
    const [ownFileStates] = useState(() => new WorkbenchEditorFileStates())
    const fileStatesRef = useLatest(fileStates ?? ownFileStates)
    const hostRuntimeRef = useLatest(hostRuntime)
    const pathRef = useLatest(path)
    const openTabsLatest = useLatest(openTabs)
    const projectContextIndexRef = useLatest(projectContextIndex)
    const callbacksRef = useLatest({
      onChange,
      onCursorPositionChange,
      onOpenFind,
      onCloseFind,
      onFindStatusChange,
      onOpenGoToLine,
      onNavigateBack,
      onNavigateForward,
      onIndentationChange,
      onGoToDefinition,
      onOpenSymbolLocations,
      onCloseSymbolLocations,
      onNavigateSymbolLocation,
      onApplyLanguageServiceRename,
      onRunPackageScript,
      onOpenFileHistory,
      onAddToChat,
      onSave,
      onVimCommand,
    })
    const languageCompartment = useMemo(() => new Compartment(), [])
    const readOnlyCompartment = useMemo(() => new Compartment(), [])
    const completionCompartment = useMemo(() => new Compartment(), [])
    const lintCompartment = useMemo(() => new Compartment(), [])
    const packageScriptRunCompartment = useMemo(() => new Compartment(), [])
    const velarMainRunCompartment = useMemo(() => new Compartment(), [])
    const velarTestRunCompartment = useMemo(() => new Compartment(), [])
    const runDebugCompartment = useMemo(() => new Compartment(), [])
    const autocompleteThemeCompartment = useMemo(() => new Compartment(), [])
    const languageHoverCompartment = useMemo(() => new Compartment(), [])
    const languageServiceCompartment = useMemo(() => new Compartment(), [])
    const syntaxThemeCompartment = useMemo(() => new Compartment(), [])
    const editorMetricsCompartment = useMemo(() => new Compartment(), [])
    const indentationCompartment = useMemo(() => new Compartment(), [])
    const wordWrapCompartment = useMemo(() => new Compartment(), [])
    const gitBlameCompartment = useMemo(() => new Compartment(), [])
    const vimCompartment = useMemo(() => new Compartment(), [])
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
          }, hostRuntimeRef.current)
          return result.ok ? result.data.completion || null : null
        },
      }),
      [hostRuntimeRef, inlineCompletionEnabledRef, languageSupportRef, pathRef, projectRootRef]
    )
    const completionSource = useMemo(
      () =>
        createWorkbenchCompletionSource({
          projectRoot,
          path,
          language,
          getOpenTabs: () => openTabsLatest.current,
          getProjectContextIndex: () => projectContextIndexRef.current,
          getEditFormat: () => editFormatRef.current,
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
    // 测试文件的 ▶、JS / TS 文件行号上的断点、调试停下时的那一行与悬停看值（都在这个 hook 里）。
    const runDebugExtension = useWorkbenchEditorRunDebugExtension({
      projectRoot,
      path,
      disabled: disabled || !onRunPackageScript,
      externalRevision,
      hostRuntime,
    })
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
    const editorMetricsExtension = useMemo(
      () => createWorkbenchCodeMirrorMetricsExtension(editorMetrics),
      [editorMetrics]
    )
    const syntaxThemeExtension = getWorkbenchCodeMirrorTheme(workbenchTheme)
    const readOnlyExtension = useMemo(
      () => buildWorkbenchReadOnlyExtensions(readOnly, disabled),
      [disabled, readOnly]
    )
    const completionExtension = useMemo(
      () => EditorState.languageData.of(() => [{ autocomplete: completionSource }]),
      [completionSource]
    )
    const lintExtension = useMemo(
      // linter 自身已有请求防抖，挂载扩展不会同步启动语言服务。这里必须立即挂载，
      // 否则繁忙项目拿不到 idle 时隙时，错误下划线和悬浮提示会永久缺席。
      () => [languageServiceLinter, lintTheme, diagnosticForegroundExtension],
      [diagnosticForegroundExtension, languageServiceLinter, lintTheme]
    )
    // 缩进按切到这个文件那一刻的正文识别（不随每次输入重算）；状态栏为这个文件选过的最优先，其次 `.editorconfig`。
    const valueRef = useLatest(value)
    /** 「按内容重新识别」一次就加一，让识别结果按当前正文重算。 */
    const [indentationDetectionRevision, setIndentationDetectionRevision] = useState(0)
    const detectedIndentation = useMemo(
      () => detectWorkbenchIndentation(valueRef.current),
      [indentationDetectionRevision, path, valueRef]
    )
    const [indentationOverrides, setIndentationOverrides] = useState<
      ReadonlyMap<string, WorkbenchIndentationOverride>
    >(() => new Map())
    const fileKey = path ? workbenchEditorFileStateKey(projectRoot, path) : null
    const indentationOverride = fileKey ? (indentationOverrides.get(fileKey) ?? null) : null
    const editorConfig = useWorkbenchEditorConfig({
      projectRoot,
      path,
      openTabs,
      revision: externalRevision,
    })
    const editorConfigRef = useLatest(editorConfig)
    const indentation = useMemo(
      () =>
        resolveWorkbenchIndentation({
          path,
          detected: detectedIndentation,
          editorConfig,
          override: indentationOverride,
        }),
      [detectedIndentation, editorConfig, indentationOverride, path]
    )
    // 语言服务替用户写代码（格式化、补全插入的整段代码）时按这个文件的缩进排。
    const editFormatRef = useLatest(toWorkbenchLanguageServiceEditFormat(indentation))
    // 快速修复与重构：光标菜单、诊断浮层上的按钮都在这个 hook 里问语言服务、套改动。
    const codeActions = useEditorCodeActions({
      viewRef,
      projectRoot,
      path,
      language,
      readOnly: readOnly || disabled,
      getOpenTabs: () => openTabsLatest.current,
      getEditFormat: () => editFormatRef.current,
      hostRuntime,
      onApplyWorkspaceEdit: onApplyLanguageServiceEdit,
      // 重构抽出来的函数、常量先叫 newFunction、newLocal：光标放到名字上，接着走行内改名。
      onStartRename: (position) => {
        const view = viewRef.current
        if (!view) return
        view.dispatch({ selection: { anchor: position } })
        renameIdentifier(getIdentifierAt(view.state, position))
      },
    })
    const indentationExtension = useMemo(
      () => [
        indentUnit.of(workbenchIndentUnit(indentation)),
        EditorState.tabSize.of(indentation.tabSize),
      ],
      [indentation]
    )
    const wordWrap = useWorkbenchEditorWordWrap()
    const wordWrapExtension = useMemo(() => (wordWrap ? EditorView.lineWrapping : []), [wordWrap])
    // 设置里选的键位方案：按键每次现查（`workbenchEditorKeymap`），换方案不用重建编辑器的扩展。
    const keymapPreset = useWorkbenchKeymapPreset()
    const keymapPresetRef = useLatest(keymapPreset)
    const gitBlameVisible = gitBlame !== null
    const gitBlameExtension = useMemo(
      () => (gitBlameVisible ? workbenchGitBlameGutter(locale) : []),
      [gitBlameVisible, locale]
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
      view.dispatch({ effects: editorMetricsCompartment.reconfigure(editorMetricsExtension) })

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
      editorMetricsCompartment,
      editorMetricsExtension,
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
          isExternalChange: (tr) => tr.annotation(externalValueSync) === true,
        }),
      [
        commentCancelLabelRef,
        commentDeleteLabelRef,
        commentEditLabelRef,
        commentSaveLabelRef,
        commentStore,
      ]
    )

    const openFileHistory = (mode: 'local' | 'git'): void => {
      setContextMenu(null)
      if (path) callbacksRef.current.onOpenFileHistory?.(mode)
    }

    const addCurrentFileToChat = (): void => {
      setContextMenu(null)
      if (path) callbacksRef.current.onAddToChat?.()
    }

    // 按存储里的行号，把当前文件的评论重新锚定成实时块（换进一个文件时调用）。
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

    // 查找引用这类跟着光标处符号走的导航：问语言服务、把结果交给面板都在这个 hook 里。
    const symbolNavigation = useEditorSymbolNavigation({
      viewRef,
      projectRoot,
      path,
      language,
      getOpenTabs: () => openTabsLatest.current,
      hostRuntime,
      getIdentifier: getCurrentIdentifier,
      onOpenSymbolLocations,
      onGoToLocation: onGoToDefinition,
    })
    /** 按键、右键菜单、命令面板交来的编辑器命令：改代码的与导航的各归各的 hook。 */
    const runEditorCommand = (command: WorkbenchEditorCommandId): void => {
      if (isWorkbenchEditorNavigationCommand(command)) symbolNavigation.run(command)
      else codeActions.run(command)
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
        codeActions: codeActions.hover,
      }),
      [codeActions.hover, hostRuntime, language, openTabsLatest, path, projectRoot, t]
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
              destination: optionalWhen(!isDefinition, location),
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
                destination: optionalWhen(!isDefinition, location),
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

            // 没打开的文件也要改（经主进程写回），否则跨文件改名改一半、项目就编不过了。
            if (!isEmpty(otherFileChanges)) {
              callbacksRef.current.onApplyLanguageServiceRename?.(otherFileChanges, {
                editedInEditor: isEmpty(currentFileEdits) ? 0 : 1,
              })
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
            format: editFormatRef.current,
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
        // 格式化期间文档又被改过：这份结果已经过时，套上去会冲掉新敲的字。
        if (nextContent === content || view.state.doc.toString() !== content) return

        // 按最小改动应用：整篇替换会让光标、讲解、AI 选区、评论全部塌到文件开头。
        view.dispatch({ changes: buildWorkbenchMinimalTextChanges(content, nextContent) })
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

    /**
     * 右键菜单里的代码动作作用在点的那个词上：选区不在那个词上（有的平台右键不挪光标）就先把光标放过去，
     * 动作菜单才贴着点的地方出来。
     */
    const runCommandFromContextMenu = (command: WorkbenchEditorCommandId): void => {
      const view = viewRef.current
      const word = contextMenu?.word
      setContextMenu(null)
      if (view && word) {
        const selection = view.state.selection.main
        if (selection.to < word.from || selection.from > word.to)
          view.dispatch({ selection: { anchor: word.from } })
      }
      runEditorCommand(command)
    }

    const openEditorContextMenu = (event: ReactMouseEvent<HTMLDivElement>): void => {
      const view = viewRef.current
      if (!view) return

      event.preventDefault()
      const position = view.posAtCoords({ x: event.clientX, y: event.clientY })
      const word = !isPresent(position) ? null : getIdentifierAt(view.state, position)
      const x = Math.min(event.clientX, window.innerWidth - 236)
      const y = Math.min(event.clientY, window.innerHeight - 380)
      const selection = view.state.selection.main
      setContextMenu({
        x: Math.max(8, x),
        y: Math.max(8, y),
        word,
        canGoToDefinition: isPresent(word) || isPresent(getDefinitionTarget(word)),
        hasSelection: selection.from !== selection.to,
      })
    }

    // 菜单有哪些条目随文件而变、多宽随语言和键位方案（右侧提示的键）而变，先按估的放；画出来以后量一下，
    // 伸到窗口下沿、右沿外面就往回收。
    useLayoutEffect(() => {
      const menu = contextMenuRef.current
      if (!menu || !contextMenu) return
      const rect = menu.getBoundingClientRect()
      const x = Math.max(8, contextMenu.x - Math.max(0, rect.right - (window.innerWidth - 8)))
      const y = Math.max(8, contextMenu.y - Math.max(0, rect.bottom - (window.innerHeight - 8)))
      if (x !== contextMenu.x || y !== contextMenu.y) setContextMenu({ ...contextMenu, x, y })
    }, [contextMenu])

    /** 右键菜单里编辑器命令的一项：名字在左，所选键位方案下这个命令的键在右（没有键就只有名字）。 */
    const commandMenuLabel = (command: WorkbenchEditorKeymapCommandId, label: string): ReactNode => {
      const hint = formatWorkbenchEditorCommandHint(command, keymapPreset)
      return (
        <>
          <span className={styles.workbenchContextMenuLabel}>{label}</span>
          {!!hint && <span className={styles.workbenchContextMenuShortcut}>{hint}</span>}
        </>
      )
    }

    useDismissOnWindowInteract({
      enabled: isPresent(contextMenu),
      onDismiss: () => setContextMenu(null),
      ignoreMouseDown: (event) =>
        event.target instanceof Node && !!contextMenuRef.current?.contains(event.target),
    })
    useBlockWheelScroll(contextMenuRef, isPresent(contextMenu))
    /** 查找栏按钮触发的查找命令：焦点留在查找栏，当前行照常高亮。 */
    const runFindCommand = (command: (view: EditorView) => boolean): void => {
      const view = viewRef.current
      if (!view) return
      command(view)
      revealWorkbenchActiveLine(view)
    }

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
      runCommand: (command) => runEditorCommand(command),
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
      findNext: () => runFindCommand(findNext),
      findPrevious: () => runFindCommand(findPrevious),
      replaceNext: () => runFindCommand(replaceNext),
      replaceAll: () => runFindCommand(replaceAll),
    }))

    // 按键、鼠标这些处理函数挂在编辑器实例上、一直不换，经这个 ref 调到最近一次渲染的版本（项目、路径、语言都是当前的）。
    const editorActionsRef = useLatest({
      goToDefinitionForWord,
      renameIdentifier,
      selectReferenceOccurrences,
      formatDocument,
      runCommand: runEditorCommand,
    })

    /**
     * ⌘S：打开了「保存时格式化」就先格式化，再按 `.editorconfig` 去掉行尾空白、补上结尾换行，最后把这一刻的正文
     * 交去保存（不等标签里的正文随渲染跟上）。只读文件原样保存。
     */
    const saveFromEditor = async (view: EditorView): Promise<void> => {
      if (!view.state.readOnly) {
        if (readWorkbenchPreferences().editorFormatOnSave) await editorActionsRef.current.formatDocument()
        const whitespace = buildWorkbenchSaveWhitespaceChanges(view.state, editorConfigRef.current)
        if (whitespace.length > 0) view.dispatch({ changes: whitespace })
      }
      callbacksRef.current.onSave(view.state.doc.toString())
    }

    // Vim 键位方案：模式编辑那一层选了才加载（见 useWorkbenchEditorVim）。`:w` 就是上面的保存，其余交给页面。
    const vimExtension = useWorkbenchEditorVimExtension(keymapPreset === 'vim', {
      save: (view) => void saveFromEditor(view),
      quit: () => callbacksRef.current.onVimCommand?.('quit'),
      saveAndQuit: (view) => {
        // 保存时格式化要等一下：等的时候换了文件，就只存不关。
        const savedPath = pathRef.current
        void saveFromEditor(view).then(() => {
          if (pathRef.current === savedPath) callbacksRef.current.onVimCommand?.('write-quit')
        })
      },
      saveAll: () => callbacksRef.current.onVimCommand?.('write-all'),
    })
    const compartmentValuesRef = useLatest({
      vim: vimExtension,
      editorMetrics: editorMetricsExtension,
      syntaxTheme: syntaxThemeExtension,
      autocompleteTheme,
      languageHover: languageServiceHoverExtension,
      packageScriptRun: packageScriptRunExtension,
      velarMainRun: velarMainRunExtension,
      velarTestRun: velarTestRunExtension,
      runDebug: runDebugExtension,
      basicLanguage: basicLanguageExtension,
      readOnly: readOnlyExtension,
      completion: completionExtension,
      lint: lintExtension,
      indentation: indentationExtension,
      wordWrap: wordWrapExtension,
      gitBlame: gitBlameExtension,
    })

    const createInstanceExtensions = (
      container: HTMLDivElement
    ): WorkbenchEditorInstanceExtensions => {
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

      /** 有查找词就找下一处，还没有就打开查找栏。 */
      const findNextOrOpen = (view: EditorView): boolean => {
        if (getSearchQuery(view.state).valid) findNext(view)
        else callbacksRef.current.onOpenFind(readWorkbenchEditorFindSeed(view.state))
        return true
      }

      /** 交给光标处的代码动作、符号导航去做（快速修复、重构、查找引用……）。 */
      const runCursorCommand = (command: WorkbenchEditorCommandId) => (): boolean => {
        editorActionsRef.current.runCommand(command)
        return true
      }

      // 编辑器命令里要用到这个组件的那些（别的在 workbenchCodeMirrorEditorCommands.ts 里）；哪个键是哪个命令
      // 看键位表。
      const hostCommands: WorkbenchEditorHostCommands = {
        'go-to-definition': () => {
          void editorActionsRef.current.goToDefinitionForWord(getCurrentIdentifier())
          return true
        },
        'rename-symbol': () => {
          editorActionsRef.current.renameIdentifier(getCurrentIdentifier())
          return true
        },
        // 选中了字：选中全部一样的文字。只是光标停在一个符号上：选中它在这个文件里的全部出现（语言服务认的
        // 那些；没有语言服务的文件按文字找）。
        'select-all-occurrences': (view) => {
          if (!selectSelectionMatches(view))
            void editorActionsRef.current.selectReferenceOccurrences(getCurrentIdentifier())
          return true
        },
        'format-document': () => {
          void editorActionsRef.current.formatDocument()
          return true
        },
        save: (view) => {
          void saveFromEditor(view)
          return true
        },
        find: (view) => {
          callbacksRef.current.onOpenFind(readWorkbenchEditorFindSeed(view.state))
          return true
        },
        replace: (view) => {
          callbacksRef.current.onOpenFind(readWorkbenchEditorFindSeed(view.state), true)
          return true
        },
        'find-next': findNextOrOpen,
        // Esc：查找栏开着就关掉它（没开着的话由键位表那边去收多个选区）。
        cancel: (view) => {
          if (!isWorkbenchEditorFindOpen(view.state)) return false
          callbacksRef.current.onCloseFind?.()
          return true
        },
        'go-to-line': () => {
          callbacksRef.current.onOpenGoToLine()
          return true
        },
        'navigate-back': () => {
          callbacksRef.current.onNavigateBack?.()
          return true
        },
        'navigate-forward': () => {
          callbacksRef.current.onNavigateForward?.()
          return true
        },
        'quick-fix': runCursorCommand('quick-fix'),
        refactor: runCursorCommand('refactor'),
        'organize-imports': runCursorCommand('organize-imports'),
        'call-hierarchy': runCursorCommand('call-hierarchy'),
        'find-references': runCursorCommand('find-references'),
      }

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
          void editorActionsRef.current.goToDefinitionForWord(word)
          return true
        },
      })

      // 查找栏开着时，匹配数和当前是第几处随查找词、正文、选区变化报给查找栏（连续变化合并成一次）。
      const findStatus = ViewPlugin.fromClass(
        class {
          private timer: Nullable<number> = null

          public constructor(private readonly view: EditorView) {
            if (isWorkbenchEditorFindOpen(view.state)) this.schedule()
          }

          public update(update: ViewUpdate): void {
            const open = isWorkbenchEditorFindOpen(update.state)
            if (
              open !== isWorkbenchEditorFindOpen(update.startState)
              || (open
                && (update.docChanged
                  || update.selectionSet
                  || getSearchQuery(update.state) !== getSearchQuery(update.startState)))
            )
              this.schedule()
          }

          public destroy(): void {
            if (this.timer !== null) window.clearTimeout(this.timer)
          }

          private schedule(): void {
            if (this.timer !== null) return
            this.timer = window.setTimeout(() => {
              this.timer = null
              const state = this.view.state
              callbacksRef.current.onFindStatusChange?.(
                isWorkbenchEditorFindOpen(state)
                  ? readWorkbenchEditorFindStatus(state)
                  : EmptyWorkbenchEditorFindStatus
              )
            }, FindStatusDelayMs)
          }
        }
      )

      return {
        module: EditorModule,
        findStatus,
        keymap: workbenchEditorKeymap({
          getPreset: () => keymapPresetRef.current,
          host: hostCommands,
        }),
        tooltips: tooltips({
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
        comments: workbenchCommentExtension,
        mouseHandlers,
        updateListener,
        inlineCompletion: workbenchInlineCompletionExtension(inlineCompletionRuntime),
      }
    }

    /** 一个文件的全部扩展：实例共用的那些，加上各 compartment 现在的值。顺序就是优先级。 */
    const buildFileExtensions = (instance: WorkbenchEditorInstanceExtensions): Extension[] => {
      const current = compartmentValuesRef.current
      return [
        // Vim 的按键处理要在编辑器别的按键处理之前：排在最前面（没选 Vim 方案时是空的）。
        vimCompartment.of(current.vim),
        instance.keymap,
        // 追溯栏排在行号左边：要在带行号栏的基础扩展之前。
        gitBlameCompartment.of(current.gitBlame),
        ...workbenchCodeMirrorBaseExtensions,
        instance.tooltips,
        editorMetricsCompartment.of(current.editorMetrics),
        syntaxThemeCompartment.of(current.syntaxTheme),
        autocompleteThemeCompartment.of(current.autocompleteTheme),
        indentationCompartment.of(current.indentation),
        wordWrapCompartment.of(current.wordWrap),
        workbenchIndentGuideExtension,
        workbenchMergeConflictExtension((key) => tLatest.current(key)),
        instance.comments,
        instance.mouseHandlers,
        languageHoverCompartment.of(current.languageHover),
        languageServiceCompartment.of([]),
        packageScriptRunCompartment.of(current.packageScriptRun),
        velarMainRunCompartment.of(current.velarMainRun),
        velarTestRunCompartment.of(current.velarTestRun),
        runDebugCompartment.of(current.runDebug),
        instance.updateListener,
        languageCompartment.of(current.basicLanguage),
        readOnlyCompartment.of(current.readOnly),
        completionCompartment.of(current.completion),
        lintCompartment.of(current.lint),
        instance.inlineCompletion,
        instance.findStatus,
        workbenchEditorChromeTheme,
      ]
    }

    /** 换回来的文件，状态里还是切走那会儿的配置（主题、只读、补全源……），换成现在的。语言归渐进加载管。 */
    const syncFileCompartments = (view: EditorView): void => {
      const current = compartmentValuesRef.current
      const wanted: Array<[Compartment, Extension]> = [
        [vimCompartment, current.vim],
        [editorMetricsCompartment, current.editorMetrics],
        [syntaxThemeCompartment, current.syntaxTheme],
        [autocompleteThemeCompartment, current.autocompleteTheme],
        [languageHoverCompartment, current.languageHover],
        [packageScriptRunCompartment, current.packageScriptRun],
        [velarMainRunCompartment, current.velarMainRun],
        [velarTestRunCompartment, current.velarTestRun],
        [runDebugCompartment, current.runDebug],
        [readOnlyCompartment, current.readOnly],
        [completionCompartment, current.completion],
        [lintCompartment, current.lint],
        [indentationCompartment, current.indentation],
        [wordWrapCompartment, current.wordWrap],
        [gitBlameCompartment, current.gitBlame],
      ]
      const effects = wanted.flatMap(([compartment, extension]) =>
        compartment.get(view.state) === extension ? [] : [compartment.reconfigure(extension)]
      )
      if (!isEmpty(effects)) view.dispatch({ effects })
    }

    /** 视图里此刻的文件状态，连同滚动位置。 */
    const snapshotFileState = (
      view: EditorView,
      instance: WorkbenchEditorInstanceExtensions
    ): WorkbenchEditorFileState => ({
      state: view.state,
      scroll: view.scrollSnapshot(),
      activeLineSuppressed: isWorkbenchActiveLineSuppressed(view),
      owner: instance,
    })

    /** 离开当前文件：收起补全、悬浮提示，把它的状态连同滚动位置存起来。 */
    const saveActiveFileState = (view: EditorView): void => {
      const key = activeFileKeyRef.current
      const instance = instanceExtensionsRef.current
      if (!key || !instance) return

      closeCompletion(view)
      closeWorkbenchEditorFind(view)
      view.dispatch({ effects: closeHoverTooltips })
      fileStatesRef.current.save(key, snapshotFileState(view, instance))
    }

    /** 要显示的文件的状态：存过的取回来（别的编辑器实例存的按 JSON 重建），没存过的按正文新建。 */
    const loadFileState = (
      key: Nullable<string>,
      content: string,
      instance: WorkbenchEditorInstanceExtensions
    ): { state: EditorState; saved: Nullable<WorkbenchEditorFileState> } => {
      // 登记这个编辑器接下来显示它：标签挪到另一组的编辑器里时，那边向这里要此刻的状态（见 WorkbenchEditorFileStates）。
      const saved = key
        ? fileStatesRef.current.take(key, {
            owner: instance,
            snapshot: () =>
              viewRef.current ? snapshotFileState(viewRef.current, instance) : null,
          })
        : undefined
      if (saved) {
        if (saved.owner === instance) return { state: saved.state, saved }
        try {
          return {
            state: rebuildWorkbenchEditorFileState(saved.state, buildFileExtensions(instance)),
            saved,
          }
        } catch (error) {
          log.debug('恢复文件的编辑器状态失败，按当前正文重新打开', { key, error })
        }
      }
      return {
        state: EditorState.create({ doc: content, extensions: buildFileExtensions(instance) }),
        saved: null,
      }
    }

    /**
     * 文件状态放进视图之后：换回来的文件滚回原处，补上切走期间在别处发生的改动；新打开的文件从头显示、
     * 收起 import 区，当前行先不亮。
     */
    const settleFileState = (
      view: EditorView,
      saved: Nullable<WorkbenchEditorFileState>,
      content: string
    ): void => {
      if (saved) {
        syncFileCompartments(view)
        view.dispatch({ effects: saved.scroll })
        if (saved.activeLineSuppressed) suppressWorkbenchActiveLine(view)
        else revealWorkbenchActiveLine(view)
        const sync = buildWorkbenchExternalValueSyncTransaction(
          view.state,
          content,
          externalValueSync.of(true)
        )
        if (sync) view.dispatch(sync)
      } else {
        suppressWorkbenchActiveLine(view)
        view.scrollDOM.scrollTo({ left: 0, top: 0 })
        foldWorkbenchImportBlock(view)
      }
      reanchorWorkbenchComments(view)
      emitCursorPosition(view, callbacksRef.current.onCursorPositionChange)
    }

    useEffect(() => {
      const container = containerRef.current
      if (!container || viewRef.current) return

      let instance = instanceExtensionsRef.current
      if (instance?.module !== EditorModule)
        instance = instanceExtensionsRef.current = createInstanceExtensions(container)
      const key = path ? workbenchEditorFileStateKey(projectRoot, path) : null
      const { state, saved } = loadFileState(key, value, instance)
      const view = new EditorView({ state, parent: container })
      viewRef.current = view
      activeFileKeyRef.current = key
      settleFileState(view, saved, value)

      return () => {
        // 编辑器要卸载了（切到预览、对比视图）：当前文件的状态也存起来，挂回来时接着用。
        saveActiveFileState(view)
        activeFileKeyRef.current = null
        view.destroy()
        viewRef.current = null
      }
    }, [])

    useEffect(() => {
      const view = viewRef.current
      const instance = instanceExtensionsRef.current
      if (!view || !instance) return

      const key = path ? workbenchEditorFileStateKey(projectRoot, path) : null
      if (key !== activeFileKeyRef.current) {
        // 换了文件：离开的存起来，要显示的取回来——撤销历史、光标、折叠、滚动位置各归各的文件，
        // ⌘Z 不会把别的文件的内容撤进来。
        saveActiveFileState(view)
        const { state, saved } = loadFileState(key, value, instance)
        view.setState(state)
        activeFileKeyRef.current = key
        setContextMenu(null)
        setRenamePopup(null)
        setCommentDraft(null)
        settleFileState(view, saved, value)
        return
      }
      const sync = buildWorkbenchExternalValueSyncTransaction(
        view.state,
        value,
        externalValueSync.of(true)
      )
      if (!sync) return

      view.dispatch(sync)
      emitCursorPosition(view, callbacksRef.current.onCursorPositionChange)
    }, [path, projectRoot, value])

    // 查找栏的查找词与开关项交给 CodeMirror 的搜索状态（高亮全部匹配、下一处、替换都靠它）；查找栏关了就收起。
    const appliedFindRef = useRef<Nullable<WorkbenchEditorFindRequest>>(null)
    /** 查找用在了哪个文件上：换了文件（查找栏开着）要在新文件的状态上重新打开查找。 */
    const appliedFindFileKeyRef = useRef<Nullable<string>>(null)
    /** 边打边找的起点：打开查找栏（或换到这个文件）时光标所在处（选区开头）。 */
    const findAnchorRef = useRef(0)
    useEffect(() => {
      const view = viewRef.current
      if (!view) return

      const previous = appliedFindRef.current
      const fileChanged = appliedFindFileKeyRef.current !== activeFileKeyRef.current
      appliedFindRef.current = find
      appliedFindFileKeyRef.current = activeFileKeyRef.current
      if (!find) {
        if (previous) closeWorkbenchEditorFind(view)
        return
      }
      if (!previous || fileChanged) {
        // 光标停在一个词里（⌘F 拿这个词预填）时从词首找起，当前匹配就是它自己。
        const selection = view.state.selection.main
        const word = selection.empty ? view.state.wordAt(selection.head) : null
        findAnchorRef.current = word?.from ?? selection.from
      }
      if (find.inSelection !== (previous?.inSelection ?? false) || (fileChanged && find.inSelection))
        setWorkbenchEditorFindScope(view, find.inSelection)
      applyWorkbenchEditorFind(view, find)
      // 查找词或开关项变了才边打边找、挪选区；只是换到另一个文件时不动它的光标，只高亮匹配。
      const searchChanged =
        !previous
        || previous.query !== find.query
        || previous.caseSensitive !== find.caseSensitive
        || previous.wholeWord !== find.wholeWord
        || previous.regexp !== find.regexp
        || previous.inSelection !== find.inSelection
      if (searchChanged && !(fileChanged && previous))
        selectWorkbenchEditorFindMatchFrom(view, findAnchorRef.current)
    }, [find, path, projectRoot])

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
      reconfigureCompartment(viewRef.current, languageHoverCompartment, languageServiceHoverExtension)
    }, [languageHoverCompartment, languageServiceHoverExtension])

    // Git 改动标记只拿属于当前文件的 HEAD 全文对照。每个文件的状态里各有一份对照，切文件时新文件的 HEAD
    // 还没读回来就先用它自己上次的（新打开的文件本来就没有标记），读回来再换。
    const gitBase = gitHeadContent?.path === path ? gitHeadContent : null
    useEffect(() => {
      if (gitBase)
        viewRef.current?.dispatch({ effects: setWorkbenchGitChangeBaseEffect.of(gitBase.content) })
    }, [gitBase, path])

    // 追溯栏先按开关挂上或撤掉，再换上属于当前文件的结果（别的文件的、还没查回来的都先清空）。
    useEffect(() => {
      reconfigureCompartment(viewRef.current, gitBlameCompartment, gitBlameExtension)
    }, [gitBlameCompartment, gitBlameExtension])
    const gitBlameForFile = gitBlame?.path === path ? gitBlame.blame : null
    useEffect(() => {
      viewRef.current?.dispatch({ effects: setWorkbenchGitBlame.of(gitBlameForFile) })
    }, [gitBlameExtension, gitBlameForFile, path])

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
      reconfigureCompartment(viewRef.current, readOnlyCompartment, readOnlyExtension)
    }, [readOnlyCompartment, readOnlyExtension])

    useEffect(() => {
      reconfigureCompartment(viewRef.current, completionCompartment, completionExtension)
    }, [completionCompartment, completionExtension])

    useEffect(() => {
      reconfigureCompartment(viewRef.current, lintCompartment, lintExtension)
    }, [lintCompartment, lintExtension])

    useEffect(() => {
      reconfigureCompartment(viewRef.current, indentationCompartment, indentationExtension)
    }, [indentationCompartment, indentationExtension])

    useEffect(() => {
      callbacksRef.current.onIndentationChange?.(indentation)
    }, [callbacksRef, indentation])
    useEffect(() => () => callbacksRef.current.onIndentationChange?.(null), [callbacksRef])

    // 状态栏缩进菜单的操作，每个请求只做一次。
    const appliedIndentationRequestRef = useRef<Nullable<number>>(null)
    useEffect(() => {
      const view = viewRef.current
      if (!view || !fileKey || !indentationRequest) return
      if (appliedIndentationRequestRef.current === indentationRequest.id) return
      appliedIndentationRequestRef.current = indentationRequest.id

      const setOverride = (override: Nullable<WorkbenchIndentationOverride>): void =>
        setIndentationOverrides((current) => {
          const next = new Map(current)
          if (override) next.set(fileKey, override)
          else next.delete(fileKey)
          return next
        })
      const { change } = indentationRequest
      if (change.kind === 'detect') {
        setOverride(null)
        setIndentationDetectionRevision((revision) => revision + 1)
        return
      }
      if (change.kind === 'use') {
        setOverride({ style: change.style, size: change.size })
        return
      }
      // 转换现有缩进：一级缩进的宽度不变（制表符的显示宽度就等于原来一级几格），一次改完、一步撤销。
      const target = { style: change.style, size: indentation.size }
      if (!view.state.readOnly) {
        const changes = buildWorkbenchIndentationConversion(view.state, target, indentation.tabSize)
        if (!isEmpty(changes)) view.dispatch({ changes })
      }
      setOverride(target)
    }, [fileKey, indentation, indentationRequest])

    useEffect(() => {
      reconfigureCompartment(viewRef.current, wordWrapCompartment, wordWrapExtension)
    }, [wordWrapCompartment, wordWrapExtension])

    const appliedExternalRevisionRef = useRef(externalRevision)
    useEffect(() => {
      if (appliedExternalRevisionRef.current === externalRevision) return
      appliedExternalRevisionRef.current = externalRevision
      viewRef.current?.dispatch({ effects: externalWorkspaceChange.of(externalRevision) })
    }, [externalRevision])

    useEffect(() => {
      const view = viewRef.current
      if (!view) return

      // 换回来的文件已经是完整语法（语法树还在）：直接接上，不必先退回基础着色再重新解析一遍。
      const fullLanguage = findWorkbenchCodeMirrorLanguage(languageExtension)
      const fullSyntaxReady = !!fullLanguage && view.state.facet(languageFacet) === fullLanguage
      view.dispatch({
        effects: [
          languageCompartment.reconfigure(fullSyntaxReady ? languageExtension : basicLanguageExtension),
          languageServiceCompartment.reconfigure([]),
        ],
      })

      let cancelSyntaxIdle = (): void => undefined
      let cancelSemanticIdle = (): void => undefined
      const syntaxLease = progressiveLoadTimers.after(
        FullSyntaxActivationDelayMs,
        () => {
          if (viewRef.current !== view || fullSyntaxReady) return
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
      reconfigureCompartment(viewRef.current, packageScriptRunCompartment, packageScriptRunExtension)
    }, [packageScriptRunCompartment, packageScriptRunExtension])

    useEffect(() => {
      reconfigureCompartment(viewRef.current, velarMainRunCompartment, velarMainRunExtension)
    }, [velarMainRunCompartment, velarMainRunExtension])

    useEffect(() => {
      reconfigureCompartment(viewRef.current, velarTestRunCompartment, velarTestRunExtension)
    }, [velarTestRunCompartment, velarTestRunExtension])

    useEffect(() => {
      reconfigureCompartment(viewRef.current, runDebugCompartment, runDebugExtension)
    }, [runDebugCompartment, runDebugExtension])

    useEffect(() => {
      reconfigureCompartment(viewRef.current, vimCompartment, vimExtension)
    }, [vimCompartment, vimExtension])

    useEffect(() => {
      reconfigureCompartment(viewRef.current, syntaxThemeCompartment, syntaxThemeExtension)
    }, [syntaxThemeCompartment, syntaxThemeExtension])

    useEffect(() => {
      reconfigureCompartment(viewRef.current, autocompleteThemeCompartment, autocompleteTheme)
    }, [autocompleteTheme, autocompleteThemeCompartment])

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
            onFocusEditor={() => viewRef.current?.focus()}
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
              {commandMenuLabel('rename-symbol', t('workbench.editorContextRenameSymbol'))}
            </button>
            <button
              type="button"
              role="menuitem"
              disabled={!contextMenu.canGoToDefinition}
              onClick={() => void goToDefinitionForWord(contextMenu.word)}
            >
              {commandMenuLabel('go-to-definition', t('workbench.editorContextGoToDefinition'))}
            </button>
            <button
              type="button"
              role="menuitem"
              disabled={!contextMenu.word || !symbolNavigation.canRun('find-references')}
              onClick={() => runCommandFromContextMenu('find-references')}
            >
              {commandMenuLabel('find-references', t('workbench.editorContextFindReferences'))}
            </button>
            <button
              type="button"
              role="menuitem"
              disabled={!contextMenu.word || !symbolNavigation.canRun('call-hierarchy')}
              onClick={() => runCommandFromContextMenu('call-hierarchy')}
            >
              {commandMenuLabel('call-hierarchy', t('workbench.editorContextCallHierarchy'))}
            </button>
            <button
              type="button"
              role="menuitem"
              disabled={!codeActions.canRun('quick-fix')}
              onClick={() => runCommandFromContextMenu('quick-fix')}
            >
              {commandMenuLabel('quick-fix', t('workbench.editorContextQuickFix'))}
            </button>
            <button
              type="button"
              role="menuitem"
              disabled={!codeActions.canRun('refactor')}
              onClick={() => runCommandFromContextMenu('refactor')}
            >
              {commandMenuLabel('refactor', t('workbench.editorContextRefactor'))}
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
              {commandMenuLabel('format-document', t('workbench.editorContextFormatDocument'))}
            </button>
            <button
              type="button"
              role="menuitem"
              disabled={!codeActions.canRun('organize-imports')}
              onClick={() => runCommandFromContextMenu('organize-imports')}
            >
              {commandMenuLabel('organize-imports', t('workbench.editorContextOrganizeImports'))}
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
              disabled={!path || !onAddToChat}
              onClick={addCurrentFileToChat}
            >
              <ChatCircleTextIcon
                size={14}
                weight="regular"
                className={styles.editorContextActionIcon}
                aria-hidden="true"
              />
              {t('workbench.editorContextAddToChat')}
            </button>
            <button
              type="button"
              role="menuitem"
              disabled={!path || readOnly || disabled || !contextMenu.hasSelection}
              onClick={startCommentForSelection}
            >
              {t('workbench.editorContextComment')}
            </button>
            {!!onToggleGitBlame && (
              <>
                <div className={styles.editorContextMenuDivider} />
                <button
                  type="button"
                  role="menuitem"
                  disabled={!path}
                  onClick={() => {
                    setContextMenu(null)
                    onToggleGitBlame()
                  }}
                >
                  {gitBlameVisible
                    ? t('workbench.editorContextHideGitBlame')
                    : t('workbench.editorContextShowGitBlame')}
                </button>
              </>
            )}
          </div>
        )}
        {codeActions.overlay}
        {!!symbolNavigation.overlay && !!containerRef.current
          && createPortal(symbolNavigation.overlay, containerRef.current)}
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
