import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { describe, test } from 'bun:test'

import {
  collectWorkbenchEditorTabsToRight,
  popWorkbenchClosedEditorTab,
  pushWorkbenchClosedEditorTabs,
  resolveWorkbenchEditorSelectionAfterClose,
  WORKBENCH_CLOSED_EDITOR_TAB_LIMIT,
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

  void test('remembers the last 20 closed tabs and reopens the latest one that is not open', () => {
    let stack = pushWorkbenchClosedEditorTabs([], ['a.ts'])
    stack = pushWorkbenchClosedEditorTabs(stack, ['b.ts', 'c.ts'])
    // 同一个文件再关一次：只留最近一次。
    stack = pushWorkbenchClosedEditorTabs(stack, ['a.ts'])
    assert.deepEqual(stack, ['b.ts', 'c.ts', 'a.ts'])

    const first = popWorkbenchClosedEditorTab(stack, new Set())
    assert.equal(first.path, 'a.ts')
    // 已经又打开着的跳过，取再往前的那个。
    const second = popWorkbenchClosedEditorTab(first.stack, new Set(['c.ts']))
    assert.deepEqual(second, { path: 'b.ts', stack: [] })
    assert.deepEqual(popWorkbenchClosedEditorTab([], new Set()), { path: null, stack: [] })

    const many = pushWorkbenchClosedEditorTabs(
      [],
      Array.from({ length: 30 }, (_, index) => `file-${index}.ts`)
    )
    assert.equal(many.length, WORKBENCH_CLOSED_EDITOR_TAB_LIMIT)
    assert.equal(many.at(-1), 'file-29.ts')
    assert.equal(many[0], 'file-10.ts')
  })

  void test('reopening, closing to the right and middle-click are wired to the tabs', () => {
    const controller = readSource('src/renderer/src/hooks/useWorkbenchEditorController.ts')
    const pageModel = readSource('src/renderer/src/hooks/useStandaloneWorkbenchPageModel.tsx')
    const tabBar = readSource('src/renderer/src/components/editor/EditorTabBar.tsx')
    const shortcuts = readSource('src/renderer/src/models/layout/workbenchKeyboardShortcuts.ts')

    // 用户关掉的每个标签都记下（文件树里删掉 / 挪走的不算），换项目时清空。
    const commitClose = sliceBetween(controller, 'const commitCloseOpenFiles', 'const requestCloseOpenFiles')
    assert.match(commitClose, /pushWorkbenchClosedEditorTabs\(/u)
    assert.doesNotMatch(
      sliceBetween(controller, 'const closeOpenEntryPath', 'const commitCloseOpenFiles'),
      /closedTabPathsRef/u
    )
    assert.match(
      sliceBetween(controller, 'const resetSelectedFile', 'const toggleSelectedFileEditMode'),
      /closedTabPathsRef\.current = \[\]/u
    )
    assert.match(shortcuts, /action: 'reopen-closed-tab', defaultShortcut: 'Mod\+Shift\+T'/u)
    // 重新打开时回到上次的光标位置（记得的话）。
    const reopen = sliceBetween(pageModel, 'const reopenClosedEditorTab', '})\n')
    assert.match(reopen, /takeRecentlyClosedTabPath\(\)/u)
    assert.match(reopen, /sessionCursorByPathRef\.current\[path\]/u)
    assert.match(reopen, /line: cursor\.line, column: cursor\.column/u)
    assert.match(pageModel, /onReopenClosedTab: \(\) => void reopenClosedEditorTab\(\)/u)

    assert.match(tabBar, /onCloseOpenFilesToRight\(tabContextMenu\.path\)/u)
    assert.match(tabBar, /disabled=\{!contextTabHasTabsToRight\}/u)
    // 文件、差异、轻量预览、辅助标签都能中键关。
    assert.equal(tabBar.match(/\{\.\.\.middleClickCloseHandlers\(/gu)?.length, 4)
    assert.match(tabBar, /event\.button !== 1 \|\| !onClose/u)
  })

  void test('dirty tabs ask save / discard / cancel instead of refusing to close', () => {
    const controller = readSource('src/renderer/src/hooks/useWorkbenchEditorController.ts')
    const closing = sliceBetween(controller, 'const commitCloseOpenFiles', 'async function saveTab')

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
    // 选了还没存下去的格式转换也算改动；因为编码写不出字符被拒的，确认框里写明原因。
    assert.match(tabBar, /contextTabIsDirty = !!contextTab && isDirtyTab\(contextTab\)/u)
    assert.match(dialog, /request\?\.reasons\?\.\[path\] \?\? tab\?\.unencodableSaveError/u)
  })
})
