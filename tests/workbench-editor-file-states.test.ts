import { history, redo, undo, undoDepth } from '@codemirror/commands'
import { codeFolding, foldedRanges, foldEffect } from '@codemirror/language'
import { Annotation, EditorState, type StateCommand, StateEffect, type Transaction } from '@codemirror/state'
import { describe, expect, test } from 'bun:test'

import { buildWorkbenchExternalValueSyncTransaction } from '../src/renderer/src/models/editor/workbenchCodeMirrorExternalSync'
import {
  findWorkbenchCodeMirrorLanguage,
  resolveWorkbenchCodeMirrorLanguage,
} from '../src/renderer/src/models/editor/workbenchCodeMirrorLanguage'
import { buildWorkbenchReadOnlyExtensions } from '../src/renderer/src/models/editor/workbenchCodeMirrorReadOnly'
import { rebuildWorkbenchEditorFileState } from '../src/renderer/src/models/editor/workbenchEditorFileStateRebuild'
import {
  type WorkbenchEditorFileState,
  workbenchEditorFileStateKey,
  WorkbenchEditorFileStates,
} from '../src/renderer/src/models/editor/workbenchEditorFileStates'

const external = Annotation.define<boolean>()
const scrollPlaceholder = StateEffect.define<null>()
const extensions = [history(), codeFolding()]

function fileState(doc: string): EditorState {
  return EditorState.create({ doc, extensions })
}

function run(state: EditorState, command: StateCommand): EditorState {
  let next = state
  command({ state, dispatch: (tr: Transaction) => (next = tr.state) })
  return next
}

function type(state: EditorState, at: number, text: string): EditorState {
  return state.update({
    changes: { from: at, insert: text },
    selection: { anchor: at + text.length },
    userEvent: 'input.type',
  }).state
}

function saved(state: EditorState, owner: object = {}): WorkbenchEditorFileState {
  return { state, scroll: scrollPlaceholder.of(null), activeLineSuppressed: false, owner }
}

describe('per-file editor states', () => {
  test('undo in a newly shown file cannot bring back another file’s text', () => {
    const store = new WorkbenchEditorFileStates()
    const index = type(fileState('export const a = 1\n'), 0, '// edited\n')
    store.save(workbenchEditorFileStateKey('/p', 'index.ts'), saved(index))

    // 换到 math.ts：它有自己的状态，没有撤销历史。
    const math = fileState('export const sum = 2\n')
    expect(undoDepth(math)).toBe(0)
    expect(run(math, undo).doc.toString()).toBe('export const sum = 2\n')

    // 换回 index.ts：撤销的还是它自己的改动。
    const back = store.take(workbenchEditorFileStateKey('/p', 'index.ts'))!.state
    expect(run(back, undo).doc.toString()).toBe('export const a = 1\n')
  })

  test('the store hands a state back once, keeps the most recent files and drops closed ones', () => {
    const store = new WorkbenchEditorFileStates()
    store.save('a', saved(fileState('a')))
    expect(store.take('a')?.state.doc.toString()).toBe('a')
    expect(store.take('a')).toBeUndefined()

    for (let index = 0; index < 70; index += 1) store.save(`f${index}`, saved(fileState(`${index}`)))
    expect(store.size).toBe(64)
    expect(store.take('f0')).toBeUndefined()
    expect(store.take('f69')?.state.doc.toString()).toBe('69')

    store.retain(['f10', 'f11'])
    expect(store.size).toBe(2)
    expect(store.take('f12')).toBeUndefined()
    expect(store.take('f10')).toBeDefined()
  })

  test('a state left by another editor instance is rebuilt with its undo history, selection and folds', () => {
    let state = type(fileState('import a from "a"\nimport b from "b"\n\nconst c = a + b\n'), 0, '// x\n')
    state = state.update({ effects: foldEffect.of({ from: 23, to: 40 }) }).state
    state = state.update({ selection: { anchor: 50 } }).state

    const rebuilt = rebuildWorkbenchEditorFileState(state, extensions)
    expect(rebuilt.doc.toString()).toBe(state.doc.toString())
    expect(rebuilt.selection.main.head).toBe(50)
    const folds: Array<[number, number]> = []
    foldedRanges(rebuilt).between(0, rebuilt.doc.length, (from, to) => {
      folds.push([from, to])
    })
    expect(folds).toEqual([[23, 40]])
    expect(run(rebuilt, undo).doc.toString()).toBe(
      'import a from "a"\nimport b from "b"\n\nconst c = a + b\n'
    )
  })
})

describe('external changes to the open file', () => {
  test('apply as minimal edits so the cursor stays where it was', () => {
    let state = fileState('const a = 1\nconst b = 2\nconst c = 3\n')
    state = state.update({ selection: { anchor: 20 } }).state
    const next = state.update(
      buildWorkbenchExternalValueSyncTransaction(state, 'const a = 10\nconst b = 2\nconst c = 3\n', external.of(true))
    ).state
    expect(next.doc.toString()).toBe('const a = 10\nconst b = 2\nconst c = 3\n')
    expect(next.selection.main.head).toBe(21)
  })

  test('form their own undo step, separate from typing right before them', () => {
    let state = type(fileState('let x = 1\n'), 9, '0')
    state = state.update(
      buildWorkbenchExternalValueSyncTransaction(state, 'let x = 10\nlet y = 2\n', external.of(true))
    ).state
    state = run(state, undo)
    expect(state.doc.toString()).toBe('let x = 10\n')
    state = run(state, undo)
    expect(state.doc.toString()).toBe('let x = 1\n')
    expect(run(state, redo).doc.toString()).toBe('let x = 10\n')
  })
})

describe('read-only files', () => {
  test('block typing, completion and paste but still take external updates', () => {
    const state = EditorState.create({
      doc: 'const a = 1',
      extensions: buildWorkbenchReadOnlyExtensions(true, false),
    })
    expect(state.readOnly).toBe(true)
    for (const userEvent of ['input.type', 'input.complete', 'input.paste', 'delete.backward', 'move.drop'])
      expect(state.update({ changes: { from: 0, insert: 'x' }, userEvent }).state.doc.toString()).toBe(
        'const a = 1'
      )
    expect(state.update({ changes: { from: 0, insert: '// ' } }).state.doc.toString()).toBe('// const a = 1')
  })
})

describe('language instances', () => {
  test('are shared per language so a restored file keeps its parsed syntax', () => {
    for (const path of ['a.ts', 'b.md', 'c.sh', 'Dockerfile', 'd.toml', '.env', 'e.json'])
      expect(findWorkbenchCodeMirrorLanguage(resolveWorkbenchCodeMirrorLanguage(path, '').extension)).toBe(
        findWorkbenchCodeMirrorLanguage(resolveWorkbenchCodeMirrorLanguage(`other/${path}`, '').extension)
      )
    expect(findWorkbenchCodeMirrorLanguage(resolveWorkbenchCodeMirrorLanguage('a.ts', '').extension)).not.toBeNull()
  })
})
