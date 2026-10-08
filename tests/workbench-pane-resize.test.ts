import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { describe, test } from 'bun:test'

import {
  buildWorkbenchLayoutStyleVariables,
  DEFAULT_WORKBENCH_LAYOUT_SIZES,
  resizeWorkbenchLayoutSizes,
} from '../src/renderer/src/models/layout/workbenchLayoutModel'

function readSource(relativePath: string): string {
  return readFileSync(path.resolve(process.cwd(), relativePath), 'utf8')
}

void describe('Workbench pane resize', () => {
  void test('drags each pane relative to where the drag started, within its limits', () => {
    const start = DEFAULT_WORKBENCH_LAYOUT_SIZES
    assert.equal(resizeWorkbenchLayoutSizes(start, 'file', { x: 40, y: 0 }).filePaneWidth, 300)
    // 右栏的分隔条在它左边：往左拖是变宽。
    assert.equal(resizeWorkbenchLayoutSizes(start, 'right', { x: -60, y: 0 }).rightPaneWidth, 480)
    // 底部面板的分隔条在它上沿：往上拖是变高。
    assert.equal(resizeWorkbenchLayoutSizes(start, 'command', { x: 0, y: -50 }).commandPanelHeight, 260)
    assert.equal(resizeWorkbenchLayoutSizes(start, 'file', { x: 5_000, y: 0 }).filePaneWidth, 380)
    assert.equal(resizeWorkbenchLayoutSizes(start, 'right', { x: 5_000, y: 0 }).rightPaneWidth, 360)
    // 只动被拖的那一栏。
    assert.deepEqual(
      { ...resizeWorkbenchLayoutSizes(start, 'file', { x: 40, y: 0 }), filePaneWidth: start.filePaneWidth },
      start
    )
  })

  void test('React style and the live drag write the same variables', () => {
    assert.deepEqual(buildWorkbenchLayoutStyleVariables({ commandPanelHeight: 200, filePaneWidth: 280, rightPaneWidth: 500 }), {
      '--workbench-command-panel-height': '200px',
      '--workbench-file-pane-width': '280px',
      '--workbench-right-pane-width': '500px',
    })
    const controller = readSource('src/renderer/src/hooks/useWorkbenchLayoutController.ts')
    assert.match(controller, /\.\.\.buildWorkbenchLayoutStyleVariables\(effectiveSizes\)/u)
    assert.match(controller, /buildWorkbenchLayoutStyleVariables\(effective\)\)\)\s*shell\.style\.setProperty\(name, value\)/u)
    // 拖拽中不 setState：只有松手写回和双击复位两处。
    assert.equal(controller.match(/setLayoutSizes\(/gu)?.length, 2)
    assert.match(controller, /const stopResize = \(\): void => \{[\s\S]*?setLayoutSizes\(draftSizes\)\s*\}/u)
  })

  void test('pane size variables do not invalidate the whole subtree when they change', () => {
    const layout = readSource('src/renderer/src/styles/03-layout.module.css')
    for (const name of ['--workbench-right-pane-width', '--workbench-file-pane-width', '--workbench-command-panel-height']) {
      assert.match(layout, new RegExp(`@property ${name} \\{\\s*syntax: '<length>';\\s*inherits: false;`, 'u'))
    }
    assert.match(layout, /\.ideBody \{\s*--workbench-right-pane-width: inherit;\s*--workbench-file-pane-width: inherit;\s*\}/u)
    assert.match(layout, /\.ideBody > \.embeddedKernelRoot \{\s*--workbench-file-pane-width: inherit;\s*\}/u)
    assert.match(layout, /\.bottomToolWindowSlot \{\s*--workbench-command-panel-height: inherit;\s*\}/u)
    // 编辑区的文件栏宽度跟着外壳变量走，拖拽时不必重渲染。
    const presentation = readSource('src/renderer/src/app/StandaloneWorkbenchPagePresentation.tsx')
    assert.match(presentation, /filePanelWidth: 'var\(--workbench-file-pane-width\)'/u)
    assert.match(presentation, /ref=\{layout\.shellRef\}/u)
  })

  void test('all resize handles share one hit size and one highlight thickness', () => {
    const layout = readSource('src/renderer/src/styles/03-layout.module.css')
    assert.match(layout, /\.workbenchShell \{\s*--workbench-resize-hit-size: 12px;\s*--workbench-resize-line-size: 2px;\s*\}/u)
    const hitUses = layout.match(/var\(--workbench-resize-hit-size\)/gu)?.length ?? 0
    const lineUses = layout.match(/var\(--workbench-resize-line-size\)/gu)?.length ?? 0
    // 左侧文件栏（浮层 + 内嵌两种）、右侧聊天、底部面板。
    assert.ok(hitUses >= 4, `hit size used ${hitUses} times`)
    assert.ok(lineUses >= 3, `line size used ${lineUses} times`)
    assert.doesNotMatch(layout, /\.bottomToolWindowSlot > \.horizontalResizeHandle::after \{\s*display: none;/u)
  })
})
