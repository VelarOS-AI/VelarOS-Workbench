import { setSearchQuery } from '@codemirror/search'
import { EditorState } from '@codemirror/state'
import { describe, expect, test } from 'bun:test'

import {
  buildWorkbenchEditorFindScopeEffect,
  buildWorkbenchEditorSearchQuery,
  readWorkbenchEditorFindSeed,
  readWorkbenchEditorFindStatus,
  workbenchEditorFindExtension,
} from '../src/renderer/src/models/editor/workbenchEditorFind'
import {
  DefaultWorkbenchEditorFindOptions,
  type WorkbenchEditorFindRequest,
} from '../src/renderer/src/models/editor/workbenchEditorFindState'

const doc = 'const calc = new Calculator()\ncalc.add(1)\nconst recalc = calc\n'

function request(overrides: Partial<WorkbenchEditorFindRequest>): WorkbenchEditorFindRequest {
  return { ...DefaultWorkbenchEditorFindOptions, query: 'calc', replace: '', ...overrides }
}

function matches(state: EditorState, find: WorkbenchEditorFindRequest): string[] {
  const found: string[] = []
  const cursor = buildWorkbenchEditorSearchQuery(find).getCursor(state)
  for (let next = cursor.next(); !next.done; next = cursor.next())
    found.push(`${next.value.from}:${state.sliceDoc(next.value.from, next.value.to)}`)
  return found
}

function stateWithQuery(find: WorkbenchEditorFindRequest, selection = 0): EditorState {
  const state = EditorState.create({ doc, selection: { anchor: selection }, extensions: workbenchEditorFindExtension })
  return state.update({ effects: setSearchQuery.of(buildWorkbenchEditorSearchQuery(find)) }).state
}

describe('in-file find', () => {
  test('matches case-insensitively by default and honours case, whole word and regex options', () => {
    const state = EditorState.create({ doc })
    expect(matches(state, request({}))).toEqual(['6:calc', '17:Calc', '30:calc', '50:calc', '57:calc'])
    expect(matches(state, request({ caseSensitive: true })).length).toBe(4)
    expect(matches(state, request({ wholeWord: true }))).toEqual(['6:calc', '30:calc', '57:calc'])
    expect(matches(state, request({ query: 'c(al)c\\b', regexp: true, caseSensitive: true }))).toEqual([
      '6:calc',
      '30:calc',
      '50:calc',
      '57:calc',
    ])
  })

  test('treats plain queries literally', () => {
    const state = EditorState.create({ doc: 'a\\nb\na\nb' })
    expect(matches(state, request({ query: '\\n' }))).toEqual(['1:\\n'])
  })

  test('counts matches and reports which one is selected', () => {
    let state = stateWithQuery(request({ wholeWord: true }))
    expect(readWorkbenchEditorFindStatus(state)).toEqual({ total: 3, current: 0, limited: false, invalid: false })
    state = state.update({ selection: { anchor: 30, head: 34 } }).state
    expect(readWorkbenchEditorFindStatus(state).current).toBe(2)
    expect(readWorkbenchEditorFindStatus(stateWithQuery(request({ query: '(', regexp: true }))).invalid).toBe(true)
    expect(readWorkbenchEditorFindStatus(stateWithQuery(request({ query: '' }))).total).toBe(0)
  })

  test('finds only inside the selection it was opened with, and the range follows edits', () => {
    let state = stateWithQuery(request({ inSelection: true }), 0)
    state = state.update({ selection: { anchor: 30, head: 61 } }).state
    state = state.update({ effects: buildWorkbenchEditorFindScopeEffect(state, true) }).state
    expect(readWorkbenchEditorFindStatus(state).total).toBe(3)
    state = state.update({ changes: { from: 0, insert: '// calc\n' } }).state
    expect(readWorkbenchEditorFindStatus(state).total).toBe(3)
    state = state.update({ effects: buildWorkbenchEditorFindScopeEffect(state, false) }).state
    expect(readWorkbenchEditorFindStatus(state).total).toBe(6)
  })

  test('seeds the query from a one-line selection or the word at the cursor', () => {
    const at = (anchor: number, head = anchor) =>
      readWorkbenchEditorFindSeed(EditorState.create({ doc, selection: { anchor, head } }))
    expect(at(6, 10)).toBe('calc')
    expect(at(8)).toBe('calc')
    expect(at(0, 40)).toBeUndefined()
    expect(at(12)).toBeUndefined()
  })
})
