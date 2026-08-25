import type { EditorState, Extension } from '@codemirror/state'
import { RangeSet } from '@codemirror/state'
import {
  Decoration,
  type DecorationSet,
  EditorView,
  gutterLineClass,
  GutterMarker,
  ViewPlugin,
  type ViewUpdate,
} from '@codemirror/view'

const workbenchActiveLineSuppressedClass = 'cm-workbenchActiveLineSuppressed'

/** 文件刚切换时暂隐合成光标产生的当前行，首次真实编辑交互后恢复。 */
export function suppressWorkbenchActiveLine(view: EditorView): void {
  view.dom.classList.add(workbenchActiveLineSuppressedClass)
}

export function revealWorkbenchActiveLine(view: EditorView): void {
  view.dom.classList.remove(workbenchActiveLineSuppressedClass)
}

/** 跨行文本选区已经提供了足够清晰的视觉范围，不再叠加单独的当前行。 */
export function hasWorkbenchMultilineTextSelection(state: EditorState): boolean {
  return state.selection.ranges.some((range) => {
    if (range.empty) return false

    return state.doc.lineAt(range.from).number !== state.doc.lineAt(range.to).number
  })
}

const activeLineDecoration = Decoration.line({ class: 'cm-activeLine' })

function buildActiveLineDecorations(view: EditorView): DecorationSet {
  if (hasWorkbenchMultilineTextSelection(view.state)) return Decoration.none

  const lineStarts = new Set<number>()
  for (const range of view.state.selection.ranges) {
    lineStarts.add(view.state.doc.lineAt(range.head).from)
  }

  return Decoration.set(
    [...lineStarts]
      .sort((left, right) => left - right)
      .map((lineStart) => activeLineDecoration.range(lineStart))
  )
}

const activeLineContentExtension = ViewPlugin.fromClass(
  class {
    public decorations: DecorationSet

    constructor(view: EditorView) {
      this.decorations = buildActiveLineDecorations(view)
    }

    public update(update: ViewUpdate): void {
      if (update.docChanged || update.selectionSet) {
        this.decorations = buildActiveLineDecorations(update.view)
      }
    }
  },
  { decorations: (value) => value.decorations }
)

class WorkbenchActiveLineGutterMarker extends GutterMarker {
  public readonly elementClass = 'cm-activeLineGutter'
}

const activeLineGutterMarker = new WorkbenchActiveLineGutterMarker()
const activeLineGutterExtension = gutterLineClass.compute(['selection'], (state) => {
  if (hasWorkbenchMultilineTextSelection(state)) return RangeSet.empty

  const lineStarts = new Set<number>()
  for (const range of state.selection.ranges) {
    lineStarts.add(state.doc.lineAt(range.head).from)
  }

  return RangeSet.of(
    [...lineStarts]
      .sort((left, right) => left - right)
      .map((lineStart) => activeLineGutterMarker.range(lineStart))
  )
})

const activeLineInteractionExtension = EditorView.domEventHandlers({
  mousedown: (_event, view) => {
    revealWorkbenchActiveLine(view)
    return false
  },
  touchstart: (_event, view) => {
    revealWorkbenchActiveLine(view)
    return false
  },
  keydown: (event, view) => {
    if (!['Alt', 'Control', 'Meta', 'Shift'].includes(event.key)) {
      revealWorkbenchActiveLine(view)
    }
    return false
  },
})

/** 当前行和当前行号使用同一个选区策略，避免两处视觉状态分叉。 */
export const workbenchActiveLineExtension: Extension = [
  activeLineContentExtension,
  activeLineGutterExtension,
  activeLineInteractionExtension,
]
