import assert from 'node:assert/strict'

import { EditorState } from '@codemirror/state'
import { describe, test } from 'bun:test'

import {
  collectWorkbenchGitChangeMarkers,
  computeWorkbenchGitLineChanges,
  recomputeWorkbenchGitChangesEffect,
  resolveWorkbenchFoldedGitChangeKind,
  setWorkbenchGitChangeBaseEffect,
  splitWorkbenchGitCompareLines,
  workbenchGitChangeGutterExtension,
} from '../src/renderer/src/models/editor/workbenchGitChangeGutter'

function changesBetween(base: string, current: string) {
  return computeWorkbenchGitLineChanges(
    splitWorkbenchGitCompareLines(base),
    splitWorkbenchGitCompareLines(current)
  )
}

function stateWithBase(doc: string, base: Nullable<string>): EditorState {
  return EditorState.create({ doc, extensions: [workbenchGitChangeGutterExtension] }).update({
    effects: setWorkbenchGitChangeBaseEffect.of(base),
  }).state
}

void describe('Workbench git change gutter: line changes against HEAD', () => {
  void test('an unchanged document has no changes', () => {
    assert.deepEqual(changesBetween('a\nb\nc\n', 'a\nb\nc\n'), [])
  })

  void test('added, modified and deleted lines each become their own run', () => {
    const base = 'one\ntwo\nthree\nfour\nfive\nsix\n'
    const current = 'one\ntwo\ninserted\nthree\nFOUR\nfive\n'
    assert.deepEqual(changesBetween(base, current), [
      { kind: 'added', fromLine: 3, toLine: 3 },
      { kind: 'modified', fromLine: 5, toLine: 5 },
      { kind: 'deleted', fromLine: 6, toLine: 6 },
    ])
  })

  void test('a modified run covers every line that replaced the old ones', () => {
    assert.deepEqual(changesBetween('a\nold\nz\n', 'a\nnew 1\nnew 2\nnew 3\nz\n'), [
      { kind: 'modified', fromLine: 2, toLine: 4 },
    ])
  })

  void test('line endings, a BOM and the final newline are not changes', () => {
    assert.deepEqual(changesBetween('﻿a\r\nb\r\n', 'a\nb'), [])
    assert.deepEqual(changesBetween('a\nb', 'a\nb\n'), [])
  })

  void test('a blank line added at the end of the file is an added line', () => {
    assert.deepEqual(changesBetween('a\n', 'a\n\n'), [{ kind: 'added', fromLine: 2, toLine: 2 }])
  })

  void test('an empty file in HEAD makes every line added', () => {
    assert.deepEqual(changesBetween('', 'x\ny\n'), [{ kind: 'added', fromLine: 1, toLine: 2 }])
  })

  void test('lines deleted before the first line sit above line 1', () => {
    assert.deepEqual(changesBetween('a\nb\nc\n', 'b\nc\n'), [
      { kind: 'deleted', fromLine: 0, toLine: 0 },
    ])
    assert.deepEqual(changesBetween('a\nb\n', ''), [{ kind: 'deleted', fromLine: 0, toLine: 0 }])
  })

  void test('changes at both ends of a long file stay two separate runs', () => {
    const base = Array.from({ length: 5_000 }, (_, index) => `line ${index + 1}`)
    const current = [...base]
    current[9] = 'changed near the top'
    current[4_989] = 'changed near the bottom'
    assert.deepEqual(computeWorkbenchGitLineChanges(base, current), [
      { kind: 'modified', fromLine: 10, toLine: 10 },
      { kind: 'modified', fromLine: 4_990, toLine: 4_990 },
    ])
  })

  void test('a rewrite too large to diff line by line is marked as one modified run', () => {
    const base = Array.from({ length: 6_000 }, (_, index) => `old ${index}`)
    const current = Array.from({ length: 6_000 }, (_, index) =>
      index % 2 === 0 ? `old ${index}` : `new ${index}`
    )
    const startedAt = performance.now()
    const changes = computeWorkbenchGitLineChanges(base, current)
    assert.ok(performance.now() - startedAt < 2_000, 'the diff budget keeps the editor responsive')
    assert.deepEqual(changes, [{ kind: 'modified', fromLine: 2, toLine: 6_000 }])
  })
})

