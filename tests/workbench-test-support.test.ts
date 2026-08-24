import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import {
  buildWorkbenchVelarTestRunActions,
  buildWorkbenchVelarTestRunCommand,
  shouldShowWorkbenchVelarTestRunGutter,
} from '../src/renderer/src/models/editor/workbenchVelarTestRunGutter'
import { isWorkbenchTestFilePath } from '../src/renderer/src/models/files/workbenchTestFile'

void describe('Workbench test affordances', () => {
  void test('recognizes conventional test files without coloring unrelated files in tests folders', () => {
    assert.equal(isWorkbenchTestFilePath('tests/compiler.test.ts'), true)
    assert.equal(isWorkbenchTestFilePath('src/widget.spec.tsx'), true)
    assert.equal(isWorkbenchTestFilePath('tests/world.browser.test.vel'), true)
    assert.equal(isWorkbenchTestFilePath('tests/browser.acceptance.ts'), false)
    assert.equal(isWorkbenchTestFilePath('src/contest.vel'), false)
  })

  void test('finds top-level Velar test declarations and maps every marker to the current file', () => {
    const actions = buildWorkbenchVelarTestRunActions({
      content: [
        'import {expect} from "velar/test"',
        '',
        'test "creates a world":',
        '  expect(true).toBe(true)',
        '  // test "not a declaration":',
        'test "restores \\"quoted\\" state":',
      ].join('\n'),
      packageManager: 'npm',
      path: 'packages/world runtime/tests/world-runtime.test.vel',
    })

    assert.deepEqual(
      actions.map(({ label, line }) => ({ label, line })),
      [
        { label: 'creates a world', line: 3 },
        { label: 'restores "quoted" state', line: 6 },
      ]
    )
    assert.equal(
      actions[0]?.command,
      "npx --no-install velar test 'packages/world runtime/tests/world-runtime.test.vel'"
    )
    assert.equal(actions[1]?.command, actions[0]?.command)
  })

  void test('adds the browser host only for explicit Velar browser test files', () => {
    assert.equal(shouldShowWorkbenchVelarTestRunGutter('tests/app.browser.test.vel'), true)
    assert.equal(shouldShowWorkbenchVelarTestRunGutter('src/app.vel'), false)
    assert.equal(
      buildWorkbenchVelarTestRunCommand('tests/app.browser.test.vel', 'pnpm'),
      'pnpm exec velar test tests/app.browser.test.vel --browser'
    )
    assert.equal(
      buildWorkbenchVelarTestRunCommand('tests/app.test.vel', 'bun'),
      'bunx --no-install velar test tests/app.test.vel'
    )
  })
})
