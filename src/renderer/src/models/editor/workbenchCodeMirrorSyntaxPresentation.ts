import { type HighlightStyle, syntaxTree } from '@codemirror/language'
import { type Extension, Prec, RangeSetBuilder, StateEffect } from '@codemirror/state'
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
} from '@codemirror/view'
import { highlightTree } from '@lezer/highlight'

import {
  readWorkbenchHighlightRanges,
  workbenchHighlightViewportChanged,
  workbenchHighlightViewportExtension,
} from './workbenchCodeMirrorHighlightViewport'

const SyntaxRefreshQuietPeriodMs = 100
const refreshSyntaxPresentation = StateEffect.define<void>()

/** Map existing colors during a keystroke. Walk the new tree after the text can paint. */
export function createWorkbenchSyntaxPresentation(style: HighlightStyle): Extension {
  return [
    style.module ? EditorView.styleModule.of(style.module) : [],
    workbenchHighlightViewportExtension,
    Prec.high(
      ViewPlugin.fromClass(
        class {
          decorations: DecorationSet = Decoration.none
          private tree: ReturnType<typeof syntaxTree>
          private ranges: ReturnType<typeof readWorkbenchHighlightRanges> | null = null
          private coveredTo = 0
          private readonly marks = new Map<string, Decoration>()
          private timer: ReturnType<typeof setTimeout> | null = null

          constructor(private readonly view: EditorView) {
            this.tree = syntaxTree(view.state)
            this.repaint()
          }

          public update(update: ViewUpdate): void {
            if (update.docChanged) {
              this.decorations = this.decorations.map(update.changes)
              this.coveredTo = update.changes.mapPos(this.coveredTo, 1)
              this.schedule()
            } else if (
              this.timer === null &&
              (workbenchHighlightViewportChanged(update) || syntaxTree(update.state) !== this.tree)
            ) {
              this.repaint()
            }
          }

          public destroy(): void {
            if (this.timer !== null) clearTimeout(this.timer)
          }

          private schedule(): void {
            if (this.timer !== null) clearTimeout(this.timer)
            this.timer = setTimeout(() => {
              this.timer = null
              const previous = this.decorations
              this.repaint()
              if (this.decorations !== previous)
                this.view.dispatch({ effects: refreshSyntaxPresentation.of() })
            }, SyntaxRefreshQuietPeriodMs)
          }

          private repaint(): void {
            const tree = syntaxTree(this.view.state)
            const ranges = readWorkbenchHighlightRanges(this.view)
            if (tree === this.tree && ranges === this.ranges) return
            const viewportEnd = ranges.at(-1)?.to ?? this.view.viewport.to
            if (
              ranges === this.ranges &&
              tree.length < viewportEnd &&
              tree.type === this.tree.type &&
              this.coveredTo >= viewportEnd
            )
              return

            const decorations = new RangeSetBuilder<Decoration>()
            for (const range of ranges) {
              highlightTree(
                tree,
                style,
                (from, to, classes) => {
                  let mark = this.marks.get(classes)
                  if (!mark) {
                    mark = Decoration.mark({ class: classes })
                    this.marks.set(classes, mark)
                  }
                  decorations.add(from, to, mark)
                },
                range.from,
                range.to
              )
            }
            this.decorations = decorations.finish()
            this.tree = tree
            this.ranges = ranges
            this.coveredTo = viewportEnd
          }
        },
        { decorations: (plugin) => plugin.decorations }
      )
    ),
  ]
}
