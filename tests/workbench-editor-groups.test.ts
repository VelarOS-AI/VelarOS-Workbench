import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { describe, test } from 'bun:test'

import {
  closeWorkbenchEditorTabs,
  createWorkbenchEditorGroupsLayout,
  findWorkbenchEditorGroupIndex,
  focusWorkbenchEditorGroup,
  getWorkbenchEditorFocusedPath,
  isWorkbenchEditorTabPinned,
  keepWorkbenchEditorPreviewTabs,
  keepWorkbenchEditorTab,
  listWorkbenchEditorLayoutPaths,
  listWorkbenchEditorTabsToCloseOthers,
  listWorkbenchEditorTabsToCloseToRight,
  listWorkbenchEditorUnpinnedTabs,
  moveWorkbenchEditorTabToGroup,
  normalizeWorkbenchEditorGroupsLayout,
  openWorkbenchEditorTab,
  pinWorkbenchEditorTab,
  renameWorkbenchEditorLayoutPaths,
  reorderWorkbenchEditorTab,
  resolveWorkbenchEditorTabGroupIndex,
  setWorkbenchEditorSplitRatio,
  unpinWorkbenchEditorTab,
  type WorkbenchEditorGroupsLayout,
} from '../src/renderer/src/models/editor/workbenchEditorGroups'
import { buildWorkbenchEditorGroupViews } from '../src/renderer/src/models/editor/workbenchEditorGroupViews'
import {
  beginWorkbenchEditorTabDrag,
  canDropWorkbenchEditorTabOn,
  canDropWorkbenchEditorTabOnGroup,
  endWorkbenchEditorTabDrag,
  readWorkbenchEditorTabDrag,
  WorkbenchEditorTabDragType,
} from '../src/renderer/src/models/editor/workbenchEditorTabDrag'
import { WorkbenchNavigationHistory } from '../src/renderer/src/models/editor/workbenchNavigationHistory'
import {
  isWorkbenchPaletteCommandAvailable,
  type WorkbenchPaletteCommandContext,
} from '../src/renderer/src/models/layout/workbenchCommandPalette'
import {
  DEFAULT_WORKBENCH_KEYBOARD_SHORTCUT_MAP,
  formatWorkbenchShortcutHint,
  getWorkbenchKeyboardShortcut,
} from '../src/renderer/src/models/layout/workbenchKeyboardShortcuts'
import {
  buildWorkbenchProjectSessionSnapshot,
  normalizeWorkbenchProjectSession,
} from '../src/renderer/src/models/project/workbenchProjectSessionModel'
import type { WorkbenchOpenEditorTab } from '../src/renderer/src/types/workbenchTypes'

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

/** 依次挪到右边那组（没有就新开）。 */
function toRight(layout: WorkbenchEditorGroupsLayout, ...paths: string[]): WorkbenchEditorGroupsLayout {
  return paths.reduce((current, path) => moveWorkbenchEditorTabToGroup(current, path, 1), layout)
}

