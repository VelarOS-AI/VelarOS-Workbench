import { EditorState } from '@codemirror/state'
import { describe, expect, test } from 'bun:test'

import {
  parseWorkbenchEditorConfig,
  resolveWorkbenchEditorConfig,
} from '../src/renderer/src/models/editor/workbenchEditorConfig'
import { buildWorkbenchSaveWhitespaceChanges } from '../src/renderer/src/models/editor/workbenchSaveWhitespace'

function applySaveRules(doc: string, rules: Parameters<typeof buildWorkbenchSaveWhitespaceChanges>[1]): string {
  const state = EditorState.create({ doc })
  return state.update({ changes: buildWorkbenchSaveWhitespaceChanges(state, rules) }).state.doc.toString()
}

describe('.editorconfig rules applied on save', () => {
  test('are read from the file', () => {
    const file = parseWorkbenchEditorConfig(
      '[*]\ntrim_trailing_whitespace = true\ninsert_final_newline = true\n[*.md]\ntrim_trailing_whitespace = false\n'
    )
    expect(resolveWorkbenchEditorConfig([{ directory: '', file }], 'a.ts')).toEqual({
      trimTrailingWhitespace: true,
      insertFinalNewline: true,
    })
    expect(resolveWorkbenchEditorConfig([{ directory: '', file }], 'notes.md').trimTrailingWhitespace).toBe(false)
  })

  test('trim trailing whitespace and add the final newline', () => {
    expect(applySaveRules('a  \n\tb\t\nc', { trimTrailingWhitespace: true, insertFinalNewline: true })).toBe(
      'a\n\tb\nc\n'
    )
    expect(applySaveRules('a  \n', { trimTrailingWhitespace: true, insertFinalNewline: true })).toBe('a\n')
    expect(applySaveRules('', { insertFinalNewline: true })).toBe('')
  })

  test('remove trailing newlines when the final newline is turned off, and change nothing without rules', () => {
    expect(applySaveRules('a\n\n\n', { insertFinalNewline: false })).toBe('a')
    expect(applySaveRules('a  \n', null)).toBe('a  \n')
    expect(applySaveRules('a  \n', {})).toBe('a  \n')
  })
})
