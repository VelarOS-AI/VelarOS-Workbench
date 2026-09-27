import assert from 'node:assert/strict'

import { describe, test } from 'bun:test'

import {
  createWorkbenchShortcutKeydownHandler,
  type UseWorkbenchKeyboardShortcutsOptions,
} from '../src/renderer/src/hooks/useWorkbenchKeyboardShortcuts'
import { isWorkbenchTextEntryTarget } from '../src/renderer/src/models/layout/workbenchKeyboardShortcuts'

interface KeydownInit {
  defaultPrevented?: boolean
  metaKey?: boolean
  shiftKey?: boolean
  target?: object
}

function keydown(key: string, init: KeydownInit = {}) {
  let prevented = init.defaultPrevented ?? false
  return {
    key,
    code: key.length === 1 ? `Key${key.toUpperCase()}` : key,
    metaKey: init.metaKey ?? false,
    ctrlKey: false,
    shiftKey: init.shiftKey ?? false,
    altKey: false,
    target: init.target ?? { tagName: 'BODY', isContentEditable: false },
    get defaultPrevented() {
      return prevented
    },
    preventDefault() {
      prevented = true
    },
  } as unknown as KeyboardEvent
}

function createHandler() {
  const calls: string[] = []
  const options: UseWorkbenchKeyboardShortcutsOptions = {
    activeRightTool: 'chat',
    enabled: true,
    isQuickOpenOpen: false,
    onCloseRightTool: () => calls.push('close-right-tool'),
    onOpenQuickOpen: () => calls.push('quick-open'),
    onRunLastCommand: async () => calls.push('run-last-command'),
    onSaveAll: async () => calls.push('save-all'),
    onSaveCurrent: async () => calls.push('save-current'),
    onToggleBottomTool: (tool) => calls.push(`toggle-bottom:${tool}`),
    onToggleRightTool: (tool) => calls.push(`toggle-right:${tool}`),
  }
  return { calls, handle: createWorkbenchShortcutKeydownHandler(() => options) }
}

void describe('Workbench keyboard shortcuts', () => {
  void test('Escape closes the right panel only when no focused control used it first', () => {
    const { calls, handle } = createHandler()

    handle(keydown('Escape'))
    assert.deepEqual(calls, ['close-right-tool'])

    // 行内重命名、搜索框、补全列表已经用掉了这次 Escape：右侧面板不跟着收起。
    handle(keydown('Escape', { defaultPrevented: true }))
    assert.deepEqual(calls, ['close-right-tool'])
  })

  void test('no global shortcut fires for a key a focused control already handled', () => {
    const { calls, handle } = createHandler()

    // 编辑器的 Mod+Enter 插了空行、提交框的 Mod+Enter 提交了、别的控件占用了组合键：全局一概不跟。
    handle(keydown('Enter', { metaKey: true, defaultPrevented: true }))
    handle(keydown('a', { metaKey: true, shiftKey: true, defaultPrevented: true }))
    handle(keydown('p', { metaKey: true, defaultPrevented: true }))
    assert.deepEqual(calls, [])
  })

  void test('Mod+S saves once whether or not the editor handled it', () => {
    const { calls, handle } = createHandler()

    // 编辑器自己的 Mod-s 绑定已经存了盘并 preventDefault：窗口上的全局处理不再存第二次。
    const handledByEditor = keydown('s', { metaKey: true })
    handledByEditor.preventDefault()
    calls.push('editor-save')
    handle(handledByEditor)
    assert.deepEqual(calls, ['editor-save'])

    // 焦点不在编辑器里（文件树、按钮）：由全局处理存当前文件。
    handle(keydown('s', { metaKey: true }))
    assert.deepEqual(calls, ['editor-save', 'save-current'])
  })

  void test('run last command never fires from a text input, text area or editable region', () => {
    const { calls, handle } = createHandler()

    for (const target of [
      { tagName: 'INPUT', isContentEditable: false },
      { tagName: 'TEXTAREA', isContentEditable: false },
      { tagName: 'DIV', isContentEditable: true },
    ]) {
      const event = keydown('Enter', { metaKey: true, target })
      handle(event)
      // 按键原样留给那段文字（换行、发送），不被全局吞掉。
      assert.equal(event.defaultPrevented, false)
    }
    assert.deepEqual(calls, [])

    handle(keydown('Enter', { metaKey: true, target: { tagName: 'BUTTON' } }))
    assert.deepEqual(calls, ['run-last-command'])
  })

  void test('panel shortcuts toggle their tool windows instead of only opening them', () => {
    const { calls, handle } = createHandler()

    handle(keydown('i', { metaKey: true, shiftKey: true }))
    handle(keydown('g', { metaKey: true, shiftKey: true }))
    handle(keydown('a', { metaKey: true, shiftKey: true }))
    assert.deepEqual(calls, ['toggle-bottom:problems', 'toggle-bottom:git', 'toggle-right:chat'])
  })

  void test('recognises text entry targets', () => {
    assert.equal(isWorkbenchTextEntryTarget(null), false)
    assert.equal(isWorkbenchTextEntryTarget({ tagName: 'input' } as unknown as EventTarget), true)
    assert.equal(isWorkbenchTextEntryTarget({ tagName: 'TEXTAREA' } as unknown as EventTarget), true)
    assert.equal(
      isWorkbenchTextEntryTarget({ tagName: 'DIV', isContentEditable: true } as unknown as EventTarget),
      true
    )
    assert.equal(isWorkbenchTextEntryTarget({ tagName: 'BUTTON' } as unknown as EventTarget), false)
  })
})
