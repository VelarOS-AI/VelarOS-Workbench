import assert from 'node:assert/strict'

import { EditorSelection, EditorState } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import { describe, test } from 'bun:test'

import {
  hasWorkbenchMultilineTextSelection,
  isWorkbenchActiveLineSuppressed,
  revealWorkbenchActiveLine,
  suppressWorkbenchActiveLine,
} from '../src/renderer/src/models/editor/workbenchCodeMirrorActiveLine'

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

  void test('keeps a newly switched file visually idle until the editor is used', () => {
    const classNames = new Set<string>()
    const view = {
      dom: {
        classList: {
          add: (className: string) => classNames.add(className),
          contains: (className: string) => classNames.has(className),
          remove: (className: string) => classNames.delete(className),
        },
      },
    } as unknown as EditorView

    suppressWorkbenchActiveLine(view)
    assert.equal(isWorkbenchActiveLineSuppressed(view), true)

    revealWorkbenchActiveLine(view)
    assert.equal(isWorkbenchActiveLineSuppressed(view), false)
  })
})
