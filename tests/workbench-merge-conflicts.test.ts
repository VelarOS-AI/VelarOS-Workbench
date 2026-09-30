import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { history, undo } from '@codemirror/commands'
import { EditorState, type Transaction } from '@codemirror/state'
import { describe, test } from 'bun:test'

import {
  buildWorkbenchMergeConflictResolution,
  collectWorkbenchMergeConflictLineKinds,
  findWorkbenchMergeConflicts,
  isWorkbenchMergeConflictComparing,
  readWorkbenchMergeConflicts,
  toggleWorkbenchMergeConflictCompare,
  workbenchMergeConflictExtension,
} from '../src/renderer/src/models/editor/workbenchMergeConflicts'
import { scanWorkbenchMergeResolutions } from '../src/renderer/src/models/git/workbenchMergeResolution'
import type { WorkbenchOpenEditorTab } from '../src/renderer/src/types/workbenchTypes'

const Conflicted = [
  'before',
  '<<<<<<< HEAD',
  'ours 1',
  'shared',
  '=======',
  'theirs 1',
  'shared',
  '>>>>>>> feature',
  'between',
  '<<<<<<< HEAD',
  'ours 2',
  '||||||| base',
  'base 2',
  '=======',
  'theirs 2',
  '>>>>>>> feature',
  'after',
  '',
].join('\n')

function createState(doc: string, readOnly = false): EditorState {
  return EditorState.create({
    doc,
    extensions: [
      history(),
      EditorState.readOnly.of(readOnly),
      workbenchMergeConflictExtension((key) => key),
    ],
  })
}

/** 跑一次 undo 命令，拿回撤回之后的状态。 */
function undone(state: EditorState): EditorState {
  let next = state
  undo({
    state,
    dispatch: (transaction: Transaction) => {
      next = transaction.state
    },
  })
  return next
}

