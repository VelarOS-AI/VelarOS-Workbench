import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { describe, test } from 'bun:test'

import {
  closeWorkbenchEditorTabs,
  createWorkbenchEditorGroupsLayout,
  findWorkbenchEditorGroupIndex,
  getWorkbenchEditorFocusedPath,
  isWorkbenchEditorTabPinned,
  keepWorkbenchEditorPreviewTabs,
  keepWorkbenchEditorTab,
  listWorkbenchEditorLayoutPaths,
  listWorkbenchEditorTabsToCloseOthers,
  listWorkbenchEditorTabsToCloseToRight,
  listWorkbenchEditorUnpinnedTabs,
  normalizeWorkbenchEditorGroupsLayout,
  openWorkbenchEditorTab,
  pinWorkbenchEditorTab,
  renameWorkbenchEditorLayoutPaths,
  reorderWorkbenchEditorTab,
  unpinWorkbenchEditorTab,
  type WorkbenchEditorGroupsLayout,
} from '../src/renderer/src/models/editor/workbenchEditorGroups'
import {
  buildWorkbenchProjectSessionSnapshot,
  normalizeWorkbenchProjectSession,
} from '../src/renderer/src/models/project/workbenchProjectSessionModel'

/**
 * 布局的样子：组之间用 ` | ` 隔开，当前组前面有 `*`，每组里当前标签用 `[]` 括起来，固定标签前面有 `!`，
 * 预览标签前面有 `~`，如 `*!a [~b] c`。
 */
function show(layout: WorkbenchEditorGroupsLayout): string {
  return layout.groups
    .map((group, index) => {
      const tabs = group.paths.map((path, tabIndex) => {
        const mark = tabIndex < group.pinnedCount ? '!' : path === group.previewPath ? '~' : ''
        const name = `${mark}${path}`
        return path === group.activePath ? `[${name}]` : name
      })
      return `${index === layout.focusedGroup ? '*' : ''}${tabs.join(' ')}`
    })
    .join(' | ')
}

/** 依次以普通标签打开。 */
function open(layout: WorkbenchEditorGroupsLayout, ...paths: string[]): WorkbenchEditorGroupsLayout {
  return paths.reduce((current, path) => openWorkbenchEditorTab(current, path).layout, layout)
}

/** 以预览标签打开一个文件。 */
function preview(layout: WorkbenchEditorGroupsLayout, path: string): WorkbenchEditorGroupsLayout {
  return openWorkbenchEditorTab(layout, path, { preview: true }).layout
}

/** 依次固定。 */
function pin(layout: WorkbenchEditorGroupsLayout, ...paths: string[]): WorkbenchEditorGroupsLayout {
  return paths.reduce((current, path) => pinWorkbenchEditorTab(current, path), layout)
}

