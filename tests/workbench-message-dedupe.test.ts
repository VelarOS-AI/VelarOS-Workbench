import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import {
  makeWorkbenchMessageFingerprint,
  WorkbenchMessageDedupe,
} from '../src/renderer/src/runtime/workbenchMessageDedupe'

void describe('Workbench message dedupe', () => {
  void test('coalesces the same visible message within the dedupe window', () => {
    const dedupe = new WorkbenchMessageDedupe(4000)
    const message = {
      tone: 'error',
      title: '读取目录失败',
      description: '目录已被删除或移动：packages/hash/src',
    }

    assert.equal(dedupe.shouldSkip(message, 1000), false)
    assert.equal(dedupe.shouldSkip(message, 4999), true)
    assert.equal(dedupe.shouldSkip(message, 5000), false)
  })

  void test('keeps distinct content and tones as separate notifications', () => {
    const dedupe = new WorkbenchMessageDedupe(4000)

    assert.equal(dedupe.shouldSkip({ tone: 'error', title: '失败', description: 'A' }, 1000), false)
    assert.equal(dedupe.shouldSkip({ tone: 'error', title: '失败', description: 'B' }, 1001), false)
    assert.equal(dedupe.shouldSkip({ tone: 'warning', title: '失败', description: 'A' }, 1002), false)
  })

  void test('uses the visible message identity as the stable Sonner id', () => {
    const first = makeWorkbenchMessageFingerprint({
      tone: 'error',
      title: '读取目录失败',
      description: '目录已被删除或移动：packages/hash/src',
    })
    const second = makeWorkbenchMessageFingerprint({
      tone: 'error',
      title: '读取目录失败',
      description: '目录已被删除或移动：packages/hash/src',
    })

    assert.equal(first, second)
  })
})
