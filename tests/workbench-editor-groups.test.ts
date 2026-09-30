import assert from 'node:assert/strict'

import { describe, test } from 'bun:test'

import {
  closeWorkbenchEditorTabs,
  createWorkbenchEditorGroupsLayout,
  findWorkbenchEditorGroupIndex,
  getWorkbenchEditorFocusedPath,
  listWorkbenchEditorLayoutPaths,
  normalizeWorkbenchEditorGroupsLayout,
  openWorkbenchEditorTab,
  renameWorkbenchEditorLayoutPaths,
  reorderWorkbenchEditorTab,
  type WorkbenchEditorGroupsLayout,
} from '../src/renderer/src/models/editor/workbenchEditorGroups'
import {
  buildWorkbenchProjectSessionSnapshot,
  normalizeWorkbenchProjectSession,
} from '../src/renderer/src/models/project/workbenchProjectSessionModel'

/**
 * 布局的样子：组之间用 ` | ` 隔开，当前组前面有 `*`，每组里当前标签用 `[]` 括起来，
 * 如 `*a [b] c`。
 */
function show(layout: WorkbenchEditorGroupsLayout): string {
  return layout.groups
    .map((group, index) => {
      const tabs = group.paths.map((path) => (path === group.activePath ? `[${path}]` : path))
      return `${index === layout.focusedGroup ? '*' : ''}${tabs.join(' ')}`
    })
    .join(' | ')
}

function open(layout: WorkbenchEditorGroupsLayout, ...paths: string[]): WorkbenchEditorGroupsLayout {
  return paths.reduce((current, path) => openWorkbenchEditorTab(current, path), layout)
}

const empty = createWorkbenchEditorGroupsLayout()

void describe('editor tab layout', () => {
  void test('starts with one empty group and no current file', () => {
    assert.equal(show(empty), '*')
    assert.equal(getWorkbenchEditorFocusedPath(empty), null)
    assert.deepEqual(listWorkbenchEditorLayoutPaths(empty), [])
  })

  void test('a new file gets a tab at the end and becomes the current file', () => {
    const layout = open(empty, 'a', 'b', 'c')
    assert.equal(show(layout), '*a b [c]')
    assert.equal(getWorkbenchEditorFocusedPath(layout), 'c')
    assert.deepEqual(listWorkbenchEditorLayoutPaths(layout), ['a', 'b', 'c'])
    assert.equal(findWorkbenchEditorGroupIndex(layout, 'b'), 0)
    assert.equal(findWorkbenchEditorGroupIndex(layout, 'missing'), -1)
  })

  void test('opening a file that already has a tab only switches to it', () => {
    const layout = open(empty, 'a', 'b', 'c')
    const switched = openWorkbenchEditorTab(layout, 'a')
    assert.equal(show(switched), '*[a] b c')
    // 已经是当前文件：布局对象原样返回，调用方据此不重新渲染。
    assert.equal(openWorkbenchEditorTab(switched, 'a'), switched)
  })

  void test('closing the current tab shows its left neighbour, else the right one', () => {
    const layout = openWorkbenchEditorTab(open(empty, 'a', 'b', 'c', 'd'), 'c')
    assert.equal(show(closeWorkbenchEditorTabs(layout, ['c'])), '*a [b] d')
    assert.equal(show(closeWorkbenchEditorTabs(layout, ['a'])), '*b [c] d')
    assert.equal(show(closeWorkbenchEditorTabs(layout, ['a', 'b', 'c'])), '*[d]')
    assert.equal(show(closeWorkbenchEditorTabs(layout, ['a', 'b', 'c', 'd'])), '*')
    // 要关的标签一个都不在：原样返回。
    assert.equal(closeWorkbenchEditorTabs(layout, ['missing']), layout)
  })

  void test('dragging a tab puts it where the target tab is', () => {
    const layout = open(empty, 'a', 'b', 'c', 'd')
    // 往右拖落在目标后面，往左拖落在目标前面（与拖动前一样的规则）。
    assert.equal(show(reorderWorkbenchEditorTab(layout, 'a', 'c')), '*b c a [d]')
    assert.equal(show(reorderWorkbenchEditorTab(layout, 'd', 'b')), '*a [d] b c')
    assert.equal(reorderWorkbenchEditorTab(layout, 'a', 'a'), layout)
    assert.equal(reorderWorkbenchEditorTab(layout, 'a', 'missing'), layout)
    assert.equal(reorderWorkbenchEditorTab(layout, 'missing', 'a'), layout)
  })

  void test('renaming a file or its folder keeps the tab where it is', () => {
    const layout = openWorkbenchEditorTab(open(empty, 'src/a.ts', 'src/b.ts', 'c.ts'), 'src/b.ts')
    const moved = renameWorkbenchEditorLayoutPaths(layout, (path) =>
      path.startsWith('src/') ? `lib/${path.slice(4)}` : path
    )
    assert.equal(show(moved), '*lib/a.ts [lib/b.ts] c.ts')
    assert.equal(renameWorkbenchEditorLayoutPaths(layout, (path) => path), layout)
    // 改完撞上另一个开着的文件：只留前面那个标签。
    assert.equal(
      show(renameWorkbenchEditorLayoutPaths(layout, (path) => (path === 'c.ts' ? 'src/a.ts' : path))),
      '*src/a.ts [src/b.ts]'
    )
  })
})

