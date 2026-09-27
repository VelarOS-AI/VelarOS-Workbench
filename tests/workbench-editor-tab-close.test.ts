import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { describe, test } from 'bun:test'

import {
  collectWorkbenchEditorTabsToRight,
  resolveWorkbenchEditorSelectionAfterClose,
  workbenchEditorTabFileName,
} from '../src/renderer/src/models/editor/workbenchEditorTabClose'

function readSource(relativePath: string): string {
  return readFileSync(path.resolve(process.cwd(), relativePath), 'utf8')
}

function sliceBetween(source: string, start: string, end: string): string {
  const from = source.indexOf(start)
  assert.ok(from >= 0, `missing ${start}`)
  const to = source.indexOf(end, from + start.length)
  return source.slice(from, to < 0 ? undefined : to)
}

const tabs = ['a.ts', 'b.ts', 'c.ts', 'd.ts']

void describe('closing editor tabs', () => {
  void test('selects the nearest tab to the left of the closed current tab, else the right one', () => {
    assert.equal(resolveWorkbenchEditorSelectionAfterClose(tabs, new Set(['c.ts']), 'c.ts'), 'b.ts')
    assert.equal(resolveWorkbenchEditorSelectionAfterClose(tabs, new Set(['a.ts']), 'a.ts'), 'b.ts')
    assert.equal(
      resolveWorkbenchEditorSelectionAfterClose(tabs, new Set(['b.ts', 'c.ts', 'd.ts']), 'c.ts'),
      'a.ts'
    )
    assert.equal(resolveWorkbenchEditorSelectionAfterClose(tabs, new Set(tabs), 'b.ts'), null)
    // 当前标签没被关：不动。
    assert.equal(resolveWorkbenchEditorSelectionAfterClose(tabs, new Set(['d.ts']), 'b.ts'), 'b.ts')
  })

  void test('finds the tabs to the right and a tab file name', () => {
    assert.deepEqual(collectWorkbenchEditorTabsToRight(tabs, 'b.ts'), ['c.ts', 'd.ts'])
    assert.deepEqual(collectWorkbenchEditorTabsToRight(tabs, 'd.ts'), [])
    assert.deepEqual(collectWorkbenchEditorTabsToRight(tabs, 'missing.ts'), [])
    assert.equal(workbenchEditorTabFileName('src/app/index.ts'), 'index.ts')
  })

  void test('dirty tabs ask save / discard / cancel instead of refusing to close', () => {
    const controller = readSource('src/renderer/src/hooks/useWorkbenchEditorController.ts')
    const closing = sliceBetween(controller, 'const commitCloseOpenFiles', 'const reorderOpenTabs')

    // 关单个、关其他、关全部都先经过同一个确认；不再只弹「有未保存改动」的警告。
    assert.doesNotMatch(closing, /warnUnsavedChanges\(\)/u)
    assert.match(closing, /const closeOpenFile = [\s\S]*?requestCloseOpenFiles\(\[path\]\)/u)
    assert.match(closing, /const closeAllOpenFiles = [\s\S]*?requestCloseOpenFiles\(/u)
    assert.match(closing, /const closeOtherOpenFiles = [\s\S]*?requestCloseOpenFiles\(/u)
    assert.match(closing, /setCloseRequest\(\{[\s\S]*?kind: 'tabs',[\s\S]*?dirtyPaths,/u)

    const resolving = sliceBetween(controller, 'const resolveCloseRequest', 'return {')
    // 不保存：丢掉改动直接关；保存：存不下的（冲突、失败）留着，其余关掉。
    assert.match(resolving, /choice === 'discard'[\s\S]*?commitCloseOpenFiles\(request\.paths\)/u)
    assert.match(resolving, /saveTabsBeforeClose\(request\.dirtyPaths\)/u)
    assert.match(resolving, /status === 'conflict' \|\| status === 'failed'/u)
    assert.match(resolving, /commitCloseOpenFiles\(request\.paths\.filter\(\(path\) => !unsavedPaths\.has\(path\)\)\)/u)

    // 磁盘上已被删掉的文件，保存就是按标签内容重新建出来。
    const saving = sliceBetween(controller, 'const saveTabsBeforeClose', 'const resolveCloseRequest')
    assert.match(saving, /externalChange\?\.status === 'deleted'/u)
    assert.match(saving, /restoreDeletedTab\(tab\)/u)

    // 问着的时候自动保存不碰这些标签，「不保存」才真的不保存。
    assert.match(controller, /new Set\(closeRequest\?\.dirtyPaths \?\? \[\]\)/u)
    assert.match(controller, /heldPaths: autosaveHeldPaths/u)
    const autosave = readSource('src/renderer/src/hooks/useWorkbenchEditorAutosave.ts')
    assert.match(autosave, /!heldPathsLatest\.current\.has\(tab\.path\)/u)
    assert.match(autosave, /!heldPaths\.has\(tab\.path\)/u)
  })

  void test('the page shows the prompt, and a deleted dirty file can be closed or reverted', () => {
    const presentation = readSource('src/renderer/src/StandaloneWorkbenchPagePresentation.tsx')
    const editorPanel = readSource('src/renderer/src/components/editor/EditorPanel.tsx')
    const tabBar = readSource('src/renderer/src/components/editor/EditorTabBar.tsx')
    const dialog = readSource('src/renderer/src/components/editor/EditorUnsavedChangesDialog.tsx')

    assert.match(presentation, /<EditorUnsavedChangesDialog[\s\S]*?request=\{workbench\.closeRequest\}/u)
    assert.match(presentation, /onResolve=\{\(choice\) => void workbench\.resolveCloseRequest\(choice\)\}/u)
    for (const choice of ['save', 'discard', 'cancel']) {
      assert.match(dialog, new RegExp(`onResolve\\('${choice}'\\)`, 'u'), choice)
    }
    for (const key of ['unsavedCloseSave', 'unsavedCloseSaveAll', 'unsavedCloseDiscard', 'common.cancel']) {
      assert.match(dialog, new RegExp(key.replace('.', '\\.'), 'u'), key)
    }
    // 被删掉的文件的「关闭标签页」不再只给没改动的标签；有改动就走上面的确认。
    assert.match(editorPanel, /selectedExternalChange\.status === 'deleted' && \(\s*<Button/u)
    assert.doesNotMatch(editorPanel, /onRevertSelectedFile/u)
    assert.match(tabBar, /onRevertOpenFile\(tabContextMenu\.path\)/u)
    assert.match(tabBar, /disabled=\{!contextTabIsDirty\}/u)
  })
})
