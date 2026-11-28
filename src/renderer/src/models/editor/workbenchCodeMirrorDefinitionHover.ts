import { type Extension, RangeSetBuilder, StateEffect, StateField } from '@codemirror/state'
import { closeHoverTooltips, Decoration, type DecorationSet, EditorView, hasHoverTooltips } from '@codemirror/view'

export interface WorkbenchDefinitionHoverRange {
  from: number
  to: number
}

const workbenchDefinitionHoverMark = Decoration.mark({
  class: 'cm-workbenchDefinitionHoverLink',
})

export const setWorkbenchDefinitionHoverRange =
  StateEffect.define<Nullable<WorkbenchDefinitionHoverRange>>()

const editorsAwaitingPointerMovement = new WeakSet<EditorView>()
const editorsOutsidePointer = new WeakSet<EditorView>()
const lastPointerMoveByEditor = new WeakMap<EditorView, number>()
export const WorkbenchHoverPrefetchDelayMs = 200
const WorkbenchHoverDisplayDelayMs = 1200

export function clearWorkbenchEditorHover(view: EditorView): void {
  // A pending CodeMirror hover can restart after a transaction using its previous pointer position.
  editorsAwaitingPointerMovement.add(view)
  if ((view.state.field(workbenchDefinitionHoverField, false)?.size ?? 0) > 0 || hasHoverTooltips(view.state))
    view.dispatch({ effects: [setWorkbenchDefinitionHoverRange.of(null), closeHoverTooltips] })
}

export function resumeWorkbenchEditorHover(view: EditorView): void {
  editorsAwaitingPointerMovement.delete(view)
}

export function isWorkbenchEditorHoverSuppressed(view: EditorView): boolean {
  return (
    editorsAwaitingPointerMovement.has(view) ||
    editorsOutsidePointer.has(view) ||
    view.state.selection.ranges.some((range) => !range.empty)
  )
}

export function waitForWorkbenchEditorHoverDelay(view: EditorView): Promise<void> {
  const now = performance.now()
  const pointerMove = lastPointerMoveByEditor.get(view) ?? now - WorkbenchHoverPrefetchDelayMs
  return new Promise((resolve) => {
    setTimeout(resolve, Math.max(0, WorkbenchHoverDisplayDelayMs - (now - pointerMove)))
  })
}

export function buildWorkbenchDefinitionHoverDecorations(
  range: Nullable<WorkbenchDefinitionHoverRange>
): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>()
  if (!range || range.to <= range.from) return builder.finish()

  builder.add(range.from, range.to, workbenchDefinitionHoverMark)
  return builder.finish()
}

export const workbenchDefinitionHoverField = StateField.define<DecorationSet>({
  create() {
    return Decoration.none
  },
  update(decorations, transaction) {
    let nextDecorations = decorations.map(transaction.changes)

    for (const effect of transaction.effects) {
      if (effect.is(setWorkbenchDefinitionHoverRange)) {
        nextDecorations = buildWorkbenchDefinitionHoverDecorations(effect.value)
      }
    }

    return nextDecorations
  },
  provide: (field) => EditorView.decorations.from(field),
})

export const workbenchDefinitionHoverExtension: Extension = [
  workbenchDefinitionHoverField,
  EditorView.domEventObservers({
    mousemove: (_event, view) => {
      resumeWorkbenchEditorHover(view)
      editorsOutsidePointer.delete(view)
      lastPointerMoveByEditor.set(view, performance.now())
    },
    mouseleave: (_event, view) => {
      editorsOutsidePointer.add(view)
    },
  }),
  EditorView.updateListener.of((update) => {
    // Don't start new hover requests at a stationary pointer while the user edits below it.
    if (update.docChanged) editorsAwaitingPointerMovement.add(update.view)
  }),
]
