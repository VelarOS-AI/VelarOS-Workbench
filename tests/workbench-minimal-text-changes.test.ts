import assert from 'node:assert/strict'

import { ChangeSet, Text } from '@codemirror/state'
import { describe, test } from 'bun:test'

import { buildWorkbenchMinimalTextChanges } from '../src/renderer/src/models/editor/workbenchMinimalTextChanges'

/** 把改动套到原文上，同时数出改动碰到了多少字（删掉的 + 插入的）。 */
function apply(before: string, after: string): { result: string; touched: number } {
  const set = ChangeSet.of(buildWorkbenchMinimalTextChanges(before, after), before.length)
  let touched = 0
  set.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
    touched += toA - fromA + inserted.length
  })
  return { result: set.apply(Text.of(before.split('\n'))).toString(), touched }
}

void describe('Workbench minimal text changes', () => {
  void test('are empty for identical text', () => {
    assert.deepEqual(buildWorkbenchMinimalTextChanges('same\n', 'same\n'), [])
  })

  void test('reproduce the new text and only touch what really changed', () => {
    const before = 'function a() {\nconst x = 1\nreturn x\n}\n\nfunction b() {}\n'
    const after = 'function a() {\n  const x = 1\n  return x;\n}\n\nfunction b() {}\n'
    const { result, touched } = apply(before, after)
    assert.equal(result, after)
    // 两处缩进各插两个空格、一个分号：一共 5 个字，而不是整篇替换。
    assert.equal(touched, 5)
  })

  void test('handle added and removed lines, a missing final newline and empty sides', () => {
    for (const [before, after] of [
      ['a\nb\nc\n', 'a\nc\n'],
      ['a\nc\n', 'a\nb\nc\n'],
      ['a\nb', 'a\nb\n'],
      ['', 'hello\n'],
      ['hello\n', ''],
      ["const s = 'x'\nfoo(a, b)\n", 'const s = "x"\nfoo(\n  a,\n  b\n)\n'],
    ] as const)
      assert.equal(apply(before, after).result, after, JSON.stringify([before, after]))
  })
})