void describe('Workbench merge conflicts in the editor', () => {
  void test('finds two-way and diff3 blocks with their sections', () => {
    const state = createState(Conflicted)
    const blocks = findWorkbenchMergeConflicts(state.doc)
    assert.equal(blocks.length, 2)
    const [first, second] = blocks
    assert.equal(state.doc.sliceString(first.current.from, first.current.to), 'ours 1\nshared\n')
    assert.equal(state.doc.sliceString(first.incoming.from, first.incoming.to), 'theirs 1\nshared\n')
    assert.equal(first.base, null)
    assert.equal(
      state.doc.sliceString(first.from, first.to),
      '<<<<<<< HEAD\nours 1\nshared\n=======\ntheirs 1\nshared\n>>>>>>> feature\n'
    )
    assert.equal(state.doc.sliceString(second.current.from, second.current.to), 'ours 2\n')
    assert.ok(second.base)
    assert.equal(state.doc.sliceString(second.base.from, second.base.to), 'base 2\n')
    assert.equal(state.doc.sliceString(second.incoming.from, second.incoming.to), 'theirs 2\n')
    assert.deepEqual(readWorkbenchMergeConflicts(state), blocks)

    const kinds = collectWorkbenchMergeConflictLineKinds(state)
    assert.deepEqual(kinds.current, [3, 4, 11])
    assert.deepEqual(kinds.incoming, [6, 7, 15])
    assert.deepEqual(kinds.base, [13])
  })

  void test('ignores unfinished blocks and a lone ======= such as a Markdown heading', () => {
    const doc = createState(
      ['Title', '=======', '<<<<<<< HEAD', 'ours', '=======', 'theirs', 'no end marker', ''].join('\n')
    ).doc
    assert.deepEqual(findWorkbenchMergeConflicts(doc), [])
  })

  void test('blocks appear as soon as an edit completes them, and plain typing leaves none', () => {
    let state = createState('plain\ntext\n')
    state = state.update({ changes: { from: 0, insert: 'more ' } }).state
    assert.deepEqual(readWorkbenchMergeConflicts(state), [])

    // 粘贴进一整块冲突。
    state = state.update({
      changes: { from: state.doc.length, insert: '<<<<<<< HEAD\na\n=======\nb\n>>>>>>> x\n' },
    }).state
    assert.equal(readWorkbenchMergeConflicts(state).length, 1)

    // 结尾那一行原来多了个字，删掉之后才成块。
    let broken = createState('<<<<<<< HEAD\na\n=======\nb\nX>>>>>>> x\n')
    assert.deepEqual(readWorkbenchMergeConflicts(broken), [])
    const x = broken.doc.toString().indexOf('X>>>')
    broken = broken.update({ changes: { from: x, to: x + 1 } }).state
    assert.equal(readWorkbenchMergeConflicts(broken).length, 1)
  })

  void test('a block at the very end of the file without a final newline still counts', () => {
    const state = createState('<<<<<<< HEAD\na\n=======\nb\n>>>>>>> theirs')
    const [block] = findWorkbenchMergeConflicts(state.doc)
    assert.ok(block)
    assert.equal(block.to, state.doc.length)
    const accepted = state.update(buildWorkbenchMergeConflictResolution(state, block, 'incoming')).state
    assert.equal(accepted.doc.toString(), 'b\n')
  })

  void test('accepting a side replaces the whole block in one undoable step', () => {
    const state = createState(Conflicted)
    const [first, second] = readWorkbenchMergeConflicts(state)

    const current = state.update(buildWorkbenchMergeConflictResolution(state, first, 'current')).state
    assert.equal(
      current.doc.toString().split('between')[0],
      'before\nours 1\nshared\n'
    )
    assert.equal(readWorkbenchMergeConflicts(current).length, 1)
    assert.equal(undone(current).doc.toString(), Conflicted)

    const both = state.update(buildWorkbenchMergeConflictResolution(state, second, 'both')).state
    assert.match(both.doc.toString(), /between\nours 2\ntheirs 2\nafter\n$/)

    const incoming = state.update(buildWorkbenchMergeConflictResolution(state, first, 'incoming')).state
    const resolved = incoming.update(
      buildWorkbenchMergeConflictResolution(incoming, readWorkbenchMergeConflicts(incoming)[0], 'current')
    ).state
    assert.equal(resolved.doc.toString(), 'before\ntheirs 1\nshared\nbetween\nours 2\nafter\n')
    assert.equal(readWorkbenchMergeConflicts(resolved).length, 0)
    // 每一块是单独的一步：撤回一次只回到解决第二块之前。
    assert.equal(readWorkbenchMergeConflicts(undone(resolved)).length, 1)
  })

  void test('compare marks the lines only one side has and dims the lines both have', () => {
    const state = createState(Conflicted)
    const [first] = readWorkbenchMergeConflicts(state)
    const comparing = state.update(toggleWorkbenchMergeConflictCompare(first.from)).state
    assert.equal(isWorkbenchMergeConflictComparing(comparing, first.from), true)
    const kinds = collectWorkbenchMergeConflictLineKinds(comparing)
    assert.deepEqual(kinds.only, [3, 6])
    assert.deepEqual(kinds.same, [4, 7])

    // 在块前面打字：对比开关跟着块走。
    const typed = comparing.update({ changes: { from: 0, insert: 'typed\n' } }).state
    const [moved] = readWorkbenchMergeConflicts(typed)
    assert.equal(isWorkbenchMergeConflictComparing(typed, moved.from), true)
    const closed = typed.update(toggleWorkbenchMergeConflictCompare(moved.from)).state
    assert.equal(isWorkbenchMergeConflictComparing(closed, moved.from), false)
  })

  void test('offers to mark a file resolved once its saved version loses the markers', () => {
    const tab = (content: string): WorkbenchOpenEditorTab =>
      ({ path: 'a.ts', content, file: { content } }) as unknown as WorkbenchOpenEditorTab
    const conflicted = new Set(['a.ts'])

    const opened = scanWorkbenchMergeResolutions(new Map(), conflicted, [tab(Conflicted)])
    assert.deepEqual(opened.resolved, [])
    const saved = scanWorkbenchMergeResolutions(opened.markers, conflicted, [tab('resolved\n')])
    assert.deepEqual(saved.resolved, ['a.ts'])
    // 再存一次、或者打开时就已经没有标记：不再问。
    assert.deepEqual(scanWorkbenchMergeResolutions(saved.markers, conflicted, [tab('again\n')]).resolved, [])
    assert.deepEqual(scanWorkbenchMergeResolutions(new Map(), conflicted, [tab('clean\n')]).resolved, [])
    // git 里已经不是冲突了：不问。
    assert.deepEqual(scanWorkbenchMergeResolutions(opened.markers, new Set(), [tab('x\n')]).resolved, [])
  })

  void test('is wired into every file state the editor builds', () => {
    const editor = readFileSync(
      path.resolve(process.cwd(), 'src/renderer/src/components/editor/CodeMirrorEditor.tsx'),
      'utf8'
    )
    assert.match(
      editor,
      /const buildFileExtensions = [\s\S]*workbenchMergeConflictExtension\(\(key\) => tLatest\.current\(key\)\)/
    )
  })
})
