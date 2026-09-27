import assert from 'node:assert/strict'

import { describe, test } from 'bun:test'

import {
  formatWorkbenchDocumentBuiltin,
  formatWorkbenchJson,
} from '../src/main/workspace/language/WorkbenchDocumentFormatter'

void describe('Workbench built-in JSON formatting', () => {
  void test('lays out plain JSON exactly like JSON.stringify with two spaces', () => {
    const content = '{"name":"workbench","tags":["a","b"],"nested":{"empty":{},"list":[],"n":null,"ok":true}}'
    assert.equal(
      formatWorkbenchDocumentBuiltin({ extension: 'json', content }),
      `${JSON.stringify(JSON.parse(content), null, 2)}\n`
    )
    const formatted = formatWorkbenchJson(content)!
    assert.equal(formatWorkbenchJson(formatted), formatted)
  })

  void test('keeps big integers, number spelling, escapes and duplicate keys as written', () => {
    const content =
      '{"id":12345678901234567890,"ratio":1.0,"tiny":1e-7,"text":"caf\\u00e9 \\"q\\"","id":2}'
    assert.equal(
      formatWorkbenchJson(content),
      [
        '{',
        '  "id": 12345678901234567890,',
        '  "ratio": 1.0,',
        '  "tiny": 1e-7,',
        '  "text": "caf\\u00e9 \\"q\\"",',
        '  "id": 2',
        '}',
        '',
      ].join('\n')
    )
  })

  void test('keeps comments where they were and tolerates trailing commas', () => {
    const content = [
      '// compiler settings',
      '{ "compilerOptions": { // inline',
      '  "strict": true, /* why */ "target": "es2022",',
      '  // paths below',
      '  "paths": {},',
      '}}',
    ].join('\n')
    assert.equal(
      formatWorkbenchJson(content),
      [
        '// compiler settings',
        '{',
        '  "compilerOptions": { // inline',
        '    "strict": true, /* why */',
        '    "target": "es2022",',
        '    // paths below',
        '    "paths": {},',
        '  }',
        '}',
        '',
      ].join('\n')
    )
  })

  void test('leaves invalid JSON alone', () => {
    for (const content of ['{"a": }', '{"a" 1}', '[1 2]', '{a: 1}', '{"a": 1', "{'a': 1}", '/* open', '{"a": "x\ny"}'])
      assert.equal(formatWorkbenchJson(content), null, content)
  })
})
