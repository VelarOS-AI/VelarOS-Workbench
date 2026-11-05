import { SearchCursor } from '@codemirror/search'
import { type EditorState, type Extension, RangeSetBuilder, StateField } from '@codemirror/state'
import { Decoration, type DecorationSet, EditorView } from '@codemirror/view'

import { isEmpty } from '@velaros-ai/velaros/core'

const searchMatchMark = Decoration.mark({ class: 'cm-workbenchHistorySearchMatch' })

function buildMatches(state: EditorState, query: string): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>()
  const cursor = new SearchCursor(state.doc, query, 0, state.doc.length, (value) =>
    value.toLowerCase()
  )
  while (!cursor.next().done) {
    const { from, to } = cursor.value
    if (to > from) builder.add(from, to, searchMatchMark)
  }
  return builder.finish()
}

/** 只读代码预览里高亮某个字面量搜索词（大小写不敏感）的所有出现。 */
export function buildReadOnlyCodeSearchHighlight(query: string): Extension {
  const normalized = query.trim()
  if (isEmpty(normalized)) return []

  return StateField.define<DecorationSet>({
    create: (state) => buildMatches(state, normalized),
    update: (value, tr) => (tr.docChanged ? buildMatches(tr.state, normalized) : value),
    provide: (field) => EditorView.decorations.from(field),
  })
}
