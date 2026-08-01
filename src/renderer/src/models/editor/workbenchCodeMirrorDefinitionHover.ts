import { type Extension, RangeSetBuilder, StateEffect, StateField } from '@codemirror/state'
import { Decoration, type DecorationSet, EditorView } from '@codemirror/view'

export interface WorkbenchDefinitionHoverRange {
  from: number
  to: number
}

const workbenchDefinitionHoverMark = Decoration.mark({
  class: 'cm-workbenchDefinitionHoverLink',
})

export const setWorkbenchDefinitionHoverRange =
  StateEffect.define<Nullable<WorkbenchDefinitionHoverRange>>()

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

export const workbenchDefinitionHoverExtension: Extension = [workbenchDefinitionHoverField]
