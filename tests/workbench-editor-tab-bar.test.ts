import assert from 'node:assert/strict'

import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, test } from 'bun:test'

import type { WorkbenchOpenEditorTab } from '../src/renderer/src/types/workbenchTypes'

import { shareHostReactWithLinkedUi } from './helpers/linkedUiReact'

shareHostReactWithLinkedUi()

const { WorkbenchLocalizationProvider } = await import('../src/renderer/src/i18n')
const { EditorTabBar } = await import('../src/renderer/src/components/editor/EditorTabBar')

type TabBarProps = Parameters<typeof EditorTabBar>[0]

function tab(path: string, content = 'text', diskContent = content): WorkbenchOpenEditorTab {
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

const noop = (): void => undefined

function render(props: Partial<TabBarProps>): string {
  const tabBar = createElement(EditorTabBar, {
    openTabs: [],
    selectedFilePath: null,
    selectedFile: null,
    hasUnsavedChanges: false,
    canEditSelectedFile: true,
    isSavingFile: false,
    dirtyTabCount: 0,
    gitDecorations: new Map(),
    tabContextMenu: null,
    onOpenTabContextMenu: noop,
    onRunTabContextAction: noop,
    onSelectOpenFile: noop,
    onKeepOpenFile: noop,
    onPinOpenFile: noop,
    onUnpinOpenFile: noop,
    onMoveTabToGroup: noop,
    onCloseOpenFile: noop,
    onCloseOtherOpenFiles: noop,
    onCloseAllOpenFiles: noop,
    onCloseUnmodifiedOpenFiles: noop,
    onCloseOpenFilesToRight: noop,
    onRevertOpenFile: noop,
    onReorderOpenTabs: noop,
    onSaveAllOpenFiles: noop,
    ...props,
  })
  return renderToStaticMarkup(
    createElement(WorkbenchLocalizationProvider, {
      value: { locale: 'zh-CN', setLocale: async () => undefined, t: (key) => key },
      children: tabBar,
    })
  )
}

/**
 * 标签栏里每个文件标签的那一段标记，按顺序。（测试里样式模块没有类名，按标签自己的属性找：只有文件标签
 * 带 `data-preview`。）
 */
function tabElements(markup: string): string[] {
  return [...markup.matchAll(/<div data-active="(?:true|false)" data-dirty=.*?<\/div>/gu)].map(
    (match) => match[0]
  )
}

/** 右键菜单那一段标记：标签栏里最后一个菜单（`role="menu"`）。 */
function contextMenu(markup: string): string {
  const start = markup.lastIndexOf('<div role="menu"')
  assert.ok(start >= 0, 'no context menu')
  return markup.slice(start)
}

const tabs = [tab('src/a.ts'), tab('src/b.ts'), tab('src/c.ts')]

void describe('editor tab bar', () => {
  void test('the preview tab is marked so its name shows in italics', () => {
    const elements = tabElements(
      render({ openTabs: tabs, previewTabPath: 'src/c.ts', selectedFilePath: 'src/c.ts' })
    )
    assert.equal(elements.length, 3)
    assert.deepEqual(
      elements.map((element) => /data-preview="(true|false)"/u.exec(element)?.[1]),
      ['false', 'false', 'true']
    )
  })

  void test('a pinned tab shows the pin instead of the close button', () => {
    const elements = tabElements(render({ openTabs: tabs, pinnedTabCount: 2 }))
    assert.deepEqual(
      elements.map((element) => /data-pinned="(true|false)"/u.exec(element)?.[1]),
      ['true', 'true', 'false']
    )
    for (const pinned of elements.slice(0, 2)) {
      assert.match(pinned, /workbench\.unpinEditorTab/u)
      assert.doesNotMatch(pinned, /workbench\.closeEditorTab/u)
    }
    assert.match(elements[2]!, /workbench\.closeEditorTab/u)
    assert.doesNotMatch(elements[2]!, /workbench\.unpinEditorTab/u)
  })

  void test('the tab menu offers pin or unpin for the tab it was opened on', () => {
    const open = (path: string): string =>
      contextMenu(
        render({ openTabs: tabs, pinnedTabCount: 1, tabContextMenu: { path, x: 10, y: 10 } })
      )
    assert.match(open('src/a.ts'), /workbench\.unpinEditorTab/u)
    assert.doesNotMatch(open('src/a.ts'), /workbench\.pinEditorTab/u)
    assert.match(open('src/b.ts'), /workbench\.pinEditorTab/u)
    assert.doesNotMatch(open('src/b.ts'), /workbench\.unpinEditorTab/u)
  })

  void test('with one group the menu splits the tab off to the right, with two it moves it across', () => {
    const menu = { path: 'src/b.ts', x: 10, y: 10 }
    const single = contextMenu(render({ openTabs: tabs, tabContextMenu: menu }))
    assert.match(single, /workbench\.splitEditorTabRight/u)
    assert.doesNotMatch(single, /workbench\.moveEditorTabToOtherGroup/u)
    assert.doesNotMatch(single, /<button[^>]*disabled=""[^>]*>(?:(?!<\/button>).)*workbench\.splitEditorTabRight/u)

    // 唯一一组里只有这一个标签：挪过去等于没挪，不让点。
    const alone = contextMenu(
      render({ openTabs: [tabs[1]!], tabContextMenu: menu })
    )
    assert.match(alone, /<button[^>]*disabled=""[^>]*>(?:(?!<\/button>).)*workbench\.splitEditorTabRight/u)

    const split = contextMenu(
      render({ openTabs: tabs, groupIndex: 1, groupCount: 2, tabContextMenu: menu })
    )
    assert.match(split, /workbench\.moveEditorTabToOtherGroup/u)
    assert.doesNotMatch(split, /workbench\.splitEditorTabRight/u)
  })

  void test('the tab menu is a menu: it has the role and its entries are menu items', () => {
    const menu = contextMenu(
      render({ openTabs: tabs, tabContextMenu: { path: 'src/b.ts', x: 10, y: 10 } })
    )
    assert.match(menu, /^<div role="menu" aria-label="workbench\.editorTabActions"/u)
    const buttons = [...menu.matchAll(/<button[^>]*>/gu)].map((match) => match[0])
    assert.ok(buttons.length >= 5)
    for (const button of buttons) assert.match(button, /role="menuitem"/u)
  })

  void test('close to the right is only offered when an unpinned tab sits to the right', () => {
    const closeToRightDisabled = (path: string, pinnedTabCount: number): boolean =>
      /<button[^>]*disabled=""[^>]*>(?:(?!<\/button>).)*workbench\.closeEditorTabsToRight/u.test(
        contextMenu(
          render({ openTabs: tabs, pinnedTabCount, tabContextMenu: { path, x: 10, y: 10 } })
        )
      )
    assert.equal(closeToRightDisabled('src/b.ts', 0), false)
    assert.equal(closeToRightDisabled('src/c.ts', 0), true)
    // 右边剩下的都是固定标签：没有可关的。
    assert.equal(closeToRightDisabled('src/a.ts', 3), true)
    assert.equal(closeToRightDisabled('src/a.ts', 2), false)
  })
})