function tab(path: string, content = path, diskContent = content): WorkbenchOpenEditorTab {
  return {
    path,
    content,
    file: {
      projectRoot: '/project',
      path,
      content: diskContent,
      size: diskContent.length,
      modifiedAt: 1,
      totalLines: 1,
      truncated: false,
      encoding: 'utf8',
      eol: 'lf',
    } as WorkbenchOpenEditorTab['file'],
  }
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
    // 问题面板：单击一条预览，双击普通。
    const problems = readSource('src/renderer/src/components/editor/CodeInsightPanel.tsx')
    assert.match(problems, /onClick=\{\(\) => handleProblemSelect\(problem, \{ preview: true \}\)\}/u)
    assert.match(problems, /onDoubleClick=\{\(\) => handleProblemSelect\(problem\)\}/u)
    assert.match(
      presentation,
      /editorNavigation\.goToLocation\(path, line, column, \{\s*preview: intent\?\.preview,\s*\}\)/u
    )
    // 跳到定义：预览；出发的预览标签先留下。
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
      /const saveSelectedFile = [\s\S]*?if \(!tab\) return[\s\S]*?keepOpenFile\(tab\.path\)[\s\S]*?if \(!isDirtyTab\(/u
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
      /\{isPinned \? \([\s\S]*?onClick=\{\(\) => onUnpinOpenFile\?\.\(tab\.path\)\}[\s\S]*?<PushPinSimpleIcon[\s\S]*?\) : \([\s\S]*?onClick=\{\(\) => onCloseOpenFile\(tab\.path\)\}/u
    )
    assert.match(tabBar, /if \(!isPinned\) onCloseOpenFile\(tab\.path\)/u)
    assert.match(
      tabBar,
      /\(contextTabIsPinned \? onUnpinOpenFile : onPinOpenFile\)\(tabContextMenu\.path\)/u
    )
    assert.match(tabBar, /t\(contextTabIsPinned \? 'workbench\.unpinEditorTab' : 'workbench\.pinEditorTab'\)/u)
    // 拖放：落点与被拖的标签不在同一个区（固定 / 普通）就不接（规则在 canDropWorkbenchEditorTabOn 里）。
    assert.match(
      tabBar,
      /canDropWorkbenchEditorTabOn\(readTabDrag\(event\), \{\s*path,\s*groupIndex,\s*pinned: isPinnedTabPath\(path\),\s*\}\)/u
    )
    assert.match(tabBar, /if \(!canDropTabOn\(path, event\)\) return\s*event\.preventDefault\(\)/u)
    assert.match(editorPanel, /selectedTabPinned = !!selectedTab && openTabs\.indexOf\(selectedTab\) < pinnedTabCount/u)

    // 批量关闭只关没固定的。
    assert.match(
      controller,
      /const closeAllOpenFiles = [\s\S]*?requestCloseOpenFiles\(listWorkbenchEditorUnpinnedTabs\(layoutRef\.current, groupIndex\)\)/u
    )
    assert.match(
      controller,
      /const closeUnmodifiedOpenFiles = [\s\S]*?listWorkbenchEditorUnpinnedTabs\(layoutRef\.current, groupIndex\)\.filter\(/u
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

void describe('two editor groups side by side', () => {
  void test('splitting moves the tab into a new right group and the left shows its neighbour', () => {
    const layout = open(empty, 'a', 'b', 'c')
    const split = toRight(layout, 'c')
    // 同一个文件只在一组里：右边有了 c，左边改显示它旁边的 b；当前组是右边那组。
    assert.equal(show(split), 'a [b] | *[c]')
    assert.equal(getWorkbenchEditorFocusedPath(split), 'c')
    assert.deepEqual(listWorkbenchEditorLayoutPaths(split), ['a', 'b', 'c'])
    assert.equal(findWorkbenchEditorGroupIndex(split, 'c'), 1)

    // 再挪一个过去：加在右边那组的末尾。
    assert.equal(show(toRight(split, 'a')), '[b] | *c [a]')
    // 已经在右边那组的：不变。
    assert.equal(toRight(split, 'c'), split)
    // 没开着的、不存在的组：不变。
    assert.equal(toRight(split, 'missing'), split)
    assert.equal(moveWorkbenchEditorTabToGroup(split, 'a', 2), split)
    assert.equal(moveWorkbenchEditorTabToGroup(split, 'a', -1), split)
  })

  void test('splitting the only tab of the only group changes nothing', () => {
    const single = open(empty, 'a')
    assert.equal(toRight(single, 'a'), single)
  })

  void test('moving the last tab out of a group leaves one group', () => {
    const split = toRight(open(empty, 'a', 'b'), 'b')
    assert.equal(show(split), '[a] | *[b]')
    // 左边的最后一个标签挪到右边：右边那组成为唯一的一组。
    assert.equal(show(toRight(split, 'a')), '*b [a]')
    // 右边的最后一个标签挪回左边：只剩左边那组。
    assert.equal(show(moveWorkbenchEditorTabToGroup(split, 'b', 0)), '*a [b]')
  })

  void test('closing the last tab of a group closes the group', () => {
    const split = toRight(open(empty, 'a', 'b', 'c'), 'c')
    assert.equal(show(split), 'a [b] | *[c]')
    // 右边关空了：只剩左边，当前组落回左边。
    assert.equal(show(closeWorkbenchEditorTabs(split, ['c'])), '*a [b]')
    // 左边关空了而右边还有标签：右边那组成为唯一的一组。
    assert.equal(show(closeWorkbenchEditorTabs(split, ['a', 'b'])), '*[c]')
    // 当前组是左边、右边关空了：当前组不变。
    const leftFocused = focusWorkbenchEditorGroup(split, 0)
    assert.equal(show(closeWorkbenchEditorTabs(leftFocused, ['c'])), '*a [b]')
    // 全关了：一个空组。
    assert.equal(show(closeWorkbenchEditorTabs(split, ['a', 'b', 'c'])), '*')
  })

  void test('each group keeps its own current tab, preview and pinned tabs', () => {
    let layout = toRight(open(empty, 'a', 'b', 'c', 'd'), 'c', 'd')
    assert.equal(show(layout), 'a [b] | *c [d]')
    layout = pin(layout, 'd')
    layout = preview(layout, 'p')
    assert.equal(show(layout), 'a [b] | *!d c [~p]')
    // 回到左边那组开预览：左边有自己的预览标签，右边那个不受影响。
    layout = preview(focusWorkbenchEditorGroup(layout, 0), 'q')
    assert.equal(show(layout), '*a b [~q] | !d c [~p]')
    layout = pin(layout, 'a')
    assert.equal(show(layout), '*!a b [~q] | !d c [~p]')
    // 左边再开一个预览：只顶替左边的。
    const next = openWorkbenchEditorTab(layout, 'r', { preview: true })
    assert.equal(show(next.layout), '*!a b [~r] | !d c [~p]')
    assert.equal(next.replacedPath, 'q')
  })

  void test('opening a file that is open in the other group goes there instead of opening it twice', () => {
    const split = focusWorkbenchEditorGroup(toRight(open(empty, 'a', 'b', 'c'), 'b', 'c'), 0)
    assert.equal(show(split), '*[a] | b [c]')
    const opened = open(split, 'b')
    assert.equal(show(opened), '[a] | *[b] c')
    assert.deepEqual(listWorkbenchEditorLayoutPaths(opened), ['a', 'b', 'c'])
    // 新文件开在当前组；指名开在哪一组（后退 / 前进）就开在那一组，那一组不在了落到最靠右的一组。
    assert.equal(show(open(split, 'n')), '*a [n] | b [c]')
    assert.equal(show(openWorkbenchEditorTab(split, 'n', { groupIndex: 1 }).layout), '[a] | *b c [n]')
    assert.equal(show(openWorkbenchEditorTab(open(empty, 'a'), 'n', { groupIndex: 1 }).layout), '*a [n]')
    assert.equal(resolveWorkbenchEditorTabGroupIndex(split, 'c'), 1)
    assert.equal(resolveWorkbenchEditorTabGroupIndex(split, 'c', 0), 1)
    assert.equal(resolveWorkbenchEditorTabGroupIndex(split, 'n'), 0)
    assert.equal(resolveWorkbenchEditorTabGroupIndex(split, 'n', 1), 1)
    assert.equal(resolveWorkbenchEditorTabGroupIndex(open(empty, 'a'), 'n', 1), 0)
  })

  void test('a moved tab keeps its pin, stops being a preview, and lands in the matching area', () => {
    let layout = toRight(open(empty, 'a', 'b', 'c', 'd', 'e'), 'd', 'e')
    layout = pin(layout, 'a', 'd')
    assert.equal(show(layout), '!a b [c] | *!d [e]')

    // 固定标签挪过去还是固定的，排在那边固定标签的末尾。
    assert.equal(show(toRight(layout, 'a')), 'b [c] | *!d [!a] e')
    // 普通标签挪过去加在末尾；拖到某个标签前面就落在它前面。
    assert.equal(show(toRight(layout, 'b')), '!a [c] | *!d e [b]')
    assert.equal(show(moveWorkbenchEditorTabToGroup(layout, 'b', 1, 'e')), '!a [c] | *!d [b] e')
    // 普通标签拖到对方的固定标签上：进不了固定区，落在普通标签的最前面。
    assert.equal(show(moveWorkbenchEditorTabToGroup(layout, 'b', 1, 'd')), '!a [c] | *!d [b] e')
    // 固定标签拖到对方的普通标签上：留在固定区的末尾。
    assert.equal(show(moveWorkbenchEditorTabToGroup(layout, 'a', 1, 'e')), 'b [c] | *!d [!a] e')
    assert.equal(show(moveWorkbenchEditorTabToGroup(layout, 'a', 1, 'd')), 'b [c] | *[!a] !d e')

    // 预览标签挪过去就留下，那边自己的预览标签不变。
    const previews = preview(focusWorkbenchEditorGroup(preview(layout, 'p'), 0), 'q')
    assert.equal(show(previews), '*!a b c [~q] | !d e [~p]')
    assert.equal(show(toRight(previews, 'q')), '!a b [c] | *!d e ~p [q]')
  })

  void test('dropping on a tab of the same group is a reorder', () => {
    const layout = toRight(open(empty, 'a', 'b', 'c', 'd'), 'c', 'd')
    assert.equal(show(moveWorkbenchEditorTabToGroup(layout, 'd', 1, 'c')), 'a [b] | *[d] c')
    assert.equal(moveWorkbenchEditorTabToGroup(layout, 'd', 1), layout)
  })

  void test('focus moves between the groups and the divider stays within its limits', () => {
    const split = toRight(open(empty, 'a', 'b'), 'b')
    assert.equal(split.focusedGroup, 1)
    const left = focusWorkbenchEditorGroup(split, 0)
    assert.equal(show(left), '*[a] | [b]')
    assert.equal(getWorkbenchEditorFocusedPath(left), 'a')
    assert.equal(focusWorkbenchEditorGroup(left, 0), left)
    assert.equal(focusWorkbenchEditorGroup(left, 2), left)
    assert.equal(focusWorkbenchEditorGroup(open(empty, 'a'), 1).focusedGroup, 0)

    assert.equal(split.splitRatio, 0.5)
    assert.equal(setWorkbenchEditorSplitRatio(split, 0.3).splitRatio, 0.3)
    assert.equal(setWorkbenchEditorSplitRatio(split, 0.01).splitRatio, 0.2)
    assert.equal(setWorkbenchEditorSplitRatio(split, 0.99).splitRatio, 0.8)
    assert.equal(setWorkbenchEditorSplitRatio(split, Number.NaN).splitRatio, 0.5)
    assert.equal(setWorkbenchEditorSplitRatio(split, 0.5), split)
    // 收成一组之后比例留着，下次拆分接着用。
    const resized = setWorkbenchEditorSplitRatio(split, 0.3)
    assert.equal(closeWorkbenchEditorTabs(resized, ['b']).splitRatio, 0.3)
  })

  void test('close others, to the right and all work on one group', () => {
    const layout = pin(toRight(open(empty, 'a', 'b', 'c', 'd', 'e'), 'd', 'e'), 'a')
    assert.equal(show(layout), '!a b [c] | *d [e]')
    assert.deepEqual(listWorkbenchEditorTabsToCloseOthers(layout, 'c'), ['b'])
    assert.deepEqual(listWorkbenchEditorTabsToCloseOthers(layout, 'd'), ['e'])
    assert.deepEqual(listWorkbenchEditorTabsToCloseToRight(layout, 'a'), ['b', 'c'])
    assert.deepEqual(listWorkbenchEditorTabsToCloseToRight(layout, 'd'), ['e'])
    // 标签栏上的「关闭全部」只管自己那一组；命令面板里的不分组。
    assert.deepEqual(listWorkbenchEditorUnpinnedTabs(layout, 0), ['b', 'c'])
    assert.deepEqual(listWorkbenchEditorUnpinnedTabs(layout, 1), ['d', 'e'])
    assert.deepEqual(listWorkbenchEditorUnpinnedTabs(layout), ['b', 'c', 'd', 'e'])
  })

  void test('renaming follows a file into whichever group holds it', () => {
    const layout = toRight(open(empty, 'src/a', 'src/b', 'c'), 'src/b')
    assert.equal(
      show(renameWorkbenchEditorLayoutPaths(layout, (path) => path.replace(/^src\//u, 'lib/'))),
      'lib/a [c] | *[lib/b]'
    )
    // 改名后撞上另一组里开着的文件：只留前面那个，挪空了的组收掉。
    assert.equal(
      show(renameWorkbenchEditorLayoutPaths(layout, (path) => (path === 'src/b' ? 'c' : path))),
      '*src/a [c]'
    )
  })

  void test('the drop rule: within a group only inside the same area, across groups anywhere', () => {
    const drag = { path: 'b', groupIndex: 0, pinned: false }
    assert.equal(canDropWorkbenchEditorTabOn(null, { path: 'a', groupIndex: 0, pinned: false }), false)
    assert.equal(canDropWorkbenchEditorTabOn(drag, { path: 'c', groupIndex: 0, pinned: false }), true)
    assert.equal(canDropWorkbenchEditorTabOn(drag, { path: 'b', groupIndex: 0, pinned: false }), false)
    assert.equal(canDropWorkbenchEditorTabOn(drag, { path: 'a', groupIndex: 0, pinned: true }), false)
    assert.equal(
      canDropWorkbenchEditorTabOn({ ...drag, pinned: true }, { path: 'c', groupIndex: 0, pinned: false }),
      false
    )
    // 另一组的标签上都能落：落在哪个区由布局决定。
    assert.equal(canDropWorkbenchEditorTabOn(drag, { path: 'd', groupIndex: 1, pinned: true }), true)
    assert.equal(canDropWorkbenchEditorTabOn(drag, { path: 'e', groupIndex: 1, pinned: false }), true)
  })

  void test('a group takes a tab dropped on its editor only from the other group', () => {
    const drag = { path: 'b', groupIndex: 0, pinned: false }
    assert.equal(canDropWorkbenchEditorTabOnGroup(drag, 1), true)
    // 自己这一组的标签不接：在一组里换位置只在标签栏上做。
    assert.equal(canDropWorkbenchEditorTabOnGroup(drag, 0), false)
    assert.equal(canDropWorkbenchEditorTabOnGroup(null, 1), false)
  })

  void test('only a drag that carries the editor tab type is read as a tab drag', () => {
    const drag = { path: 'b', groupIndex: 0, pinned: false }
    beginWorkbenchEditorTabDrag(drag)
    try {
      assert.deepEqual(readWorkbenchEditorTabDrag([WorkbenchEditorTabDragType, 'text/plain']), drag)
      // 文件树里的文件、选中的文字：带的不是标签的类型，标签栏与各组都不接。
      assert.equal(readWorkbenchEditorTabDrag(['text/plain']), null)
      assert.equal(readWorkbenchEditorTabDrag(['Files']), null)
    } finally {
      endWorkbenchEditorTabDrag()
    }
    // 拖放结束之后不再认：上一次拖的标签不会被下一次别的拖放带出来。
    assert.equal(readWorkbenchEditorTabDrag([WorkbenchEditorTabDragType]), null)
  })

  void test('each group is rendered from its own tabs and its own current file', () => {
    const layout = pin(toRight(open(empty, 'a', 'b', 'c'), 'c'), 'a')
    const tabsByPath = new Map([
      ['a', tab('a')],
      ['b', tab('b', 'edited', 'on disk')],
      ['c', tab('c')],
    ])
    const views = buildWorkbenchEditorGroupViews(layout, tabsByPath, new Map([['c', 'read-only']]))
    assert.deepEqual(
      views.map((view) => ({
        index: view.index,
        focused: view.focused,
        tabs: view.tabs.map((item) => item.path),
        pinnedCount: view.pinnedCount,
        active: view.activeTab?.path,
        content: view.activeTab?.content,
        editMode: view.editMode,
        canEdit: view.canEdit,
      })),
      [
        {
          index: 0,
          focused: false,
          tabs: ['a', 'b'],
          pinnedCount: 1,
          active: 'b',
          content: 'edited',
          editMode: 'edit',
          canEdit: true,
        },
        {
          index: 1,
          focused: true,
          tabs: ['c'],
          pinnedCount: 0,
          active: 'c',
          content: 'c',
          editMode: 'read-only',
          canEdit: false,
        },
      ]
    )
    // 没有标签的那一组：没有当前文件。
    const [only] = buildWorkbenchEditorGroupViews(empty, new Map(), new Map())
    assert.equal(only?.activeTab, null)
    assert.equal(only?.editMode, null)
    assert.equal(only?.canEdit, false)
  })

  void test('history points remember their group', () => {
    const history = new WorkbenchNavigationHistory()
    history.record({ path: 'a', line: 3, column: 1, group: 0 })
    history.record({ path: 'c', line: 9, column: 2, group: 1 })
    assert.deepEqual(history.back({ path: 'b', line: 1, column: 1, group: 0 }), {
      path: 'c',
      line: 9,
      column: 2,
      group: 1,
    })
    assert.deepEqual(history.back({ path: 'c', line: 9, column: 2, group: 1 }), {
      path: 'a',
      line: 3,
      column: 1,
      group: 0,
    })
  })

  void test('Cmd/Ctrl+\\ splits, Cmd/Ctrl+1 and 2 focus the left and right group', () => {
    const key = (code: string, value: string, platform: 'mac' | 'other') => ({
      key: value,
      code,
      metaKey: platform === 'mac',
      ctrlKey: platform === 'other',
      altKey: false,
      shiftKey: false,
    })
    const keymap = DEFAULT_WORKBENCH_KEYBOARD_SHORTCUT_MAP
    assert.equal(keymap['split-editor-right'], 'Mod+Backslash')
    assert.equal(
      getWorkbenchKeyboardShortcut(key('Backslash', '\\', 'mac'), keymap, 'MacIntel'),
      'split-editor-right'
    )
    // 中文输入法下这个键打出来是顿号：按物理键认。
    assert.equal(
      getWorkbenchKeyboardShortcut(key('Backslash', '、', 'mac'), keymap, 'MacIntel'),
      'split-editor-right'
    )
    assert.equal(
      getWorkbenchKeyboardShortcut(key('Backslash', '\\', 'other'), keymap, 'Win32'),
      'split-editor-right'
    )
    assert.equal(
      getWorkbenchKeyboardShortcut(key('Digit1', '1', 'mac'), keymap, 'MacIntel'),
      'focus-left-editor-group'
    )
    assert.equal(
      getWorkbenchKeyboardShortcut(key('Digit2', '2', 'other'), keymap, 'Linux x86_64'),
      'focus-right-editor-group'
    )
    assert.equal(formatWorkbenchShortcutHint('Mod+Backslash', 'MacIntel'), '⌘\\')
    assert.equal(formatWorkbenchShortcutHint('Mod+Backslash', 'Win32'), 'Ctrl+\\')
    // 应用菜单没有占这几个键（⌘0 是重置缩放，不相干）。
    const menu = readSource('src/main/projects/ProjectHubMenu.ts')
    assert.doesNotMatch(menu, /accelerator: 'CmdOrCtrl\+(?:1|2|\\\\)'/u)
  })

  void test('the palette offers the split only when it would move something', () => {
    const context: WorkbenchPaletteCommandContext = {
      hasActiveFile: true,
      activeFileIsText: true,
      canEditActiveFile: true,
      canToggleReadOnly: true,
      editorCovered: false,
      openTabCount: 2,
      canSplitEditorRight: true,
      editorGroupCount: 1,
    }
    assert.equal(isWorkbenchPaletteCommandAvailable('split-editor-right', context), true)
    assert.equal(
      isWorkbenchPaletteCommandAvailable('split-editor-right', { ...context, canSplitEditorRight: false }),
      false
    )
    assert.equal(
      isWorkbenchPaletteCommandAvailable('split-editor-right', { ...context, editorCovered: true }),
      false
    )
    assert.equal(isWorkbenchPaletteCommandAvailable('focus-right-editor-group', context), false)
    assert.equal(
      isWorkbenchPaletteCommandAvailable('focus-right-editor-group', { ...context, editorGroupCount: 2 }),
      true
    )
    assert.equal(
      isWorkbenchPaletteCommandAvailable('focus-left-editor-group', { ...context, editorGroupCount: 2 }),
      true
    )
  })
})

void describe('split editor wiring', () => {
  const groupsPanel = readSource('src/renderer/src/components/editor/EditorGroupsPanel.tsx')
  const editorPanel = readSource('src/renderer/src/components/editor/EditorPanel.tsx')
  const adapter = readSource('src/renderer/src/components/embedded/workbenchEmbeddedKernelAdapter.ts')
  const pageModel = readSource('src/renderer/src/hooks/useStandaloneWorkbenchPageModel.tsx')
  const controller = readSource('src/renderer/src/hooks/useWorkbenchEditorController.ts')

  void test('the editor area renders one panel per group around a draggable divider', () => {
    const kernel = readSource('src/renderer/src/components/embedded/WorkbenchEmbeddedKernel.tsx')
    assert.match(
      kernel,
      /<EditorGroupsPanel[\s\S]*?groups=\{editor\.groups\}\s*layout=\{editor\.layout\}\s*diff=\{editorDiff\}/u
    )
    assert.match(adapter, /groups: workbench\.editorGroups\.map\(buildEditorGroup\)/u)
    assert.match(groupsPanel, /\{visibleGroups\.map\(\(group, index\) => \(/u)
    // 点进哪一组、焦点落进哪一组，那一组就是当前组。
    assert.match(groupsPanel, /onMouseDownCapture=\{\(\) => focusGroup\(index\)\}/u)
    assert.match(groupsPanel, /onFocusCapture=\{\(\) => focusGroup\(index\)\}/u)
    // 分隔条：拖的时候直接改样式，松手记一次；双击恢复成一样宽。
    assert.match(groupsPanel, /onPointerDown=\{beginResize\}/u)
    assert.match(
      groupsPanel,
      /onDoubleClick=\{\(\) => onSplitRatioChange\(DefaultWorkbenchEditorSplitRatio\)\}/u
    )
    assert.equal(groupsPanel.match(/onSplitRatioChange\(/gu)?.length, 2)
    const styles = readSource('src/renderer/src/styles/09-editor.module.css')
    assert.match(styles, /\.editorGroup \{[^}]*flex: 1 1 0;/u)
    assert.match(styles, /\.editorGroup\[data-focused='false'\] \.editorTab\[data-active='true'\]::after/u)
  })

  void test('both editors share the per-file states, and a moved tab takes its state along', () => {
    const codeMirror = readSource('src/renderer/src/components/editor/CodeMirrorEditor.tsx')
    // 一份记录两组共用；标签关掉才丢。
    assert.equal(groupsPanel.match(/new WorkbenchEditorFileStates\(\)/gu)?.length, 1)
    assert.match(groupsPanel, /fileStates\.retain\(/u)
    assert.match(editorPanel, /fileStates=\{group\.fileStates\}/u)
    assert.doesNotMatch(editorPanel, /new WorkbenchEditorFileStates/u)
    // 编辑器取状态时登记自己正在显示这个文件，另一组的编辑器接手时向它要此刻的状态。
    assert.match(
      codeMirror,
      /fileStatesRef\.current\.take\(key, \{\s*owner: instance,\s*snapshot: \(\) =>\s*viewRef\.current \? snapshotFileState\(viewRef\.current, instance\) : null,\s*\}\)/u
    )
  })

  void test('an action in a group acts on the file that group shows', () => {
    assert.match(adapter, /if \(activePath\) void workbench\.saveSelectedFile\(content, activePath\)/u)
    assert.match(adapter, /if \(activePath\) workbench\.setEditorContent\(content, activePath\)/u)
    assert.match(adapter, /if \(activePath\) workbench\.toggleSelectedFileEditMode\(activePath\)/u)
    assert.match(
      adapter,
      /if \(activePath\) void workbench\.resolveSelectedExternalFileConflict\(resolution, activePath\)/u
    )
    // 标签栏上的「关闭全部 / 未修改」只管自己那一组。
    assert.match(adapter, /onCloseAllOpenFiles: \(\) => workbench\.closeAllOpenFiles\(group\.index\)/u)
    assert.match(
      adapter,
      /onCloseUnmodifiedOpenFiles: \(\) => workbench\.closeUnmodifiedOpenFiles\(group\.index\)/u
    )
    assert.match(
      controller,
      /const updateEditorContent = useMemoizedFn\(\(content: string, path\?: string\): void => \{\s*const file = path \? openTabsByPath\.get\(path\)\?\.file : selectedFile/u
    )
  })

  void test('global actions follow the focused group', () => {
    // 「当前文件」就是当前组正在显示的标签。
    assert.match(controller, /const selectedFilePath = getWorkbenchEditorFocusedPath\(layout\)/u)
    // ⌘W、外部改动确认框只在当前组。
    assert.match(editorPanel, /const closesActiveTab = group\.focused \|\| !!isolatedTabGroup/u)
    assert.match(editorPanel, /if \(closesActiveTab\) closeActiveEditorTab\(\)/u)
    assert.match(
      editorPanel,
      /shouldShowExternalConflictDialog =\s*group\.focused && selectedExternalChange\?\.status === 'modified'/u
    )
    // 定位请求只由正在显示那个文件的一组执行，两组共用「做过了」的记录。
    assert.match(
      editorPanel,
      /if \(navigationRequest\.path && navigationRequest\.path !== selectedFile\.path\) return/u
    )
    assert.match(editorPanel, /const \{ appliedNavigationRequestIdRef, handledFocusRequestIdRef \} = group/u)
    // ⌘1 / ⌘2 落到眼前没有编辑器的一组（图片、Markdown 预览、Git 对比）：键盘焦点从原处拿走，下一次按键
    // 不会落回另一组的编辑器里、把当前组又换回去。
    assert.match(
      editorPanel,
      /if \(editor\) editor\.focus\(\)\s*else if \(document\.activeElement instanceof HTMLElement\) document\.activeElement\.blur\(\)/u
    )
    // 光标、缩进只转发当前组的。
    assert.match(
      groupsPanel,
      /if \(index === focusedGroupLatest\.current\)\s*globalWorkspaceLatest\.current\?\.onCursorPositionChange\?\.\(position\)/u
    )
    // Git 对比、只读预览、调试页只盖在左边那组上；结构图、AI 改动占整个编辑区。
    assert.match(
      groupsPanel,
      /diff=\{index === 0 \? diff : \{ diffWorkspaceRoot: diff\.diffWorkspaceRoot \}\}/u
    )
    assert.match(groupsPanel, /const visibleGroups = isolatedTabGroup \? groups\.slice\(0, 1\) : groups/u)
    // 结构图、AI 改动占着编辑区时在它们里面点、敲不换当前组：离开之后当前组还是原来那一组。
    assert.match(
      groupsPanel,
      /if \(isolatedTabGroup\) return\s*if \(index !== focusedGroup\) onFocusGroup\(index\)/u
    )
    assert.match(
      pageModel,
      /const editorCovered =\s*aiChanges\.active \|\|\s*velarLogicGraphActive \|\|\s*\(workbench\.editorLayout\.focusedGroup === 0 &&/u
    )
    assert.match(pageModel, /onPrimaryGroupTabShown: \(\) => workbench\.focusEditorGroup\(0\)/u)
  })

  void test('the shortcuts, the tab menu and drag and drop move the tab instead of duplicating it', () => {
    const tabBar = readSource('src/renderer/src/components/editor/EditorTabBar.tsx')
    assert.match(
      pageModel,
      /const splitEditorRight = useMemoizedFn\(\(\): void => \{\s*const path = workbench\.selectedFilePath\s*if \(path && !editorCovered\) moveEditorTabToGroup\(path, 1\)/u
    )
    assert.match(pageModel, /onSplitEditorRight: \(\) => splitEditorRight\(\)/u)
    assert.match(
      pageModel,
      /onFocusEditorGroup: \(groupIndex\) => focusEditorGroup\(groupIndex, \{ takeKeyboardFocus: true \}\)/u
    )
    // 换当前组之前记下位置：后退能回到原来那一组。
    assert.match(
      pageModel,
      /if \(groupIndex !== layout\.focusedGroup\) \{\s*editorNavigation\.recordNavigationPoint\(\)\s*workbench\.focusEditorGroup\(groupIndex\)/u
    )
    // 右键：只有一组是「拆分并右移」，有两组是「移到另一侧」。
    assert.match(tabBar, /onMoveTabToGroup\(tabContextMenu\.path, 1\)[\s\S]*?workbench\.splitEditorTabRight/u)
    assert.match(
      tabBar,
      /onMoveTabToGroup\(tabContextMenu\.path, 1 - groupIndex\)[\s\S]*?workbench\.moveEditorTabToOtherGroup/u
    )
    // 拖放：同一组是换位置，另一组是挪过去（落在标签上或标签栏的空白处）。
    assert.match(
      tabBar,
      /if \(drag\.groupIndex === groupIndex\) onReorderOpenTabs\(drag\.path, path\)\s*else onMoveTabToGroup\?\.\(drag\.path, groupIndex, path\)/u
    )
    assert.match(tabBar, /onMoveTabToGroup\(drag\.path, groupIndex, null\)/u)
    // 只认带着标签类型的拖放：文件树里的文件、文字拖过来不接。
    assert.match(tabBar, /return readWorkbenchEditorTabDrag\(event\.dataTransfer\.types\)/u)
    assert.match(tabBar, /event\.dataTransfer\.setData\(WorkbenchEditorTabDragType, path\)/u)
    // 落在另一组标签栏以外的地方（编辑器上）：那一组在捕获阶段接下来、挪进去，编辑器收不到这次拖放
    // （否则会把标签带着的路径当文字插进正文）。标签栏上的落点还是标签栏自己接。
    assert.match(
      groupsPanel,
      /if \(!canDropWorkbenchEditorTabOnGroup\(drag, index\)\) return null/u
    )
    assert.match(groupsPanel, /return element\?\.closest\('\[role="tablist"\]'\) \? null : drag/u)
    assert.match(groupsPanel, /onDragOverCapture=\{\(event\) => handleGroupDragOver\(index, event\)\}/u)
    assert.match(groupsPanel, /onDropCapture=\{\(event\) => handleGroupDrop\(index, event\)\}/u)
    assert.match(
      groupsPanel,
      /event\.preventDefault\(\)\s*event\.stopPropagation\(\)\s*setTabDropGroup\(null\)\s*endWorkbenchEditorTabDrag\(\)\s*onMoveTabToGroup\(drag\.path, index\)/u
    )
    // 挪进左边那组：盖在那组编辑器上的 Git 对比、只读预览让开，挪过去的标签就在眼前。
    assert.match(pageModel, /if \(landedIndex === 0\) editorNavigation\.uncoverPrimaryGroup\(\)/u)
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

  void test('both groups, the focused one and the divider position are restored', () => {
    const layout = setWorkbenchEditorSplitRatio(
      focusWorkbenchEditorGroup(pin(toRight(open(empty, 'a', 'b', 'c', 'd'), 'c', 'd'), 'c'), 0),
      0.35
    )
    assert.equal(show(layout), '*a [b] | !c [d]')
    const session = buildWorkbenchProjectSessionSnapshot({
      expandedPaths: ['.'],
      selectedEntryPath: null,
      editorLayout: layout,
      cursorByPath: {},
    })
    const restored = normalizeWorkbenchProjectSession(JSON.parse(JSON.stringify(session))).editorLayout
    assert.equal(show(restored), '*a [b] | !c [d]')
    assert.equal(restored.splitRatio, 0.35)

    // 恢复时读不出来的文件：标签丢掉，那一组改显示旁边的；一组全丢了就收成一组。
    assert.equal(show(closeWorkbenchEditorTabs(restored, ['b'])), '*[a] | !c [d]')
    assert.equal(show(closeWorkbenchEditorTabs(restored, ['c', 'd'])), '*a [b]')
  })

  void test('a saved layout with too many groups, a shared file or a bad divider is cleaned up', () => {
    const restored = normalizeWorkbenchEditorGroupsLayout(
      {
        groups: [
          { paths: ['a', 'b'], activePath: 'b' },
          // 同一个文件只能在一组里：右边的 b 丢掉。
          { paths: ['b', 'c'], activePath: 'b' },
          { paths: ['d'], activePath: 'd' },
        ],
        focusedGroup: 1,
        splitRatio: 7,
      },
      32
    )
    assert.equal(show(restored), 'a [b] | *[c]')
    assert.equal(restored.splitRatio, 0.8)
    for (const splitRatio of [undefined, 'wide', null]) {
      assert.equal(
        normalizeWorkbenchEditorGroupsLayout(
          { groups: [{ paths: ['a'], activePath: 'a' }], focusedGroup: 0, splitRatio },
          32
        ).splitRatio,
        0.5
      )
    }
    // 标签总数的上限跨组算。
    const many = normalizeWorkbenchEditorGroupsLayout(
      {
        groups: [
          { paths: Array.from({ length: 30 }, (_, index) => `left-${index}`) },
          { paths: Array.from({ length: 30 }, (_, index) => `right-${index}`) },
        ],
        focusedGroup: 1,
      },
      32
    )
    assert.equal(many.groups[0]?.paths.length, 30)
    assert.equal(many.groups[1]?.paths.length, 2)
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
