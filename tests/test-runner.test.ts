import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { describe, test } from 'bun:test'

import {
  discoverTestFiles,
  runWithConcurrency,
} from '../scripts/test/runIsolatedTests.mjs'

void describe('isolated test runner', () => {
  void test('discovers supported test files recursively in stable order', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'workbench-test-runner-'))
    try {
      await mkdir(path.join(root, 'nested'))
      await Promise.all([
        writeFile(path.join(root, 'z.test.ts'), ''),
        writeFile(path.join(root, 'nested', 'a.test.cjs'), ''),
        writeFile(path.join(root, 'nested', 'b.test.mjs'), ''),
        writeFile(path.join(root, 'nested', 'ignored.spec.ts'), ''),
      ])

      const files = await discoverTestFiles(root)

      assert.deepEqual(files.map((file) => path.relative(root, file)), [
        path.join('nested', 'a.test.cjs'),
        path.join('nested', 'b.test.mjs'),
        'z.test.ts',
      ])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  void test('caps work at four concurrent executions and preserves result order', async () => {
    let active = 0
    let maximumActive = 0
    const items = Array.from({ length: 12 }, (_, index) => index)

    const results = await runWithConcurrency(items, 20, async (item) => {
      active += 1
      maximumActive = Math.max(maximumActive, active)
      await new Promise((resolve) => setTimeout(resolve, 5 + (item % 3)))
      active -= 1
      return item * 2
    })

    assert.equal(maximumActive, 4)
    assert.deepEqual(results, items.map((item) => item * 2))
  })
})
