import assert from 'node:assert/strict'

import { Text } from '@codemirror/state'
import { test } from 'bun:test'

import {
  applyWorkbenchLanguageServiceEditsToContent,
  languageServiceRangeToOffsets,
} from '../src/renderer/src/models/editor/workbenchCodeMirrorLanguageService'

void test('batched ranges use UTF-16 positions across CRLF, empty lines and a large prefix', () => {
  const prefix = 'const item = 1\r\n'.repeat(4000)
  const content = `${prefix}\nconst emoji = "😀";\n`
  const doc = Text.of(content.split('\n'))
  const range = { startLine: 4002, startColumn: 16, endLine: 4002, endColumn: 18 }
  const expected = { from: prefix.length + 16, to: prefix.length + 18 }
  assert.deepEqual(languageServiceRangeToOffsets(content, range), expected)
  assert.deepEqual(languageServiceRangeToOffsets(doc, range), expected)
  assert.equal(content.slice(expected.from, expected.to), '😀')
  assert.deepEqual(
    languageServiceRangeToOffsets(doc, {
      startLine: 9000,
      startColumn: 100,
      endLine: 9000,
      endColumn: 200,
    }),
    { from: content.length, to: content.length }
  )
  assert.equal(
    languageServiceRangeToOffsets(doc, {
      startLine: 2,
      startColumn: 1,
      endLine: 1,
      endColumn: 1,
    }),
    null
  )
})

void test('workspace edits keep source coordinates when later replacements add lines', () => {
  assert.equal(
    applyWorkbenchLanguageServiceEditsToContent('alpha\nbeta\ngamma', [
      { range: { startLine: 1, startColumn: 1, endLine: 1, endColumn: 6 }, newText: 'first' },
      {
        range: { startLine: 3, startColumn: 1, endLine: 3, endColumn: 6 },
        newText: 'third\nfourth',
      },
    ]),
    'first\nbeta\nthird\nfourth'
  )
})
