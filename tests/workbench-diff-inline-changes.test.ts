import assert from 'node:assert/strict'

import { describe, test } from 'bun:test'

import {
  computeWorkbenchDiffInlineChanges,
  WorkbenchDiffInlineDefaultLimits,
} from '../src/renderer/src/models/git/workbenchDiffInlineChanges'
import type { WorkbenchUnifiedDiffRow } from '../src/renderer/src/models/git/workbenchGitDiffModel'

type RowKind = WorkbenchUnifiedDiffRow['kind']

/** `-旧行` / `+新行` / ` 没变的行` / `@@` 分隔行 → 差异行。 */
function rows(...lines: string[]): WorkbenchUnifiedDiffRow[] {
  return lines.map((line, index) => {
    const kind: RowKind = line.startsWith('-')
      ? 'deletion'
      : line.startsWith('+')
        ? 'addition'
        : line.startsWith('@@')
          ? 'hunk'
          : 'context'
    return {
      id: String(index),
      kind,
      oldLine: null,
      newLine: null,
      marker: '',
      text: kind === 'hunk' ? line : line.slice(1),
    }
  })
}

/** 每个有行内变化的行：行的下标 → 变了的那几段文字。 */
function changedText(diffRows: WorkbenchUnifiedDiffRow[], limits = WorkbenchDiffInlineDefaultLimits) {
  const changes = computeWorkbenchDiffInlineChanges(diffRows, limits)
  return Object.fromEntries(
    [...changes].map(([row, ranges]) => [
      row,
      ranges.map((range) => diffRows[row].text.slice(range.from, range.to)),
    ])
  )
}

