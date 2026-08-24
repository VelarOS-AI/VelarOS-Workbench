import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { EditorSelection, EditorState } from '@codemirror/state'

import { hasWorkbenchMultilineTextSelection } from '../src/renderer/src/models/editor/workbenchCodeMirrorActiveLine'

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
})
