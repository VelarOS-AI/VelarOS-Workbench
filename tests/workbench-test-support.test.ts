import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { describe, test } from 'bun:test'

import {
  buildWorkbenchVelarTestRunActions,
  buildWorkbenchVelarTestRunCommand,
  shouldShowWorkbenchVelarTestRunGutter,
} from '../src/renderer/src/models/editor/workbenchVelarTestRunGutter'
import {
  isWorkbenchTestDirectoryPath,
  isWorkbenchTestFilePath,
} from '../src/renderer/src/models/files/workbenchTestFile'

void describe('Workbench test affordances', () => {
  void test('recognizes conventional test files without coloring unrelated files in tests folders', () => {
    assert.equal(isWorkbenchTestFilePath('tests/compiler.test.ts'), true)
    assert.equal(isWorkbenchTestFilePath('src/widget.spec.tsx'), true)
    assert.equal(isWorkbenchTestFilePath('tests/world.browser.test.vel'), true)
    assert.equal(isWorkbenchTestFilePath('tests/browser.acceptance.ts'), false)
    assert.equal(isWorkbenchTestFilePath('src/contest.vel'), false)
  })

  void test('recognizes conventional test directories for the test tree marker', () => {
    assert.equal(isWorkbenchTestDirectoryPath('tests'), true)
    assert.equal(isWorkbenchTestDirectoryPath('packages/core/test'), true)
    assert.equal(isWorkbenchTestDirectoryPath('src/__tests__'), true)
    assert.equal(isWorkbenchTestDirectoryPath('src/contest'), false)
    assert.equal(isWorkbenchTestDirectoryPath('src/test-data'), false)
  })

  void test('keeps test affordances visually distinct from untracked Git files', () => {
    const shellStyles = readFileSync(
      path.resolve('src/renderer/src/styles/01-shell.module.css'),
      'utf8'
    )
    const fileStyles = readFileSync(
      path.resolve('src/renderer/src/styles/08-files.module.css'),
      'utf8'
    )

    assert.match(shellStyles, /--workbench-git-untracked-fg:\s*var\(--status-amber\)/)
    assert.match(shellStyles, /--workbench-test-fg:\s*var\(--status-violet\)/)
    assert.match(
      fileStyles,
      /data-test-directory='true'[\s\S]*color:\s*var\(--workbench-test-fg\)/
    )
    assert.match(
      fileStyles,
      /\.treeTestFileBadge[\s\S]*color:\s*var\(--workbench-test-fg\)/
    )
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
    assert.deepEqual(
      actions[0]?.launch?.process,
      { kind: 'package-manager', program: 'npx', argv: ['--no-install', 'velar', 'test', 'packages/world runtime/tests/world-runtime.test.vel'] }
    )
    assert.equal(actions[1]?.command, actions[0]?.command)
  })

  void test('adds the browser host only for explicit Velar browser test files', () => {
    assert.equal(shouldShowWorkbenchVelarTestRunGutter('tests/app.browser.test.vel'), true)
    assert.equal(shouldShowWorkbenchVelarTestRunGutter('src/app.vel'), false)
    assert.deepEqual(
      buildWorkbenchVelarTestRunCommand('tests/app.browser.test.vel', 'pnpm').launch?.process,
      { kind: 'package-manager', program: 'pnpm', argv: ['exec', 'velar', 'test', 'tests/app.browser.test.vel', '--browser'] }
    )
    assert.deepEqual(
      buildWorkbenchVelarTestRunCommand('tests/app.test.vel', 'bun').launch?.process,
      { kind: 'package-manager', program: 'bunx', argv: ['--no-install', 'velar', 'test', 'tests/app.test.vel'] }
    )
  })
})