void describe('saved editor tab layout', () => {
  void test('a saved layout round-trips through the project session', () => {
    const layout = openWorkbenchEditorTab(open(empty, 'a', 'b', 'c'), 'b')
    const session = buildWorkbenchProjectSessionSnapshot({
      expandedPaths: ['.'],
      selectedEntryPath: 'b',
      editorLayout: layout,
      cursorByPath: { b: { line: 3, column: 7 } },
    })
    const restored = normalizeWorkbenchProjectSession(JSON.parse(JSON.stringify(session)))
    assert.equal(show(restored.editorLayout), '*a [b] c')
    assert.deepEqual(restored.cursorByPath, { b: { line: 3, column: 7 } })
  })

  void test('anything that is not a layout restores as no tabs', () => {
    for (const value of [undefined, null, 'tabs', 3, [], {}, { groups: 'a' }, { groups: [] }]) {
      assert.equal(show(normalizeWorkbenchEditorGroupsLayout(value, 32)), '*', JSON.stringify(value))
    }
    // 只有一列标签路径的旧会话不换算：标签不恢复，树的展开状态照旧。
    const legacy = normalizeWorkbenchProjectSession({
      version: 1,
      expandedPaths: ['.', 'src'],
      selectedEntryPath: 'src/a.ts',
      openTabPaths: ['src/a.ts', 'src/b.ts'],
      selectedFilePath: 'src/b.ts',
      cursorByPath: {},
    })
    assert.equal(show(legacy.editorLayout), '*')
    assert.deepEqual(legacy.expandedPaths, ['.', 'src'])
    assert.equal(legacy.selectedEntryPath, 'src/a.ts')
  })

  void test('broken entries are dropped and defaults fill the gaps', () => {
    const restored = normalizeWorkbenchEditorGroupsLayout(
      {
        groups: [
          { paths: ['a', '', 7, 'a', ' b '], activePath: 'gone' },
          { paths: [] },
          'not a group',
        ],
        focusedGroup: 5,
      },
      32
    )
    // 重复的、空的、不是字符串的路径去掉；当前标签不在标签栏里时取第一个；空组不留；当前组越界回到第一组。
    assert.equal(show(restored), '*[a] b')
  })

  void test('no more than the allowed number of tabs is restored', () => {
    const paths = Array.from({ length: 40 }, (_, index) => `file-${index}.ts`)
    const restored = normalizeWorkbenchEditorGroupsLayout(
      { groups: [{ paths, activePath: 'file-39.ts' }], focusedGroup: 0 },
      32
    )
    assert.equal(listWorkbenchEditorLayoutPaths(restored).length, 32)
    // 当前标签被截掉了：回到第一个。
    assert.equal(getWorkbenchEditorFocusedPath(restored), 'file-0.ts')
  })
})
