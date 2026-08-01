import { setDiagnostics } from '@codemirror/lint'
import type { EditorSelection, EditorState, TransactionSpec } from '@codemirror/state'

interface BuildWorkbenchExternalValueSyncTransactionOptions {
  state: EditorState
  value: string
  selection: EditorSelection
  annotations?: TransactionSpec['annotations']
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
