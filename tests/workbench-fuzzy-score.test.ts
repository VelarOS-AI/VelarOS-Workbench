import assert from 'node:assert/strict'

import { describe, test } from 'bun:test'

import {
  isWorkbenchFuzzySubsequence,
  scoreWorkbenchFuzzy,
} from '../src/renderer/src/models/shared/workbenchFuzzyScore'

function positions(target: string, query: string): Nullable<number[]> {
  return scoreWorkbenchFuzzy(target, query)?.positions ?? null
}

function score(target: string, query: string): number {
  const match = scoreWorkbenchFuzzy(target, query)
  assert.ok(match, `${query} should match ${target}`)
  return match.score
}

void describe('Workbench fuzzy score', () => {
  void test('matches characters in order, ignoring case', () => {
    assert.deepEqual(positions('QuickOpen.tsx', 'qopen'), [0, 5, 6, 7, 8])
    assert.deepEqual(positions('abc', 'ABC'), [0, 1, 2])
    assert.equal(scoreWorkbenchFuzzy('abc', 'acb'), null)
    assert.equal(scoreWorkbenchFuzzy('abc', 'abcd'), null)
    assert.equal(scoreWorkbenchFuzzy('abc', ''), null)
    assert.equal(isWorkbenchFuzzySubsequence('quickopen.tsx', 'qot'), true)
    assert.equal(isWorkbenchFuzzySubsequence('quickopen.tsx', 'toq'), false)
  })

  void test('a consecutive run scores higher than the same letters apart', () => {
    assert.ok(score('format.ts', 'format') > score('fo-rm-at.ts', 'format'))
    // 连着的越长越值钱：`shortcuts` 整段命中在文件名里，不去拼前面零散的字母。
    assert.deepEqual(
      positions('workbenchKeyboardShortcuts.ts', 'shortcuts'),
      [17, 18, 19, 20, 21, 22, 23, 24, 25]
    )
    assert.deepEqual(positions('types.ts', 'ts'), [6, 7])
  })

  void test('prefers word, camelCase and path segment starts', () => {
    assert.deepEqual(positions('QuickOpen.tsx', 'qo'), [0, 5])
    assert.deepEqual(positions('NullPointerException.java', 'npe'), [0, 4, 11])
    // 连串大写里接小写的那个也是词首。
    assert.deepEqual(positions('HTTPServer.ts', 'hs'), [0, 4])
    assert.deepEqual(positions('components/project/QuickOpen.tsx', 'cpq'), [0, 11, 19])
    assert.deepEqual(positions('ab/b', 'b'), [3])
    assert.deepEqual(positions('my_file-name', 'fn'), [3, 8])
    assert.ok(score('src/Button.tsx', 'b') > score('src/tab.tsx', 'b'))
  })

  void test('rewards matching case and the start of the text', () => {
    assert.ok(score('QuickOpen', 'Q') > score('QuickOpen', 'q'))
    assert.ok(score('model.ts', 'm') > score('a/model.ts', 'm'))
  })

  void test('picks the earliest of equally good positions', () => {
    assert.deepEqual(positions('banana', 'a'), [1])
    assert.deepEqual(positions('a/a/a', 'a'), [0])
  })

  void test('counts both path separators as segment starts', () => {
    assert.deepEqual(positions('src\\qo.ts', 'src\\qo'), [0, 1, 2, 3, 4, 5])
    assert.ok(score('src\\app\\main.ts', 'm') === score('src/app/main.ts', 'm'))
  })
})
