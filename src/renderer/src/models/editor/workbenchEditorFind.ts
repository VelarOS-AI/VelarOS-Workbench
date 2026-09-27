import {
  closeSearchPanel,
  getSearchQuery,
  openSearchPanel,
  search,
  searchPanelOpen,
  SearchQuery,
  setSearchQuery,
} from '@codemirror/search'
import {
  EditorSelection,
  type EditorState,
  type Extension,
  StateEffect,
  StateField,
} from '@codemirror/state'
import { Decoration, EditorView } from '@codemirror/view'

import {
  EmptyWorkbenchEditorFindStatus,
  type WorkbenchEditorFindRequest,
  type WorkbenchEditorFindStatus,
} from './workbenchEditorFindState'

/** 计数最多数到这里：再多也只是显示「N+」，不值得每次按键都扫完大文件。 */
const MaxCountedMatches = 10_000
/** 用选中文字当查找词时最长取这么多字符。 */
const MaxSeedChars = 200

interface FindScope {
  from: number
  to: number
}

const setFindScopeEffect = StateEffect.define<Nullable<FindScope>>()
const findScopeMark = Decoration.mark({ class: 'cm-workbenchFindScope' })

/** 「在选区中查找」的范围：随编辑挪动。 */
const findScopeField = StateField.define<Nullable<FindScope>>({
  create: () => null,
  update(scope, tr) {
    for (const effect of tr.effects) if (effect.is(setFindScopeEffect)) return effect.value
    if (!scope || !tr.docChanged) return scope
    return { from: tr.changes.mapPos(scope.from, -1), to: tr.changes.mapPos(scope.to, 1) }
  },
  provide: (field) =>
    EditorView.decorations.from(field, (scope) =>
      scope && scope.to > scope.from
        ? Decoration.set([findScopeMark.range(scope.from, scope.to)])
        : Decoration.none
    ),
})


/** 查找范围之外的匹配不算（这个函数的身份参与查询比较，得是同一个）。 */
function insideFindScope(_match: string, state: EditorState, from: number, to: number): boolean {
  const scope = state.field(findScopeField, false)
  return !scope || (from >= scope.from && to <= scope.to)
}

/**
 * 查找用 CodeMirror 自带的搜索状态和命令：高亮全部匹配、下一处、替换、全部替换都是它的。界面是编辑区自己的查找栏，
 * 所以面板只挂一个不显示的空壳——搜索状态只在面板「开着」时高亮匹配。
 */
export const workbenchEditorFindExtension: Extension = [
  search({
    createPanel: () => {
      const dom = document.createElement('div')
      dom.className = 'cm-workbenchFindPanel'
      return { dom }
    },
  }),
  findScopeField,
  EditorView.theme({
    '.cm-workbenchFindPanel': { display: 'none' },
    '.cm-panels-bottom:has(> .cm-workbenchFindPanel:only-child)': { display: 'none' },
    '.cm-searchMatch': {
      backgroundColor: 'var(--workbench-editor-find-match, rgba(234, 179, 8, 0.26))',
      outline: 'none',
      borderRadius: '2px',
    },
    '.cm-searchMatch.cm-searchMatch-selected, .cm-searchMatch-selected': {
      backgroundColor: 'var(--workbench-editor-find-match-active, rgba(249, 115, 22, 0.42))',
    },
    '.cm-workbenchFindScope': {
      backgroundColor: 'var(--workbench-editor-find-scope, rgba(99, 102, 241, 0.08))',
    },
  }),
]

export function buildWorkbenchEditorSearchQuery(request: WorkbenchEditorFindRequest): SearchQuery {
  return new SearchQuery({
    search: request.query,
    replace: request.replace,
    caseSensitive: request.caseSensitive,
    wholeWord: request.wholeWord,
    regexp: request.regexp,
    // 普通查找按字面找（`\n` 就是反斜杠加 n）；正则模式下替换文本里的 `\n`、`\t` 是换行、制表符。
    literal: !request.regexp,
    test: request.inSelection ? insideFindScope : undefined,
  })
}

