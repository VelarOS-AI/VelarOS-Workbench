import assert from 'node:assert/strict'

import { describe, test } from 'bun:test'

import {
  createWorkbenchShortcutKeydownHandler,
  type UseWorkbenchKeyboardShortcutsOptions,
} from '../src/renderer/src/hooks/useWorkbenchKeyboardShortcuts'

function keydown(key: string, init: { defaultPrevented?: boolean; metaKey?: boolean; shiftKey?: boolean } = {}) {
  let prevented = init.defaultPrevented ?? false
  return {
    key,
    code: key.length === 1 ? `Key${key.toUpperCase()}` : key,
    metaKey: init.metaKey ?? false,
    ctrlKey: false,
    shiftKey: init.shiftKey ?? false,
    altKey: false,
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
    onOpenBottomTool: (tool) => calls.push(`open-bottom:${tool}`),
    onOpenQuickOpen: () => calls.push('quick-open'),
    onRunLastCommand: async () => calls.push('run-last-command'),
    onSaveAll: async () => calls.push('save-all'),
    onSaveCurrent: async () => calls.push('save-current'),
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

  void test('other shortcuts still fire when an editor binding also handled the key', () => {
    const { calls, handle } = createHandler()
    handle(keydown('a', { metaKey: true, shiftKey: true, defaultPrevented: true }))
    assert.deepEqual(calls, ['toggle-right:chat'])
  })
})
