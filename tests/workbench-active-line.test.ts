import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { EditorSelection, EditorState } from '@codemirror/state'

import { hasWorkbenchMultilineTextSelection } from '../src/renderer/src/models/editor/workbenchCodeMirrorActiveLine'
import { resolveWorkbenchExternalValueSyncSelection } from '../src/renderer/src/models/editor/workbenchCodeMirrorExternalSync'

function stateWithSelection(anchor: number, head: number): EditorState {
  return EditorState.create({
    doc: 'first line\nsecond line\nthird line',
    selection: { anchor, head },
  })
}

void describe('Workbench active-line visibility', () => {
  void test('keeps the current line for a cursor and a same-line text selection', () => {
    assert.equal(hasWorkbenchMultilineTextSelection(stateWithSelection(3, 3)), false)
    assert.equal(hasWorkbenchMultilineTextSelection(stateWithSelection(1, 8)), false)
  })

  void test('suppresses the single current-line treatment for a multiline selection', () => {
    assert.equal(hasWorkbenchMultilineTextSelection(stateWithSelection(3, 18)), true)
    assert.equal(hasWorkbenchMultilineTextSelection(stateWithSelection(18, 3)), true)
  })

  void test('uses one policy for multiple selections when any range crosses lines', () => {
    const state = EditorState.create({
      doc: 'first line\nsecond line\nthird line',
      extensions: [EditorState.allowMultipleSelections.of(true)],
      selection: EditorSelection.create([
        EditorSelection.cursor(2),
        EditorSelection.range(14, 28),
      ]),
    })

    assert.equal(hasWorkbenchMultilineTextSelection(state), true)
  })

  void test('resets the cursor for a different file but preserves it for same-file updates', () => {
    const state = stateWithSelection(14, 18)

    assert.deepEqual(
      resolveWorkbenchExternalValueSyncSelection(state, 40, true).main,
      EditorSelection.cursor(0)
    )
    assert.deepEqual(
      resolveWorkbenchExternalValueSyncSelection(state, 16, false).main,
      EditorSelection.range(14, 16)
    )
  })
})