void describe('Workbench diff word-level changes', () => {
  void test('marks the word that changed on both sides of a modified line', () => {
    const diffRows = rows(' function total() {', '-  const count = 1', '+  const amount = 1', ' }')
    assert.deepEqual(changedText(diffRows), { 1: ['count'], 2: ['amount'] })
    // 位置是相对这一行正文的下标。
    assert.deepEqual(computeWorkbenchDiffInlineChanges(diffRows).get(1), [{ from: 8, to: 13 }])
  })

  void test('an inserted or removed word is marked only on the side that has it', () => {
    assert.deepEqual(changedText(rows('-return value', '+return await value')), { 1: ['await '] })
    assert.deepEqual(changedText(rows('-call(first, second)', '+call(first)')), { 0: [', second'] })
  })

  void test('changes that are only a space apart are shown as one stretch', () => {
    assert.deepEqual(changedText(rows('-let alpha beta = 1', '+let gamma delta = 1')), {
      0: ['alpha beta'],
      1: ['gamma delta'],
    })
    // 隔着没变的词就是两段。
    assert.deepEqual(changedText(rows('-one keep two end', '+uno keep dos end')), {
      0: ['one', 'two'],
      1: ['uno', 'dos'],
    })
  })

  void test('a line that was replaced wholesale gets no word marks', () => {
    assert.deepEqual(changedText(rows('-const total = compute(items)', '+return null')), {})
    // 只剩一个分号没变：也当整行换了。
    assert.deepEqual(
      changedText(rows('-const total = compute(items);', '+throw new Error(message);')),
      {}
    )
  })

  void test('lines are matched across a block even when their number differs', () => {
    // 一行拆成了两行。
    const split = rows('-call(first, second)', '+call(', '+  first, second)')
    assert.deepEqual(changedText(split), { 2: ['  '] })
    // 中间插进来一整行：插进来的那行不标，前后的行照样对得上。
    const inserted = rows('-alpha = 1', '-gamma = 3', '+alpha = 10', '+beta = 2', '+gamma = 30')
    assert.deepEqual(changedText(inserted), { 0: ['1'], 1: ['3'], 2: ['10'], 4: ['30'] })
  })

  void test('blocks with only deletions or only additions are left to the line colour', () => {
    assert.deepEqual(changedText(rows(' keep', '-gone one', '-gone two', ' keep')), {})
    assert.deepEqual(changedText(rows(' keep', '+new one', ' keep', '+new two')), {})
    // 删除行与新增行之间隔着没变的行：是两块，各自没有可比的。
    assert.deepEqual(changedText(rows('-old value', ' keep', '+new value')), {})
  })

  void test('an indentation change marks the whitespace', () => {
    assert.deepEqual(changedText(rows('-  return 1', '+    return 1')), { 0: ['  '], 1: ['    '] })
  })

  void test('Chinese text is compared character by character, identifiers as whole words', () => {
    assert.deepEqual(changedText(rows('-标题：你好世界', '+标题：你好朋友')), {
      0: ['世界'],
      1: ['朋友'],
    })
    assert.deepEqual(changedText(rows('-const userName = 1', '+const userNames = 1')), {
      0: ['userName'],
      1: ['userNames'],
    })
    // 表情这类占两个 UTF-16 单元的字符不会被拆开。
    assert.deepEqual(changedText(rows('-status: 😀 ok', '+status: 😎 ok')), { 0: ['😀'], 1: ['😎'] })
  })

  void test('a block over the per-block limit is skipped, the ones after it are still compared', () => {
    const middle = Array.from({ length: 30 }, (_, index) => `w${index}`).join(' ')
    const diffRows = rows(
      `-first ${middle} last`,
      `+erste ${middle} letzte`,
      ' keep',
      '-small one',
      '+small two'
    )
    // 第一块头尾都不一样，去不掉两头：63×63 格，超过 1000；第二块只有 1 格。
    const limited = changedText(diffRows, { maxBlockCells: 1_000, maxTotalCells: 1_000_000 })
    assert.deepEqual(limited, { 3: ['one'], 4: ['two'] })
    // 不限的时候第一块也比得出来。
    assert.deepEqual(changedText(diffRows), {
      0: ['first', 'last'],
      1: ['erste', 'letzte'],
      3: ['one'],
      4: ['two'],
    })
  })

  void test('once the total budget is spent the remaining blocks are skipped', () => {
    const block = (tag: string): string[] => [
      `-a${tag} b${tag} c${tag} keep`,
      `+x${tag} y${tag} z${tag} keep`,
      ' context',
    ]
    const diffRows = rows(...block('1'), ...block('2'), ...block('3'))
    // 每块 5×5 = 25 格（三个词和它们之间的两个空格）；预算只够第一块。
    const limited = computeWorkbenchDiffInlineChanges(diffRows, {
      maxBlockCells: 1_000,
      maxTotalCells: 30,
    })
    assert.deepEqual([...limited.keys()], [0, 1])
    assert.deepEqual([...computeWorkbenchDiffInlineChanges(diffRows).keys()], [0, 1, 3, 4, 6, 7])
  })

  void test('a huge rewritten block costs next to nothing', () => {
    // 两千行对两千行、互不相同：远超上限，不拆词也不比。
    const removed = Array.from({ length: 2_000 }, (_, index) => `-const before${index} = compute(${index}, ${'x'.repeat(200)})`)
    const added = Array.from({ length: 2_000 }, (_, index) => `+let after${index} = derive(${index}, ${'y'.repeat(200)})`)
    const diffRows = rows(...removed, ...added)
    const startedAt = performance.now()
    const changes = computeWorkbenchDiffInlineChanges(diffRows)
    const elapsed = performance.now() - startedAt
    assert.equal(changes.size, 0)
    assert.ok(elapsed < 200, `took ${elapsed} ms`)
  })

  void test('a one-word change inside a very long line is still found', () => {
    const head = Array.from({ length: 4_000 }, (_, index) => `"k${index}":${index}`).join(',')
    const diffRows = rows(`-{${head},"name":"old"}`, `+{${head},"name":"new"}`)
    assert.deepEqual(changedText(diffRows), { 0: ['old'], 1: ['new'] })
  })

  void test('a whole-file diff with few changes stays fast', () => {
    const context = Array.from({ length: 60_000 }, (_, index) => ` line ${index}`)
    const diffRows = rows(...context.slice(0, 30_000), '-value = 1', '+value = 2', ...context.slice(30_000))
    const startedAt = performance.now()
    const changes = computeWorkbenchDiffInlineChanges(diffRows)
    const elapsed = performance.now() - startedAt
    assert.deepEqual([...changes.keys()], [30_000, 30_001])
    assert.ok(elapsed < 200, `took ${elapsed} ms`)
  })
})