void describe('Workbench git change gutter: editor markers', () => {
  void test('markers land on the changed lines once a HEAD version arrives', () => {
    const state = stateWithBase('a\nB\nc\nd\n', 'a\nb\nc\n')
    assert.deepEqual(collectWorkbenchGitChangeMarkers(state), [
      { line: 2, kind: 'modified' },
      { line: 4, kind: 'added' },
    ])
  })

  void test('deletions mark the edge of the line they happened next to', () => {
    assert.deepEqual(collectWorkbenchGitChangeMarkers(stateWithBase('a\nc\n', 'a\nb\nc\n')), [
      { line: 1, kind: 'deleted' },
    ])
    assert.deepEqual(collectWorkbenchGitChangeMarkers(stateWithBase('b\nc\n', 'a\nb\nc\n')), [
      { line: 1, kind: 'deleted-top' },
    ])
  })

  void test('typing moves the markers along and a recompute settles them', () => {
    let state = stateWithBase('a\nB\nc\n', 'a\nb\nc\n')
    assert.deepEqual(collectWorkbenchGitChangeMarkers(state), [{ line: 2, kind: 'modified' }])

    state = state.update({ changes: { from: 0, insert: 'new first line\n' } }).state
    assert.deepEqual(
      collectWorkbenchGitChangeMarkers(state),
      [{ line: 3, kind: 'modified' }],
      'before the recompute the existing marker only follows the edit'
    )

    state = state.update({ effects: recomputeWorkbenchGitChangesEffect.of(null) }).state
    assert.deepEqual(collectWorkbenchGitChangeMarkers(state), [
      { line: 1, kind: 'added' },
      { line: 3, kind: 'modified' },
    ])

    state = state.update({ changes: { from: 0, to: state.doc.line(3).to + 1 } }).state
    state = state.update({ effects: recomputeWorkbenchGitChangesEffect.of(null) }).state
    assert.deepEqual(collectWorkbenchGitChangeMarkers(state), [{ line: 1, kind: 'deleted-top' }])
  })

  void test('a folded block shows the changes hidden inside it on its first line', () => {
    const state = stateWithBase('import a\nimport B\nimport c\ncode\n', 'import a\nimport b\nimport c\ncode\n')
    const doc = state.doc
    assert.equal(
      resolveWorkbenchFoldedGitChangeKind(state, doc.line(1).from, doc.line(3).to),
      'modified'
    )
    assert.equal(
      resolveWorkbenchFoldedGitChangeKind(state, doc.line(1).from, doc.line(1).to),
      null,
      'a line that is not folded has nothing hidden'
    )
    assert.equal(
      resolveWorkbenchFoldedGitChangeKind(state, doc.line(3).from, doc.line(4).to),
      null,
      'no change inside the fold'
    )

    const mixed = stateWithBase('a\nB\nc\nnew\nd\n', 'a\nb\nc\nd\n')
    assert.deepEqual(collectWorkbenchGitChangeMarkers(mixed), [
      { line: 2, kind: 'modified' },
      { line: 4, kind: 'added' },
    ])
    assert.equal(
      resolveWorkbenchFoldedGitChangeKind(mixed, mixed.doc.line(1).from, mixed.doc.line(4).to),
      'modified',
      'several kinds of change folded together read as modified'
    )
    assert.equal(
      resolveWorkbenchFoldedGitChangeKind(mixed, mixed.doc.line(3).from, mixed.doc.line(5).to),
      'added'
    )
  })

  void test('no HEAD version (a new file, or not a repository) means no markers', () => {
    let state = stateWithBase('a\nB\n', 'a\nb\n')
    assert.equal(collectWorkbenchGitChangeMarkers(state).length, 1)

    state = state.update({ effects: setWorkbenchGitChangeBaseEffect.of(null) }).state
    assert.deepEqual(collectWorkbenchGitChangeMarkers(state), [])

    state = state.update({ changes: { from: 0, insert: 'typed\n' } }).state
    state = state.update({ effects: recomputeWorkbenchGitChangesEffect.of(null) }).state
    assert.deepEqual(collectWorkbenchGitChangeMarkers(state), [])
  })
})
