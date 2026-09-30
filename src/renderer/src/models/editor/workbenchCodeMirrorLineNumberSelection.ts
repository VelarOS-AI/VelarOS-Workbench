import {
  type EditorState,
  type Extension,
  Facet,
  RangeSet,
  RangeSetBuilder,
  StateEffect,
  StateField,
} from '@codemirror/state'
import {
  Decoration,
  type DecorationSet,
  EditorView,
  gutterLineClass,
  GutterMarker,
  lineNumbers,
} from '@codemirror/view'

class WorkbenchLineNumberMarker extends GutterMarker {
  public override elementClass = 'cm-workbenchLineNumberMarkedGutterLine'

  public override eq(other: GutterMarker): boolean {
    return other instanceof WorkbenchLineNumberMarker
  }
}

const workbenchLineNumberMarker = new WorkbenchLineNumberMarker()
const workbenchLineNumberMarkerLine = Decoration.line({
  class: 'cm-workbenchLineNumberMarkerLine',
})

export const toggleWorkbenchLineNumberMarker = StateEffect.define<number>()

/**
 * 别的扩展接管行号上的点击：JavaScript / TypeScript 文件里点行号是下断点（见 `workbenchBreakpointGutter.ts`）。
 * 有人接了（返回 true）就不再打这里的标记。`line` 是行号，从 1 起。
 */
export const workbenchLineNumberClickFacet = Facet.define<
  (view: EditorView, line: number) => boolean
>()

export function workbenchLineNumberToDocumentPosition(
  state: EditorState,
  lineNumber: number
): number {
  return state.doc.line(Math.min(Math.max(1, lineNumber), state.doc.lines)).from
}

export function buildWorkbenchLineNumberMarkerSet(
  state: EditorState,
  lineNumbersToMark: readonly number[]
): RangeSet<GutterMarker> {
  const positions = Array.from(
    new Set(
      lineNumbersToMark.map((lineNumber) =>
        workbenchLineNumberToDocumentPosition(state, lineNumber)
      )
    )
  ).sort((left, right) => left - right)
  const builder = new RangeSetBuilder<GutterMarker>()

  for (const position of positions) {
    builder.add(position, position, workbenchLineNumberMarker)
  }

  return builder.finish()
}

export function collectWorkbenchLineNumberMarkerLines(state: EditorState): number[] {
  const markers = state.field(workbenchLineNumberMarkerField, false)
  if (!markers) return []

  const lines: number[] = []
  markers.between(0, state.doc.length, (from, _to, marker) => {
    if (marker.eq(workbenchLineNumberMarker)) {
      lines.push(state.doc.lineAt(from).number)
    }
  })

  return lines
}

export function buildWorkbenchLineNumberHighlightDecorations(state: EditorState): DecorationSet {
  const markers = state.field(workbenchLineNumberMarkerField, false)
  const builder = new RangeSetBuilder<Decoration>()
  if (!markers) return builder.finish()

  markers.between(0, state.doc.length, (from, _to, marker) => {
    if (marker.eq(workbenchLineNumberMarker)) {
      builder.add(from, from, workbenchLineNumberMarkerLine)
    }
  })

  return builder.finish()
}

function hasWorkbenchLineNumberMarker(markers: RangeSet<GutterMarker>, position: number): boolean {
  let found = false
  markers.between(position, position, (from, _to, marker) => {
    if (from === position && marker.eq(workbenchLineNumberMarker)) {
      found = true
      return false
    }
    return undefined
  })
  return found
}

function hasWorkbenchLineNumberHighlight(decorations: DecorationSet, position: number): boolean {
  let found = false
  decorations.between(position, position, (from, _to, decoration) => {
    if (from === position && decoration === workbenchLineNumberMarkerLine) {
      found = true
      return false
    }
    return undefined
  })
  return found
}

export const workbenchLineNumberMarkerField = StateField.define<RangeSet<GutterMarker>>({
  create() {
    return RangeSet.empty
  },
  update(markers, transaction) {
    let nextMarkers = markers.map(transaction.changes)

    for (const effect of transaction.effects) {
      if (!effect.is(toggleWorkbenchLineNumberMarker)) continue

      const position = workbenchLineNumberToDocumentPosition(transaction.state, effect.value)
      if (hasWorkbenchLineNumberMarker(nextMarkers, position)) {
        nextMarkers = nextMarkers.update({
          filter: (from, _to, marker) => from !== position || !marker.eq(workbenchLineNumberMarker),
        })
      } else {
        nextMarkers = nextMarkers.update({
          add: [workbenchLineNumberMarker.range(position)],
          sort: true,
        })
      }
    }

    return nextMarkers
  },
  provide: (field) => gutterLineClass.from(field),
})

export const workbenchLineNumberHighlightField = StateField.define<DecorationSet>({
  create(state) {
    return buildWorkbenchLineNumberHighlightDecorations(state)
  },
  update(decorations, transaction) {
    let nextDecorations = decorations.map(transaction.changes)

    for (const effect of transaction.effects) {
      if (!effect.is(toggleWorkbenchLineNumberMarker)) continue

      const position = workbenchLineNumberToDocumentPosition(transaction.state, effect.value)
      if (hasWorkbenchLineNumberHighlight(nextDecorations, position)) {
        nextDecorations = nextDecorations.update({
          filter: (from, _to, decoration) =>
            from !== position || decoration !== workbenchLineNumberMarkerLine,
        })
      } else {
        nextDecorations = nextDecorations.update({
          add: [workbenchLineNumberMarkerLine.range(position)],
          sort: true,
        })
      }
    }

    return nextDecorations
  },
  provide: (field) => EditorView.decorations.from(field),
})

function lineNumberFromGutterLine(view: EditorView, line: { from: number }): number {
  return view.state.doc.lineAt(line.from).number
}

function handleLineNumberPointerDown(
  view: EditorView,
  line: { from: number },
  event: MouseEvent
): boolean {
  if (event.button !== 0 || event.defaultPrevented) return false
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return false

  const lineNumber = lineNumberFromGutterLine(view, line)
  const handled = view.state
    .facet(workbenchLineNumberClickFacet)
    .some((handler) => handler(view, lineNumber))
  if (!handled) {
    view.dispatch({
      effects: toggleWorkbenchLineNumberMarker.of(lineNumber),
      userEvent: 'gutter.marker.toggle',
    })
  }
  view.focus()
  event.preventDefault()
  return true
}

/** 带断点式点击标记的行号 gutter。 */
export const workbenchLineNumbersExtension: Extension = [
  workbenchLineNumberMarkerField,
  workbenchLineNumberHighlightField,
  lineNumbers({
    domEventHandlers: {
      mousedown(view, line, event) {
        if (!(event instanceof MouseEvent)) return false
        return handleLineNumberPointerDown(view, line, event)
      },
    },
  }),
]
