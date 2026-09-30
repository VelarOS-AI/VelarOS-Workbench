import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { describe, test } from 'bun:test'

import {
  keepFocusOutsideTreeAfterRename,
  WorkbenchTreeRenameFocusWindowMs,
} from '../src/renderer/src/models/files/workbenchTreeRenameFocus'

/** 一棵假的树：记着谁在听 focusin，能假装「树拿回了焦点」。 */
function fakeTree(inside: readonly unknown[] = []) {
  const listeners = new Set<() => void>()
  return {
    listeners,
    contains: (target: unknown) => inside.includes(target),
    addEventListener: (_type: 'focusin', listener: () => void) => void listeners.add(listener),
    removeEventListener: (_type: 'focusin', listener: () => void) => void listeners.delete(listener),
    /** 树拿回焦点（react-arborist 取消改名之后把焦点还给那一行）。 */
    takeFocusBack(): void {
      for (const listener of [...listeners]) listener()
    },
  }
}

function fakeElement(isConnected = true) {
  const element = {
    isConnected,
    focused: 0,
    focus: () => {
      element.focused += 1
    },
  }
  return element
}

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

void describe('Workbench tree rename focus', () => {
  void test('focus taken by something outside the tree is handed back when the tree grabs it', () => {
    const tree = fakeTree()
    const editor = fakeElement()
    keepFocusOutsideTreeAfterRename(tree, editor)
    assert.equal(tree.listeners.size, 1)
    assert.equal(editor.focused, 0, 'nothing happens until the tree takes focus back')

    tree.takeFocusBack()
    assert.equal(editor.focused, 1)
    // 只还一次：之后用户自己点回树里，不再把焦点抢走。
    assert.equal(tree.listeners.size, 0)
    tree.takeFocusBack()
    assert.equal(editor.focused, 1)
  })

  void test('focus that stays in the tree, or goes nowhere, is left to the tree', () => {
    const otherRow = fakeElement()
    const tree = fakeTree([otherRow])
    keepFocusOutsideTreeAfterRename(tree, otherRow)
    // 切到别的应用、点在不能聚焦的地方：relatedTarget 是 null。
    keepFocusOutsideTreeAfterRename(tree, null)
    keepFocusOutsideTreeAfterRename(null, fakeElement())
    assert.equal(tree.listeners.size, 0)
  })

  void test('an element that is gone by then is not focused', () => {
    const tree = fakeTree()
    const closedDialogInput = fakeElement()
    keepFocusOutsideTreeAfterRename(tree, closedDialogInput)
    closedDialogInput.isConnected = false
    tree.takeFocusBack()
    assert.equal(closedDialogInput.focused, 0)
  })

  void test('it only watches for a moment: a later click back into the tree is the user’s own', async () => {
    const tree = fakeTree()
    const editor = fakeElement()
    keepFocusOutsideTreeAfterRename(tree, editor)
    await wait(WorkbenchTreeRenameFocusWindowMs + 60)
    assert.equal(tree.listeners.size, 0)
    tree.takeFocusBack()
    assert.equal(editor.focused, 0)
  })

  void test('the rename box registers the hand-back before cancelling the rename', () => {
    const row = readFileSync(
      path.resolve(process.cwd(), 'src/renderer/src/components/files/FileTreeRow.tsx'),
      'utf8'
    )
    assert.match(
      row,
      /keepFocusOutsideTreeAfterRename\(\s*event\.currentTarget\.closest<HTMLElement>\('\[role="tree"\]'\),\s*event\.relatedTarget\s*\)\s*node\.reset\(\)/u
    )
    assert.match(row, /onBlur=\{handleEditBlur\}/u)
  })
})
