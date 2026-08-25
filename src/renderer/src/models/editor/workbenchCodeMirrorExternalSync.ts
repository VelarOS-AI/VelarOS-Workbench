import { setDiagnostics } from '@codemirror/lint'
import { EditorSelection, type EditorState, type TransactionSpec } from '@codemirror/state'

interface BuildWorkbenchExternalValueSyncTransactionOptions {
  state: EditorState
  value: string
  selection: EditorSelection
  annotations?: TransactionSpec['annotations']
}

function clampExternalSelectionPosition(position: number, docLength: number): number {
  return Math.min(Math.max(0, position), docLength)
}

export function resolveWorkbenchExternalValueSyncSelection(
  state: EditorState,
  nextDocLength: number,
  fileChanged: boolean
): EditorSelection {
  if (fileChanged) return EditorSelection.create([EditorSelection.cursor(0)])

  const selection = state.selection.main
  return EditorSelection.create([
    EditorSelection.range(
      clampExternalSelectionPosition(selection.anchor, nextDocLength),
      clampExternalSelectionPosition(selection.head, nextDocLength)
    ),
  ])
}

export function buildWorkbenchExternalValueSyncTransaction({
  state,
  value,
  selection,
  annotations,
}: BuildWorkbenchExternalValueSyncTransactionOptions): TransactionSpec {
  const currentValue = state.doc.toString()
  const clearDiagnostics = setDiagnostics(state, [])

  return {
    changes: { from: 0, to: currentValue.length, insert: value },
    selection,
    annotations,
    effects: clearDiagnostics.effects,
  }
}
