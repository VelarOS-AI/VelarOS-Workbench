import assert from 'node:assert/strict'

import { describe, test } from 'bun:test'

import {
  createWorkbenchShortcutKeydownHandler,
  type UseWorkbenchKeyboardShortcutsOptions,
} from '../src/renderer/src/hooks/useWorkbenchKeyboardShortcuts'
import {
  buildWorkbenchKeymapConflicts,
  DEFAULT_WORKBENCH_KEYBOARD_SHORTCUT_MAP,
  formatWorkbenchShortcutHint,
  getWorkbenchKeyboardShortcut,
  isWorkbenchTextEntryTarget,
  shortcutFromWorkbenchKeyboardEvent,
} from '../src/renderer/src/models/layout/workbenchKeyboardShortcuts'

const Mac = 'MacIntel'
const Windows = 'Win32'
const Linux = 'Linux x86_64'

interface KeydownInit {
  altKey?: boolean
  code?: string
  ctrlKey?: boolean
  defaultPrevented?: boolean
  metaKey?: boolean
  shiftKey?: boolean
  target?: object
}

function keydown(key: string, init: KeydownInit = {}) {
  let prevented = init.defaultPrevented ?? false
  return {
    key,
    code: init.code ?? (key.length === 1 ? `Key${key.toUpperCase()}` : key),
    metaKey: init.metaKey ?? false,
    ctrlKey: init.ctrlKey ?? false,
    shiftKey: init.shiftKey ?? false,
    altKey: init.altKey ?? false,
    target: init.target ?? { tagName: 'BODY', isContentEditable: false },
    get defaultPrevented() {
      return prevented
    },
    preventDefault() {
      prevented = true
    },
  } as unknown as KeyboardEvent
}

function createHandler(platform = Mac) {
  const calls: string[] = []
  const options: UseWorkbenchKeyboardShortcutsOptions = {
    activeRightTool: 'chat',
    enabled: true,
    isQuickOpenOpen: false,
    platform,
    onCloseRightTool: () => calls.push('close-right-tool'),
    onFindInFiles: () => calls.push('find-in-files'),
    onNavigateBack: () => calls.push('navigate-back'),
    onNavigateForward: () => calls.push('navigate-forward'),
    onOpenQuickOpen: () => calls.push('quick-open'),
    onOpenCommandPalette: () => calls.push('command-palette'),
    onReopenClosedTab: () => calls.push('reopen-closed-tab'),
    onRunLastCommand: async () => calls.push('run-last-command'),
    onSaveAll: async () => calls.push('save-all'),
    onSaveCurrent: async () => calls.push('save-current'),
    onToggleBottomTool: (tool) => calls.push(`toggle-bottom:${tool}`),
    onToggleRightTool: (tool) => calls.push(`toggle-right:${tool}`),
  }
  return { calls, handle: createWorkbenchShortcutKeydownHandler(() => options) }
}

