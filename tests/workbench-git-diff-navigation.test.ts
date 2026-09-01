import assert from 'node:assert/strict'

import { describe, test } from 'bun:test'

import {
  collectWorkbenchDiffChangeAnchors,
  type WorkbenchUnifiedDiffRow,
} from '../src/renderer/src/models/git/workbenchGitDiffModel'

function row(
  id: string,
  kind: WorkbenchUnifiedDiffRow['kind']
): WorkbenchUnifiedDiffRow {
  return { id, kind, oldLine: null, newLine: null, marker: '', text: id }
}

void describe('Workbench Git diff navigation', () => {
  void test('locates the first row of each change block for initial and arrow navigation', () => {
    const rows = [
      row('context-1', 'context'),
      row('delete-1', 'deletion'),
      row('add-1', 'addition'),
      row('context-2', 'context'),
      row('add-2', 'addition'),
    ]

    assert.deepEqual(collectWorkbenchDiffChangeAnchors(rows), [2, 5])
  })
})