/** 打开（或更新）查找：面板没开就先开，再换上查找栏的查找词与选项。 */
export function applyWorkbenchEditorFind(view: EditorView, request: WorkbenchEditorFindRequest): void {
  // 打开面板时 CodeMirror 会拿选中文字当查找词，所以先开面板、再设查找词。
  if (!searchPanelOpen(view.state)) openSearchPanel(view)
  const query = buildWorkbenchEditorSearchQuery(request)
  if (!getSearchQuery(view.state).eq(query)) view.dispatch({ effects: setSearchQuery.of(query) })
}

/** 收起查找：匹配高亮随之消失，查找词留着，⌘G / F3 还能接着找。 */
export function closeWorkbenchEditorFind(view: EditorView): void {
  if (searchPanelOpen(view.state)) closeSearchPanel(view)
  if (view.state.field(findScopeField, false))
    view.dispatch({ effects: setFindScopeEffect.of(null) })
}

/** 打开或关掉「在选区中查找」：打开时记下当前选区（没选中就用光标所在行）。 */
export function setWorkbenchEditorFindScope(view: EditorView, inSelection: boolean): void {
  view.dispatch({ effects: buildWorkbenchEditorFindScopeEffect(view.state, inSelection) })
}

export function buildWorkbenchEditorFindScopeEffect(
  state: EditorState,
  inSelection: boolean
): StateEffect<Nullable<FindScope>> {
  if (!inSelection) return setFindScopeEffect.of(null)
  const selection = state.selection.main
  const scope = selection.empty ? state.doc.lineAt(selection.head) : selection
  return setFindScopeEffect.of({ from: scope.from, to: scope.to })
}

/**
 * 边打边找：选中从 `from` 往后的第一处匹配（后面没有就从头找），滚到视野里。焦点留在查找栏。
 * 没有匹配时不动选区。
 */
export function selectWorkbenchEditorFindMatchFrom(view: EditorView, from: number): void {
  const query = getSearchQuery(view.state)
  if (!query.valid) return
  const start = Math.min(from, view.state.doc.length)
  let next = query.getCursor(view.state, start).next()
  if (next.done) next = query.getCursor(view.state, 0, start).next()
  if (next.done) return
  view.dispatch({
    selection: EditorSelection.single(next.value.from, next.value.to),
    effects: EditorView.scrollIntoView(next.value.from, { y: 'center' }),
    userEvent: 'select.search',
  })
}

/** 数匹配：共几处、当前选区正好是第几处。 */
export function readWorkbenchEditorFindStatus(state: EditorState): WorkbenchEditorFindStatus {
  const query = getSearchQuery(state)
  if (!query.search) return EmptyWorkbenchEditorFindStatus
  if (!query.valid) return { ...EmptyWorkbenchEditorFindStatus, invalid: true }

  const selection = state.selection.main
  const cursor = query.getCursor(state)
  let total = 0
  let current = 0
  for (let next = cursor.next(); !next.done; next = cursor.next()) {
    total += 1
    if (next.value.from === selection.from && next.value.to === selection.to) current = total
    if (total >= MaxCountedMatches) return { total, current, limited: true, invalid: false }
  }
  return { total, current, limited: false, invalid: false }
}

/** ⌘F 时预填的查找词：选中了一行以内的文字就用它，否则用光标处的词；都没有就不预填。 */
export function readWorkbenchEditorFindSeed(state: EditorState): string | undefined {
  const selection = state.selection.main
  if (!selection.empty) {
    const text = state.sliceDoc(selection.from, selection.to)
    return text.includes('\n') ? undefined : text.slice(0, MaxSeedChars)
  }
  const word = state.wordAt(selection.head)
  return word ? state.sliceDoc(word.from, word.to) : undefined
}

export { searchPanelOpen as isWorkbenchEditorFindOpen }