void describe('Workbench keyboard shortcuts', () => {
  void test('go back and forward: ⌃- / ⌃⇧- on macOS, Alt+← / Alt+→ elsewhere', () => {
    const mac = {
      ...DEFAULT_WORKBENCH_KEYBOARD_SHORTCUT_MAP,
      'navigate-back': 'Ctrl+Minus',
      'navigate-forward': 'Ctrl+Shift+Minus',
    }
    assert.equal(
      getWorkbenchKeyboardShortcut(keydown('-', { ctrlKey: true, code: 'Minus' }), mac, Mac),
      'navigate-back'
    )
    // ⇧- 打出来是 _：按物理键认。
    assert.equal(
      getWorkbenchKeyboardShortcut(keydown('_', { ctrlKey: true, shiftKey: true, code: 'Minus' }), mac, Mac),
      'navigate-forward'
    )
    // ⌘- 是编辑区缩小（原生菜单），不是后退。
    assert.equal(getWorkbenchKeyboardShortcut(keydown('-', { metaKey: true, code: 'Minus' }), mac, Mac), null)
    assert.equal(formatWorkbenchShortcutHint('Ctrl+Shift+Minus', Mac), '⌃⇧-')

    const other = {
      ...DEFAULT_WORKBENCH_KEYBOARD_SHORTCUT_MAP,
      'navigate-back': 'Alt+ArrowLeft',
      'navigate-forward': 'Alt+ArrowRight',
    }
    assert.equal(getWorkbenchKeyboardShortcut(keydown('ArrowLeft', { altKey: true }), other, Windows), 'navigate-back')
    assert.equal(getWorkbenchKeyboardShortcut(keydown('ArrowRight', { altKey: true }), other, Linux), 'navigate-forward')
    assert.equal(formatWorkbenchShortcutHint('Ctrl+Minus', Windows), 'Ctrl+-')
  })


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

  void test('⇧⌘F / Ctrl+Shift+F opens the project search, also from a text field', () => {
    const { calls, handle } = createHandler(Mac)
    handle(keydown('f', { metaKey: true, shiftKey: true }))
    handle(keydown('f', { metaKey: true, shiftKey: true, target: { tagName: 'INPUT' } }))
    // ⌘F 是编辑器自己的查找，不是项目搜索。
    handle(keydown('f', { metaKey: true }))
    const { calls: linuxCalls, handle: handleOnLinux } = createHandler(Linux)
    handleOnLinux(keydown('F', { ctrlKey: true, shiftKey: true }))
    assert.deepEqual([...calls, ...linuxCalls], ['find-in-files', 'find-in-files', 'find-in-files'])
    assert.equal(DEFAULT_WORKBENCH_KEYBOARD_SHORTCUT_MAP['find-in-files'], 'Mod+Shift+F')
    assert.equal(formatWorkbenchShortcutHint('Mod+Shift+F', Mac), '⇧⌘F')
  })

  void test('Mod+Shift+P opens the command palette, Mod+P still opens Quick Open', () => {
    const { calls, handle } = createHandler(Mac)
    handle(keydown('P', { metaKey: true, shiftKey: true }))
    handle(keydown('p', { metaKey: true }))
    const { calls: windowsCalls, handle: handleOnWindows } = createHandler(Windows)
    handleOnWindows(keydown('P', { ctrlKey: true, shiftKey: true }))
    // ⌃⇧P 在 macOS 上不是命令面板：Mod 是 ⌘。
    handle(keydown('P', { ctrlKey: true, shiftKey: true }))
    assert.deepEqual([...calls, ...windowsCalls], ['command-palette', 'quick-open', 'command-palette'])
    assert.equal(formatWorkbenchShortcutHint(DEFAULT_WORKBENCH_KEYBOARD_SHORTCUT_MAP['command-palette'], Mac), '⇧⌘P')
    assert.equal(
      formatWorkbenchShortcutHint(DEFAULT_WORKBENCH_KEYBOARD_SHORTCUT_MAP['command-palette'], Linux),
      'Ctrl+Shift+P'
    )
  })

  void test('no two default shortcuts share a key', () => {
    assert.deepEqual(buildWorkbenchKeymapConflicts(DEFAULT_WORKBENCH_KEYBOARD_SHORTCUT_MAP), [])
  })

  void test('Mod+Shift+T reopens the last closed tab', () => {
    const { calls, handle } = createHandler(Mac)
    handle(keydown('t', { metaKey: true, shiftKey: true }))
    const { calls: linuxCalls, handle: handleOnLinux } = createHandler(Linux)
    handleOnLinux(keydown('T', { ctrlKey: true, shiftKey: true }))
    assert.deepEqual([...calls, ...linuxCalls], ['reopen-closed-tab', 'reopen-closed-tab'])
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

  void test('Mod is the primary modifier of each platform', () => {
    const { calls: macCalls, handle: handleOnMac } = createHandler(Mac)
    handleOnMac(keydown('Enter', { metaKey: true }))
    handleOnMac(keydown('Enter', { ctrlKey: true }))
    assert.deepEqual(macCalls, ['run-last-command'])

    const { calls: windowsCalls, handle: handleOnWindows } = createHandler(Windows)
    handleOnWindows(keydown('Enter', { ctrlKey: true }))
    handleOnWindows(keydown('Enter', { metaKey: true }))
    assert.deepEqual(windowsCalls, ['run-last-command'])
  })

  void test('recording on macOS keeps Control apart from Command', () => {
    assert.equal(shortcutFromWorkbenchKeyboardEvent(keydown('p', { metaKey: true }), Mac), 'Mod+P')
    assert.equal(shortcutFromWorkbenchKeyboardEvent(keydown('p', { ctrlKey: true }), Mac), 'Ctrl+P')
    assert.equal(
      shortcutFromWorkbenchKeyboardEvent(
        keydown('k', { ctrlKey: true, metaKey: true, shiftKey: true }),
        Mac
      ),
      'Mod+Ctrl+Shift+K'
    )
    // 其它平台上 Ctrl 就是主修饰键；Win / Super 键单独记。
    assert.equal(shortcutFromWorkbenchKeyboardEvent(keydown('p', { ctrlKey: true }), Windows), 'Mod+P')
    assert.equal(shortcutFromWorkbenchKeyboardEvent(keydown('p', { metaKey: true }), Linux), 'Meta+P')
  })

  void test('a Control shortcut recorded on macOS fires on Control, not on Command', () => {
    const keymap = { ...DEFAULT_WORKBENCH_KEYBOARD_SHORTCUT_MAP, 'quick-open': 'Ctrl+P' }

    assert.equal(getWorkbenchKeyboardShortcut(keydown('p', { ctrlKey: true }), keymap, Mac), 'quick-open')
    assert.equal(getWorkbenchKeyboardShortcut(keydown('p', { metaKey: true }), keymap, Mac), null)
    assert.equal(
      getWorkbenchKeyboardShortcut(keydown('p', { metaKey: true }), DEFAULT_WORKBENCH_KEYBOARD_SHORTCUT_MAP, Mac),
      'quick-open'
    )
    assert.equal(
      getWorkbenchKeyboardShortcut(keydown('p', { ctrlKey: true }), DEFAULT_WORKBENCH_KEYBOARD_SHORTCUT_MAP, Linux),
      'quick-open'
    )
  })

  void test('shortcut hints follow the keymap and the platform', () => {
    assert.equal(formatWorkbenchShortcutHint('Mod+P', Mac), '⌘P')
    assert.equal(formatWorkbenchShortcutHint('Mod+Shift+I', Mac), '⇧⌘I')
    assert.equal(formatWorkbenchShortcutHint('Ctrl+Alt+Enter', Mac), '⌃⌥↩')
    assert.equal(formatWorkbenchShortcutHint('Mod+Shift+G', Windows), 'Ctrl+Shift+G')
    assert.equal(formatWorkbenchShortcutHint('Meta+Alt+Escape', Windows), 'Win+Alt+Esc')
    assert.equal(formatWorkbenchShortcutHint('Meta+K', Linux), 'Super+K')
    assert.equal(formatWorkbenchShortcutHint('Mod++', Linux), 'Ctrl++')
  })
})
