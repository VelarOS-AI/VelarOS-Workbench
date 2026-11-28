import { type Extension, StateEffect, StateField, type Text } from '@codemirror/state'
import { Direction, type EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view'

interface HighlightRange {
  from: number
  to: number
}

interface HighlightViewport {
  columns: number
  firstLine: number
  lastLine: number
}

const ColumnsPerStep = 16
const OverscanLines = 6
const ReserveLines = 1
const InitialViewport: HighlightViewport = { columns: 192, firstLine: 1, lastLine: Infinity }
const setHighlightViewport = StateEffect.define<HighlightViewport>()
const highlightViewport = StateField.define<HighlightViewport>({
  create: () => InitialViewport,
  update(value, transaction) {
    return transaction.effects.find((effect) => effect.is(setHighlightViewport))?.value ?? value
  },
})

function matchesViewport(left: HighlightViewport, right: HighlightViewport): boolean {
  return left.columns === right.columns && left.firstLine === right.firstLine &&
    left.lastLine === right.lastLine
}

/** Keep paint near the screen, in bands that remain stable while scrolling. */
export const workbenchHighlightViewportExtension: Extension = [
  highlightViewport,
  ViewPlugin.fromClass(
    class {
      private pending: HighlightViewport | null = null
      private refresh: ReturnType<typeof setTimeout> | null = null

      constructor(private readonly view: EditorView) {
        view.scrollDOM.addEventListener('scroll', this.measure, { passive: true })
        this.measure()
      }

      public update(update: ViewUpdate): void {
        if (
          update.heightChanged || (update.geometryChanged && !update.docChanged) ||
          update.transactions.some((transaction) => transaction.reconfigured)
        )
          this.measure()
      }

      public destroy(): void {
        if (this.refresh !== null) clearTimeout(this.refresh)
        this.view.scrollDOM.removeEventListener('scroll', this.measure)
      }

      private readonly measure = (): void => {
        this.view.requestMeasure({
          key: this,
          read: (view) => {
            const { clientWidth, clientHeight, scrollLeft, scrollTop } = view.scrollDOM
            if (clientWidth <= 0 || clientHeight <= 0) return InitialViewport

            const doc = view.state.doc
            const top = scrollTop * view.scaleY - view.documentPadding.top
            const first = doc.lineAt(view.lineBlockAtHeight(Math.max(0, top)).from).number
            const last = doc.lineAt(view.lineBlockAtHeight(top + clientHeight * view.scaleY).to).number
            const current = readHighlightViewport(view)
            const coversVisible = current.lastLine !== Infinity &&
              current.firstLine <= Math.max(1, first - ReserveLines) &&
              current.lastLine >= Math.min(doc.lines, last + ReserveLines)
            const firstLine = coversVisible ? current.firstLine : Math.max(1, first - OverscanLines)
            const lastLine = coversVisible ? current.lastLine : Math.min(doc.lines, last + OverscanLines)

            // Leave room for glyph width variance and keep an extra band ready for scrolling.
            const right = (clientWidth + Math.max(0, scrollLeft)) /
              Math.max(1, view.defaultCharacterWidth * 0.9)
            const columns = view.lineWrapping || view.textDirection === Direction.RTL
              ? Infinity
              : (Math.ceil(right / ColumnsPerStep) + 1) * ColumnsPerStep
            return { columns, firstLine, lastLine }
          },
          write: (viewport, view) => {
            this.pending = viewport
            if (this.refresh !== null || matchesViewport(readHighlightViewport(view), viewport)) return
            // The scroll frame can paint existing marks before the next band is installed.
            this.refresh = setTimeout(() => {
              this.refresh = null
              const latest = this.pending
              if (latest && !matchesViewport(readHighlightViewport(view), latest))
                view.dispatch({ effects: setHighlightViewport.of(latest) })
            }, 0)
          },
        })
      }
    }
  ),
]

function readHighlightViewport(view: EditorView): HighlightViewport {
  return view.state.field(highlightViewport, false) ?? InitialViewport
}

export function workbenchHighlightViewportChanged(update: ViewUpdate): boolean {
  return (
    update.viewportMoved ||
    update.startState.field(highlightViewport, false) !== update.state.field(highlightViewport, false)
  )
}

// Logical offsets are safe for left-to-right source. Allow full styling on
// lines that can contain RTL characters or explicit direction controls.
const BidirectionalSource =
  /[\p{M}\u0590-\u08ff\u200b-\u200f\u202a-\u202e\u2060-\u206f\ud800-\udfff\ufb1d-\ufeff\u{10000}-\u{10ffff}]/u

export function clipWorkbenchHighlightRanges(
  doc: Text,
  visible: readonly HighlightRange[],
  columns: number
): readonly HighlightRange[] {
  if (!Number.isFinite(columns)) return visible

  const clipped: HighlightRange[] = []
  for (const range of visible) {
    let from = range.from
    while (from < range.to) {
      const line = doc.lineAt(from)
      const lineEnd = Math.min(range.to, line.to)
      const limit = line.from + columns
      const to =
        lineEnd <= limit || BidirectionalSource.test(line.text)
          ? Math.min(range.to, line.to + 1)
          : limit
      if (from < to) {
        const previous = clipped.at(-1)
        if (previous?.to === from) previous.to = to
        else clipped.push({ from, to })
      }
      from = line.to + 1
    }
  }
  return clipped
}

interface CachedHighlightRanges {
  doc: Text
  viewport: HighlightViewport
  columns: number
  visible: readonly HighlightRange[]
  clipped: readonly HighlightRange[]
  ranges: readonly HighlightRange[]
}

const highlightRangesByView = new WeakMap<EditorView, CachedHighlightRanges>()

export function readWorkbenchHighlightRanges(view: EditorView): readonly HighlightRange[] {
  const doc = view.state.doc
  const viewport = readHighlightViewport(view)
  const { firstLine, lastLine } = viewport
  const columns = view.lineWrapping ? Infinity : viewport.columns
  const visible = view.visibleRanges
  const previous = highlightRangesByView.get(view)
  if (previous?.doc === doc && previous.viewport === viewport && previous.columns === columns && previous.visible === visible)
    return previous.ranges

  const from = doc.line(Math.min(firstLine, doc.lines)).from
  const to = doc.line(Math.min(lastLine, doc.lines)).to
  const clipped = visible.flatMap((range) => {
    const start = Math.max(range.from, from)
    const end = Math.min(range.to, to)
    return start < end ? [{ from: start, to: end }] : []
  })
  const ranges = previous?.doc === doc && previous.columns === columns &&
      previous.clipped.length === clipped.length && clipped.every((range, index) =>
        previous.clipped[index]?.from === range.from && previous.clipped[index]?.to === range.to)
    ? previous.ranges
    : clipWorkbenchHighlightRanges(doc, clipped, columns)
  highlightRangesByView.set(view, { doc, viewport, columns, visible, clipped, ranges })
  return ranges
}