function readSource(relativePath: string): string {
  return readFileSync(path.resolve(process.cwd(), relativePath), 'utf8')
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
    const switched = open(layout, 'a')
    assert.equal(show(switched), '*[a] b c')
    // 已经是当前文件：布局对象原样返回，调用方据此不重新渲染。
    assert.equal(open(switched, 'a'), switched)
  })

  void test('closing the current tab shows its left neighbour, else the right one', () => {
    const layout = open(empty, 'a', 'b', 'c', 'd', 'c')
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
    const layout = open(empty, 'src/a.ts', 'src/b.ts', 'c.ts', 'src/b.ts')
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

void describe('preview tabs', () => {
  void test('the next preview takes the place of the current one instead of adding a tab', () => {
    const first = openWorkbenchEditorTab(open(empty, 'a', 'b'), 'p1', { preview: true })
    assert.equal(show(first.layout), '*a b [~p1]')
    assert.equal(first.replacedPath, null)

    // 预览标签不在末尾时，新的预览占它原来的位置；被顶替的那个交给调用方关掉。
    const moved = open(first.layout, 'c')
    assert.equal(show(moved), '*a b ~p1 [c]')
    const second = openWorkbenchEditorTab(moved, 'p2', { preview: true })
    assert.equal(show(second.layout), '*a b [~p2] c')
    assert.equal(second.replacedPath, 'p1')
    assert.deepEqual(listWorkbenchEditorLayoutPaths(second.layout), ['a', 'b', 'p2', 'c'])
  })

  void test('a tab that is already open is only switched to', () => {
    const layout = preview(open(empty, 'a', 'b'), 'p')
    // 普通标签不会变回预览，预览标签也不会被它自己顶替。
    const onNormal = openWorkbenchEditorTab(layout, 'a', { preview: true })
    assert.equal(show(onNormal.layout), '*[a] b ~p')
    assert.equal(onNormal.replacedPath, null)
    assert.equal(show(preview(onNormal.layout, 'p')), '*a b [~p]')
    assert.equal(preview(layout, 'p'), layout)
  })

  void test('opening the preview normally keeps it, and so does asking to keep it', () => {
    const layout = preview(open(empty, 'a'), 'p')
    // 双击文件、快速打开里回车：普通打开，预览标签就此留下（哪怕它已经是当前文件）。
    assert.equal(show(open(layout, 'p')), '*a [p]')
    // 双击标签、编辑、保存。
    assert.equal(show(keepWorkbenchEditorTab(layout, 'p')), '*a [p]')
    assert.equal(keepWorkbenchEditorTab(layout, 'a'), layout)
    assert.equal(keepWorkbenchEditorTab(layout, 'missing'), layout)
    // 留下之后，下一次预览另开一个标签。
    assert.equal(show(preview(keepWorkbenchEditorTab(layout, 'p'), 'q')), '*a p [~q]')
  })

  void test('a normal open never replaces the preview', () => {
    const layout = open(preview(open(empty, 'a'), 'p'), 'b')
    assert.equal(show(layout), '*a ~p [b]')
  })

  void test('closing, dragging and renaming keep track of the preview', () => {
    const layout = preview(open(empty, 'a', 'b'), 'p')
    // 关掉预览标签：这一组不再有预览，下一次预览新开一个。
    const closed = closeWorkbenchEditorTabs(layout, ['p'])
    assert.equal(show(closed), '*a [b]')
    assert.equal(show(preview(closed, 'q')), '*a b [~q]')
    // 关别的标签不影响它。
    assert.equal(show(closeWorkbenchEditorTabs(layout, ['a'])), '*b [~p]')
    // 拖动预览标签就留下它（与 VS Code 一致）；拖别的标签不影响它。
    assert.equal(show(reorderWorkbenchEditorTab(layout, 'p', 'a')), '*[p] a b')
    assert.equal(show(reorderWorkbenchEditorTab(layout, 'a', 'b')), '*b a [~p]')
    // 改名之后还是预览。
    assert.equal(
      show(renameWorkbenchEditorLayoutPaths(layout, (path) => (path === 'p' ? 'renamed' : path))),
      '*a b [~renamed]'
    )
  })

  void test('turning the setting off keeps every preview', () => {
    const layout = preview(open(empty, 'a'), 'p')
    assert.equal(show(keepWorkbenchEditorPreviewTabs(layout)), '*a [p]')
    const none = open(empty, 'a')
    assert.equal(keepWorkbenchEditorPreviewTabs(none), none)
  })
})

void describe('pinned tabs', () => {
  void test('pinned tabs sit at the left in the order they were pinned', () => {
    const layout = open(empty, 'a', 'b', 'c', 'd')
    const pinned = pin(layout, 'c', 'a')
    assert.equal(show(pinned), '*!c !a b [d]')
    assert.equal(isWorkbenchEditorTabPinned(pinned, 'a'), true)
    assert.equal(isWorkbenchEditorTabPinned(pinned, 'b'), false)
    assert.equal(isWorkbenchEditorTabPinned(pinned, 'missing'), false)
    // 已经固定的再固定、没开着的：不变。
    assert.equal(pinWorkbenchEditorTab(pinned, 'c'), pinned)
    assert.equal(pinWorkbenchEditorTab(pinned, 'missing'), pinned)
  })

  void test('unpinning puts the tab first among the regular tabs', () => {
    const pinned = pin(open(empty, 'a', 'b', 'c', 'd'), 'a', 'b', 'c')
    assert.equal(show(unpinWorkbenchEditorTab(pinned, 'a')), '*!b !c a [d]')
    assert.equal(show(unpinWorkbenchEditorTab(pinned, 'c')), '*!a !b c [d]')
    assert.equal(unpinWorkbenchEditorTab(pinned, 'd'), pinned)
    assert.equal(unpinWorkbenchEditorTab(pinned, 'missing'), pinned)
  })

  void test('pinning the preview keeps it; new tabs and previews open after the pinned ones', () => {
    const layout = preview(open(empty, 'a'), 'p')
    const pinned = pinWorkbenchEditorTab(layout, 'p')
    assert.equal(show(pinned), '*[!p] a')
    // 固定标签不是预览标签：下一次预览另开一个，不顶替它。
    assert.equal(show(preview(pinned, 'q')), '*!p a [~q]')
    assert.equal(show(open(pinned, 'b')), '*!p a [b]')
  })

  void test('close others, close to the right and close all skip pinned tabs', () => {
    const layout = pin(open(empty, 'a', 'b', 'c', 'd', 'e'), 'b', 'd')
    assert.equal(show(layout), '*!b !d a c [e]')
    assert.deepEqual(listWorkbenchEditorTabsToCloseOthers(layout, 'c'), ['a', 'e'])
    // 从固定标签上点「关闭其他」：别的固定标签照样留着。
    assert.deepEqual(listWorkbenchEditorTabsToCloseOthers(layout, 'b'), ['a', 'c', 'e'])
    assert.deepEqual(listWorkbenchEditorTabsToCloseToRight(layout, 'a'), ['c', 'e'])
    assert.deepEqual(listWorkbenchEditorTabsToCloseToRight(layout, 'b'), ['a', 'c', 'e'])
    assert.deepEqual(listWorkbenchEditorTabsToCloseToRight(layout, 'e'), [])
    assert.deepEqual(listWorkbenchEditorUnpinnedTabs(layout), ['a', 'c', 'e'])
    assert.deepEqual(listWorkbenchEditorTabsToCloseOthers(layout, 'missing'), [])
    assert.deepEqual(listWorkbenchEditorTabsToCloseToRight(layout, 'missing'), [])

    // 关完之后固定标签还在，当前标签落到最近的那个上。
    assert.equal(
      show(closeWorkbenchEditorTabs(layout, listWorkbenchEditorUnpinnedTabs(layout))),
      '*!b [!d]'
    )
  })

  void test('a pinned tab can still be closed on its own (its file was deleted)', () => {
    const layout = pin(open(empty, 'a', 'b', 'c'), 'a', 'b')
    const closed = closeWorkbenchEditorTabs(layout, ['a'])
    assert.equal(show(closed), '*!b [c]')
    assert.equal(closed.groups[0]?.pinnedCount, 1)
  })

  void test('dragging never crosses between the pinned and the regular tabs', () => {
    const layout = pin(open(empty, 'a', 'b', 'c', 'd'), 'a', 'b')
    assert.equal(show(layout), '*!a !b c [d]')
    // 固定标签之间、普通标签之间可以换位置。
    assert.equal(show(reorderWorkbenchEditorTab(layout, 'b', 'a')), '*!b !a c [d]')
    assert.equal(show(reorderWorkbenchEditorTab(layout, 'd', 'c')), '*!a !b [d] c')
    // 普通标签拖不进固定区，固定标签也拖不出来。
    assert.equal(reorderWorkbenchEditorTab(layout, 'c', 'a'), layout)
    assert.equal(reorderWorkbenchEditorTab(layout, 'a', 'd'), layout)
  })

  void test('renaming keeps a tab pinned', () => {
    const layout = pin(open(empty, 'a', 'b', 'c'), 'b')
    assert.equal(
      show(renameWorkbenchEditorLayoutPaths(layout, (path) => (path === 'b' ? 'renamed' : path))),
      '*!renamed a [c]'
    )
    // 固定标签改名后撞上后面一个开着的文件：留下固定的那个。
    assert.equal(
      show(renameWorkbenchEditorLayoutPaths(layout, (path) => (path === 'c' ? 'b' : path))),
      '*[!b] a'
    )
  })
})

void describe('preview tab wiring', () => {
  const controller = readSource('src/renderer/src/hooks/useWorkbenchEditorController.ts')
  const adapter = readSource('src/renderer/src/components/embedded/workbenchEmbeddedKernelAdapter.ts')

  void test('a single click previews, a double click or Enter opens a normal tab', () => {
    const row = readSource('src/renderer/src/components/files/FileTreeRow.tsx')
    const results = readSource('src/renderer/src/components/files/FileSearchResults.tsx')
    const searchView = readSource('src/renderer/src/components/files/ProjectSearchView.tsx')
    const presentation = readSource('src/renderer/src/StandaloneWorkbenchPagePresentation.tsx')

    // 文件树：单击（onActivate）预览，双击普通；改名输入框里的双击不算。
    assert.match(
      adapter,
      /onSelectFile: \(path\) => \{\s*model\.actions\.showEditorSurface\(\)\s*void editorNavigation\.selectFile\(path, \{ preview: true \}\)/u
    )
    assert.match(
      adapter,
      /onOpenFile: \(path\) => \{\s*model\.actions\.showEditorSurface\(\)\s*void editorNavigation\.selectFile\(path\)\s*\}/u
    )
    assert.match(
      row,
      /onDoubleClick=\{\s*entry\.type === 'file' && !node\.isEditing \? \(\) => onOpenFile\(entry\) : undefined\s*\}/u
    )
    // 搜索结果：单击预览；双击与查找框里的回车不带预览。
    assert.match(results, /onOpenEntry\(row\.entry, \{ preview: true \}\)/u)
    assert.match(results, /onOpenMatch\(row\.file, row\.match, \{ preview: true \}\)/u)
    assert.match(results, /onDoubleClick=\{\(\) => handleDoubleClick\(row\)\}/u)
    assert.match(
      searchView,
      /function openRow[\s\S]*?onOpenEntry\(row\.entry\)\s*else if \(row\.kind === 'match'\) engine\.openMatch\(row\.file, row\.match\)\s*\}/u
    )
    // 问题面板点一条、跳到定义：预览；跳到定义时出发的预览标签先留下。
    assert.match(presentation, /editorNavigation\.goToLocation\(path, line, column, \{ preview: true \}\)/u)
    assert.match(
      adapter,
      /onGoToDefinition: \(path, line, column\) =>\s*void editorNavigation\.goToLocation\(path, line, column, \{\s*preview: true,\s*keepSource: true,\s*\}\)/u
    )
    // 终端里的路径、快速打开：普通标签（不带 preview）。
    assert.match(presentation, /navigate\(\{ target: 'file', path, line, column \}\)/u)
    const pageModel = readSource('src/renderer/src/hooks/useStandaloneWorkbenchPageModel.tsx')
    assert.match(
      pageModel,
      /const openQuickOpenFile[\s\S]*?navigate\(\{ target: 'file', path, line: cursor\.line, column: cursor\.column \}\)/u
    )
  })

  void test('clicking a tab only switches to it, double-clicking keeps it', () => {
    const tabBar = readSource('src/renderer/src/components/editor/EditorTabBar.tsx')
    const styles = readSource('src/renderer/src/styles/09-editor.module.css')

    assert.match(
      adapter,
      /onSelectOpenFile: \(path\) => \{\s*model\.actions\.showEditorSurface\(\)\s*void editorNavigation\.selectFile\(path, \{ preview: true \}\)/u
    )
    assert.match(adapter, /onKeepOpenFile: workbench\.keepOpenFile/u)
    assert.match(tabBar, /onDoubleClick=\{\(\) => onKeepOpenFile\?\.\(tab\.path\)\}/u)
    assert.match(tabBar, /data-preview=\{tab\.path === previewTabPath\}/u)
    assert.match(styles, /\.editorTab\[data-preview='true'\] \.editorTabName,[\s\S]*?font-style: italic;/u)
  })

  void test('editing, saving and the setting keep the preview; a replaced preview is closed', () => {
    // 正文一改就留下（输入、格式化、跨文件改名、项目替换都经过这里）。
    assert.match(
      controller,
      /function updateOpenTabContent\(file: WorkbenchReadFileResult, content: string\): void \{\s*keepOpenFile\(file\.path\)/u
    )
    // 明确保存：没有改动也留下。
    assert.match(
      controller,
      /const saveSelectedFile = [\s\S]*?if \(!selectedFile\) return[\s\S]*?keepOpenFile\(selectedFile\.path\)[\s\S]*?if \(!isDirtyTab\(/u
    )
    // 被顶替的预览标签：文件随之关掉，不进「重新打开关闭的标签」。
    const show = controller.slice(
      controller.indexOf('function showOpenTab'),
      controller.indexOf('const selectFile')
    )
    assert.match(show, /if \(opened\.replacedPath\) forgetOpenTabs\(\[opened\.replacedPath\]\)/u)
    assert.doesNotMatch(show, /closedTabPathsRef/u)
    assert.match(show, /preview: !!options\.preview && previewTabsEnabledLatest\.current/u)
    assert.match(show, /options\.keepSource && sourcePath && sourcePath !== path/u)
    // 文件还在读的时候又被普通打开（双击的第二下）：读完开成普通标签。
    assert.match(controller, /if \(!options\.preview\) pendingOpenKeepsTabRef\.current = true/u)
    // 设置关掉：已有的预览标签留下。
    assert.match(
      controller,
      /if \(!previewTabsEnabled\) commitLayout\(keepWorkbenchEditorPreviewTabs\(layoutRef\.current\)\)/u
    )
    const pageModel = readSource('src/renderer/src/hooks/useStandaloneWorkbenchPageModel.tsx')
    assert.match(pageModel, /previewTabsEnabled: workbenchPreferences\.preferences\.editorPreviewTabs/u)
    const settings = readSource('src/renderer/src/components/settings/WorkbenchSettingsDialog.tsx')
    assert.match(settings, /checked=\{preferences\.editorPreviewTabs\}/u)
    const preferences = readSource('src/renderer/src/models/settings/workbenchPreferences.ts')
    assert.match(preferences, /editorPreviewTabs: true,/u)
  })
})

void describe('pinned tab wiring', () => {
  void test('the pin replaces the close button, and Cmd/Ctrl+W and middle click leave it alone', () => {
    const tabBar = readSource('src/renderer/src/components/editor/EditorTabBar.tsx')
    const editorPanel = readSource('src/renderer/src/components/editor/EditorPanel.tsx')
    const controller = readSource('src/renderer/src/hooks/useWorkbenchEditorController.ts')

    // 固定标签上是图钉（点它取消固定），不是关闭按钮。
    assert.match(
      tabBar,
      /\{isPinned \? \([\s\S]*?onClick=\{\(\) => onUnpinOpenFile\?\.\(tab\.path\)\}[\s\S]*?<PushPinIcon[\s\S]*?\) : \([\s\S]*?onClick=\{\(\) => onCloseOpenFile\(tab\.path\)\}/u
    )
    assert.match(tabBar, /if \(!isPinned\) onCloseOpenFile\(tab\.path\)/u)
    assert.match(
      tabBar,
      /\(contextTabIsPinned \? onUnpinOpenFile : onPinOpenFile\)\(tabContextMenu\.path\)/u
    )
    assert.match(tabBar, /t\(contextTabIsPinned \? 'workbench\.unpinEditorTab' : 'workbench\.pinEditorTab'\)/u)
    // 拖放：落点与被拖的标签不在同一个区（固定 / 普通）就不接。
    assert.match(
      tabBar,
      /isPinnedTabPath\(draggingTabPath\) === isPinnedTabPath\(path\)/u
    )
    assert.match(tabBar, /if \(!canDropTabOn\(path\)\) return\s*event\.preventDefault\(\)/u)
    assert.match(editorPanel, /selectedTabPinned = !!selectedTab && openTabs\.indexOf\(selectedTab\) < pinnedTabCount/u)

    // 批量关闭只关没固定的。
    assert.match(
      controller,
      /const closeAllOpenFiles = [\s\S]*?requestCloseOpenFiles\(listWorkbenchEditorUnpinnedTabs\(layoutRef\.current\)\)/u
    )
    assert.match(
      controller,
      /const closeUnmodifiedOpenFiles = [\s\S]*?listWorkbenchEditorUnpinnedTabs\(layoutRef\.current\)\.filter\(/u
    )
    assert.match(
      controller,
      /requestCloseOpenFiles\(listWorkbenchEditorTabsToCloseOthers\(layoutRef\.current, path\)\)/u
    )
    assert.match(
      controller,
      /requestCloseOpenFiles\(listWorkbenchEditorTabsToCloseToRight\(layoutRef\.current, path\)\)/u
    )
  })
})

void describe('saved editor tab layout', () => {
  void test('a saved layout round-trips through the project session', () => {
    const layout = preview(pin(open(empty, 'a', 'b', 'c', 'b'), 'c'), 'd')
    const session = buildWorkbenchProjectSessionSnapshot({
      expandedPaths: ['.'],
      selectedEntryPath: 'b',
      editorLayout: layout,
      cursorByPath: { b: { line: 3, column: 7 } },
    })
    const restored = normalizeWorkbenchProjectSession(JSON.parse(JSON.stringify(session)))
    // 固定标签重启之后还是固定的，预览标签还是预览标签。
    assert.equal(show(restored.editorLayout), '*!c a b [~d]')
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
          { paths: ['a', '', 7, 'a', ' b '], activePath: 'gone', previewPath: 'gone too' },
          { paths: [] },
          'not a group',
        ],
        focusedGroup: 5,
      },
      32
    )
    // 重复的、空的、不是字符串的路径去掉；当前标签不在标签栏里时取第一个，预览标签不在就没有；空组不留；
    // 当前组越界回到第一组。
    assert.equal(show(restored), '*[a] b')
  })

  void test('the pinned count is checked against the tabs that survive', () => {
    const restore = (group: Record<string, unknown>): string =>
      show(normalizeWorkbenchEditorGroupsLayout({ groups: [group], focusedGroup: 0 }, 32))

    assert.equal(restore({ paths: ['a', 'b', 'c'], pinnedCount: 2, activePath: 'c' }), '*!a !b [c]')
    // 个数不对（负数、不是数、比标签还多）：按没有固定或全部固定收住，不报错。
    assert.equal(restore({ paths: ['a', 'b'], pinnedCount: -3, activePath: 'a' }), '*[a] b')
    assert.equal(restore({ paths: ['a', 'b'], pinnedCount: 'two', activePath: 'a' }), '*[a] b')
    assert.equal(restore({ paths: ['a', 'b'], pinnedCount: 9, activePath: 'a' }), '*[!a] !b')
    // 固定区里有坏条目：丢掉它，后面的普通标签不会顶上来变成固定的。
    assert.equal(restore({ paths: ['a', '', 'b', 'c'], pinnedCount: 2, activePath: 'c' }), '*!a b [c]')
    // 预览标签不能是固定标签。
    assert.equal(
      restore({ paths: ['a', 'b'], pinnedCount: 1, previewPath: 'a', activePath: 'b' }),
      '*!a [b]'
    )
    assert.equal(
      restore({ paths: ['a', 'b'], pinnedCount: 1, previewPath: 'b', activePath: 'b' }),
      '*!a [~b]'
    )
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
