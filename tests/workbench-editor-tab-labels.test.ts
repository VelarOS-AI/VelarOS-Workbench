import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { describe, test } from 'bun:test'

import { buildWorkbenchEditorTabLabels } from '../src/renderer/src/models/editor/workbenchEditorTabLabels'

function descriptions(paths: string[]): Array<[string, Nullable<string>]> {
  const labels = buildWorkbenchEditorTabLabels(paths)
  return paths.map((item) => [labels.get(item)?.name ?? '', labels.get(item)?.description ?? null])
}

void describe('editor tab labels', () => {
  void test('unique file names show only the name', () => {
    assert.deepEqual(descriptions(['src/app.ts', 'README.md']), [
      ['app.ts', null],
      ['README.md', null],
    ])
  })

  void test('same-name files show the parent folder that tells them apart', () => {
    assert.deepEqual(descriptions(['src/app/index.ts', 'src/lib/index.ts', 'src/app.ts']), [
      ['index.ts', '…/app'],
      ['index.ts', '…/lib'],
      ['app.ts', null],
    ])
  })

  void test('climbs as many folders as needed and marks the project root', () => {
    assert.deepEqual(
      descriptions(['packages/a/src/index.ts', 'packages/b/src/index.ts', 'index.ts']),
      [
        ['index.ts', '…/a/src'],
        ['index.ts', '…/b/src'],
        ['index.ts', './'],
      ]
    )
    // `a/x` 与 `x` 末一级相同，要多补一级才分得开。
    assert.deepEqual(descriptions(['a/x/util.ts', 'x/util.ts']), [
      ['util.ts', 'a/x'],
      ['util.ts', 'x'],
    ])
  })

  void test('the tab strip and the open-tab list show the description', () => {
    const tabBar = readFileSync(
      path.resolve(process.cwd(), 'src/renderer/src/components/editor/EditorTabBar.tsx'),
      'utf8'
    )
    assert.match(tabBar, /buildWorkbenchEditorTabLabels\(openTabs\.map\(\(tab\) => tab\.path\)\)/u)
    assert.equal(tabBar.match(/className=\{styles\.editorTabDescription\}/gu)?.length, 2)
  })
})
