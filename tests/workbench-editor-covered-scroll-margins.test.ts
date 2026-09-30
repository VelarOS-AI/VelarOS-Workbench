import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { describe, test } from 'bun:test'

import {
  measureWorkbenchEditorCoveredBottom,
  WorkbenchEditorOverlayAttribute,
} from '../src/renderer/src/models/editor/workbenchEditorCoveredScrollMargins'

function readSource(relativePath: string): string {
  return readFileSync(path.resolve(process.cwd(), relativePath), 'utf8')
}

/** 编辑器的滚动区：窗口里 x 383–1244，y 72–774。 */
const scroller = { left: 383, right: 1244, top: 72, bottom: 774 }

void describe('editor scroll margins under the bottom tool window', () => {
  void test('the covered height runs from the top of the overlay to the bottom of the editor', () => {
    // 默认高度的底部工具窗：210px，横跨左右。
    assert.equal(
      measureWorkbenchEditorCoveredBottom(scroller, [{ left: 38, right: 1244, top: 564, bottom: 774 }]),
      210
    )
    // 拉高了的：盖住大半个编辑器。
    assert.equal(
      measureWorkbenchEditorCoveredBottom(scroller, [{ left: 38, right: 1244, top: 291, bottom: 774 }]),
      483
    )
    // 两块都盖着时取高的那块。
    assert.equal(
      measureWorkbenchEditorCoveredBottom(scroller, [
        { left: 38, right: 1244, top: 700, bottom: 774 },
        { left: 38, right: 1244, top: 600, bottom: 774 },
      ]),
      174
    )
  })

  void test('nothing is reported when the overlay does not cover the editor from below', () => {
    assert.equal(measureWorkbenchEditorCoveredBottom(scroller, []), 0)
    // 收起来了（没有高度）。
    assert.equal(
      measureWorkbenchEditorCoveredBottom(scroller, [{ left: 38, right: 1244, top: 774, bottom: 774 }]),
      0
    )
    // 在编辑器下面，没碰到它。
    assert.equal(
      measureWorkbenchEditorCoveredBottom(scroller, [{ left: 38, right: 1244, top: 774, bottom: 800 }]),
      0
    )
    // 在旁边的栏里（横向不相交）。
    assert.equal(
      measureWorkbenchEditorCoveredBottom(scroller, [{ left: 0, right: 383, top: 500, bottom: 774 }]),
      0
    )
    // 悬在中间的浮层（下沿没到编辑器的下沿）不是从下面盖上来的。
    assert.equal(
      measureWorkbenchEditorCoveredBottom(scroller, [{ left: 500, right: 900, top: 200, bottom: 400 }]),
      0
    )
  })

  void test('an overlay over the whole editor still leaves room for the target line', () => {
    const covered = measureWorkbenchEditorCoveredBottom(scroller, [
      { left: 38, right: 1244, top: 36, bottom: 774 },
    ])
    assert.equal(covered, scroller.bottom - scroller.top - 48)
  })

  void test('the bottom tool window is marked as an overlay and the file editor reads the margins', () => {
    const presentation = readSource('src/renderer/src/StandaloneWorkbenchPagePresentation.tsx')
    assert.ok(
      presentation.includes(
        `<section className={styles.bottomToolWindowSlot} ${WorkbenchEditorOverlayAttribute}>`
      )
    )
    const editor = readSource('src/renderer/src/components/editor/CodeMirrorEditor.tsx')
    assert.match(editor, /workbenchEditorCoveredScrollMargins\(\)/u)
  })
})
