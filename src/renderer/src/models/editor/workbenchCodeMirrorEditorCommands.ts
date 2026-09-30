import { startCompletion } from '@codemirror/autocomplete'
import {
  addCursorAbove,
  addCursorBelow,
  copyLineDown,
  copyLineUp,
  cursorMatchingBracket,
  cursorSyntaxLeft,
  cursorSyntaxRight,
  deleteLine,
  indentLess,
  indentMore,
  indentSelection,
  insertBlankLine,
  moveLineDown,
  moveLineUp,
  redo,
  redoSelection,
  selectLine,
  selectParentSyntax,
  selectSyntaxLeft,
  selectSyntaxRight,
  simplifySelection,
  toggleBlockComment,
  toggleComment,
  toggleTabFocusMode,
  undo,
  undoSelection,
} from '@codemirror/commands'
import { foldAll, foldCode, unfoldAll, unfoldCode } from '@codemirror/language'
import { nextDiagnostic, openLintPanel, previousDiagnostic } from '@codemirror/lint'
import { findPrevious, getSearchQuery, selectNextOccurrence } from '@codemirror/search'
import type { Extension } from '@codemirror/state'
import { type EditorView, keymap } from '@codemirror/view'

import type { WorkbenchKeymapPresetId } from '../layout/workbenchKeymapPresets'
import { toggleWorkbenchEditorWordWrap } from '../settings/workbenchPreferences'

import type { WorkbenchEditorKeymapCommandId } from './workbenchEditorKeymap'
import {
  resolveWorkbenchEditorKeymapCommand,
  type WorkbenchEditorKeyEventLike,
} from './workbenchEditorKeymapResolver'

/** 一个命令怎么做；返回它做了没有。 */
type WorkbenchEditorCommandHandler = (view: EditorView) => boolean

/**
 * 要用到编辑器组件里的东西（语言服务、查找栏、跳行栏、保存、页面的后退 / 前进）的命令：由组件给。
 * `cancel` 只给关查找栏的那一半（关了返回 true），收起多个选区的那一半在这里。
 */
export type WorkbenchEditorHostCommandId =
  | 'call-hierarchy'
  | 'cancel'
  | 'find'
  | 'find-next'
  | 'find-references'
  | 'format-document'
  | 'go-to-definition'
  | 'go-to-line'
  | 'navigate-back'
  | 'navigate-forward'
  | 'organize-imports'
  | 'quick-fix'
  | 'refactor'
  | 'rename-symbol'
  | 'replace'
  | 'save'
  | 'select-all-occurrences'

export type WorkbenchEditorHostCommands = Record<
  WorkbenchEditorHostCommandId,
  WorkbenchEditorCommandHandler
>

type WorkbenchEditorBuiltinCommandId = Exclude<
  WorkbenchEditorKeymapCommandId,
  WorkbenchEditorHostCommandId
>

/** 只靠 CodeMirror 自己就做得了的命令。 */
const BuiltinCommands: Record<WorkbenchEditorBuiltinCommandId, WorkbenchEditorCommandHandler> = {
  'trigger-completion': (view) => {
    if (!view.state.readOnly) startCompletion(view)
    return true
  },
  'next-problem': nextDiagnostic,
  'previous-problem': previousDiagnostic,
  'open-lint-panel': openLintPanel,
  // 还没有查找词时什么也不做（查找栏没开过）。
  'find-previous': (view) => getSearchQuery(view.state).valid && findPrevious(view),
  'toggle-line-comment': toggleComment,
  'toggle-block-comment': toggleBlockComment,
  'indent-more': indentMore,
  'indent-less': indentLess,
  'reindent-selection': indentSelection,
  'move-line-up': moveLineUp,
  'move-line-down': moveLineDown,
  'copy-line-up': copyLineUp,
  'copy-line-down': copyLineDown,
  'delete-line': deleteLine,
  'insert-blank-line': insertBlankLine,
  undo,
  redo,
  'select-next-occurrence': selectNextOccurrence,
  'select-line': selectLine,
  'expand-selection': selectParentSyntax,
  'add-cursor-above': addCursorAbove,
  'add-cursor-below': addCursorBelow,
  'undo-selection': undoSelection,
  'redo-selection': redoSelection,
  'jump-to-bracket': cursorMatchingBracket,
  'cursor-syntax-left': cursorSyntaxLeft,
  'cursor-syntax-right': cursorSyntaxRight,
  'select-syntax-left': selectSyntaxLeft,
  'select-syntax-right': selectSyntaxRight,
  fold: foldCode,
  unfold: unfoldCode,
  'fold-all': foldAll,
  'unfold-all': unfoldAll,
  'toggle-word-wrap': () => {
    toggleWorkbenchEditorWordWrap()
    return true
  },
  'toggle-tab-focus-mode': toggleTabFocusMode,
}

/**
 * 没做成就不算用掉按键的命令，按键接着往下走：只读文件里 Tab 不缩进，交给浏览器去挪焦点；Esc 在编辑器里
 * 没事可做时交给全局（收起右侧面板）。别的命令只要键对上了就算用掉——一个键在这个方案里是某个命令，
 * 它此刻做不了（只读、没有可折叠的……）也不该漏出去变成别的意思。
 */
const PassThroughCommands: ReadonlySet<WorkbenchEditorKeymapCommandId> = new Set([
  'cancel',
  'indent-less',
  'indent-more',
])

export interface WorkbenchEditorKeymapOptions {
  /** 此刻选的键位方案。每次按键现读：换方案不用重建编辑器的扩展。 */
  getPreset: () => WorkbenchKeymapPresetId
  host: WorkbenchEditorHostCommands
  /** 按哪个平台认按键；不给用当前宿主平台。 */
  platform?: string
}

/** 做一个编辑器命令；返回它做了没有。 */
export function runWorkbenchEditorKeymapCommand(
  command: WorkbenchEditorKeymapCommandId,
  view: EditorView,
  host: WorkbenchEditorHostCommands
): boolean {
  if (command === 'cancel') return host.cancel(view) || simplifySelection(view)
  return command in host
    ? host[command as WorkbenchEditorHostCommandId](view)
    : BuiltinCommands[command as WorkbenchEditorBuiltinCommandId](view)
}

/** 编辑器的按键处理：这次按键在所选方案里是哪个命令就做哪个；返回按键用掉了没有。 */
export function createWorkbenchEditorKeyHandler({
  getPreset,
  host,
  platform,
}: WorkbenchEditorKeymapOptions): (view: EditorView, event: WorkbenchEditorKeyEventLike) => boolean {
  return (view, event) => {
    const command = resolveWorkbenchEditorKeymapCommand(event, platform, getPreset())
    if (!command) return false

    const done = runWorkbenchEditorKeymapCommand(command, view, host)
    return done || !PassThroughCommands.has(command)
  }
}

/**
 * 编辑器命令的按键（`workbenchEditorKeymap.ts` 那张表）。挂成 CodeMirror 键位表里一条接所有按键的绑定：它排在
 * 补全列表、行内建议的键（优先级最高的那几张表）后面，排在标准键（方向键、回车、退格……）前面——与以前
 * 编辑器组件里那张表的位置一样。输入法组词期间的按键 CodeMirror 自己不往这里送。
 */
export function workbenchEditorKeymap(options: WorkbenchEditorKeymapOptions): Extension {
  const handleKey = createWorkbenchEditorKeyHandler(options)
  return keymap.of([{ any: (view, event) => !event.isComposing && handleKey(view, event) }])
}
