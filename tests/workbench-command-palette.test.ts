import assert from 'node:assert/strict'

import { describe, test } from 'bun:test'

import { translateWorkbenchAppMessage } from '../src/renderer/src/i18n/useStandaloneWorkbenchLocalization'
import {
  buildWorkbenchPaletteCommands,
  filterWorkbenchPaletteCommands,
  isWorkbenchPaletteCommandAvailable,
  WORKBENCH_PALETTE_COMMANDS,
  type WorkbenchPaletteCommandContext,
  type WorkbenchPaletteCommandId,
  type WorkbenchPaletteCommandItem,
} from '../src/renderer/src/models/layout/workbenchCommandPalette'
import {
  DEFAULT_WORKBENCH_KEYBOARD_SHORTCUT_MAP,
  WORKBENCH_KEYBOARD_SHORTCUT_DEFINITIONS,
  type WorkbenchKeyboardShortcutMap,
} from '../src/renderer/src/models/layout/workbenchKeyboardShortcuts'

const Mac = 'MacIntel'
const Linux = 'Linux x86_64'

const KeymapForTests: WorkbenchKeyboardShortcutMap = {
  ...DEFAULT_WORKBENCH_KEYBOARD_SHORTCUT_MAP,
  'navigate-back': 'Ctrl+Minus',
  'navigate-forward': 'Ctrl+Shift+Minus',
}

function buildCommands(
  locale: 'en-US' | 'zh-CN',
  options: {
    platform?: string
    keymap?: WorkbenchKeyboardShortcutMap
    isAvailable?: (id: WorkbenchPaletteCommandId) => boolean
  } = {}
): WorkbenchPaletteCommandItem[] {
  return buildWorkbenchPaletteCommands({
    isAvailable: options.isAvailable ?? (() => true),
    keymap: options.keymap ?? KeymapForTests,
    platform: options.platform ?? Mac,
    translate: (key) => translateWorkbenchAppMessage(locale, key),
    translateAlias: (key) => translateWorkbenchAppMessage('en-US', key),
  })
}

function command(items: readonly WorkbenchPaletteCommandItem[], id: WorkbenchPaletteCommandId) {
  const item = items.find((candidate) => candidate.id === id)
  assert.ok(item, `${id} should be listed`)
  return item
}

const FileInFront: WorkbenchPaletteCommandContext = {
  hasActiveFile: true,
  activeFileIsText: true,
  canEditActiveFile: true,
  canToggleReadOnly: true,
  editorCovered: false,
  openTabCount: 2,
  activeFileLanguageService: 'typescript',
  canSplitEditorRight: true,
  editorGroupCount: 1,
  editorActions: [],
  debugStatus: 'idle',
  canDebugConfiguration: false,
}

void describe('Workbench command palette registry', () => {
  void test('lists every configurable global shortcut action as a command', () => {
    const reachable = new Set(
      WORKBENCH_PALETTE_COMMANDS.flatMap((definition) =>
        definition.shortcut && 'action' in definition.shortcut ? [definition.shortcut.action] : []
      )
    )
    // Esc 收起右侧工具不算命令；命令面板自己不用列自己。
    const expected = WORKBENCH_KEYBOARD_SHORTCUT_DEFINITIONS.map((definition) => definition.action).filter(
      (action) => action !== 'close-right-tool' && action !== 'command-palette'
    )
    for (const action of expected) assert.ok(reachable.has(action), `${action} has no command`)
  })

  void test('has unique ids and a label in both languages for every command', () => {
    const ids = WORKBENCH_PALETTE_COMMANDS.map((definition) => definition.id)
    assert.equal(new Set(ids).size, ids.length)
    for (const definition of WORKBENCH_PALETTE_COMMANDS) {
      for (const locale of ['zh-CN', 'en-US'] as const) {
        assert.notEqual(
          translateWorkbenchAppMessage(locale, definition.labelKey),
          definition.labelKey,
          `${locale} is missing ${definition.labelKey}`
        )
      }
    }
    for (const key of [
      'workbench.commandPaletteTitle',
      'workbench.commandPaletteCaption',
      'workbench.commandPaletteEmpty',
      'workbench.settingsShortcutCommandPalette',
      'workbench.settingsShortcutCommandPaletteDescription',
    ]) {
      assert.notEqual(translateWorkbenchAppMessage('zh-CN', key), key)
      assert.notEqual(translateWorkbenchAppMessage('en-US', key), key)
    }
  })

  void test('shows each command shortcut from the current keymap and platform', () => {
    const mac = buildCommands('en-US')
    assert.equal(command(mac, 'go-to-file').shortcut, '⌘P')
    assert.equal(command(mac, 'go-to-symbol').shortcut, '⇧⌘O')
    assert.equal(command(mac, 'save-all').shortcut, '⇧⌘S')
    assert.equal(command(mac, 'toggle-git').shortcut, '⇧⌘G')
    assert.equal(command(mac, 'navigate-back').shortcut, '⌃-')
    // 编辑器与应用菜单里写死的按键。
    assert.equal(command(mac, 'format-document').shortcut, '⌥⌘L')
    assert.equal(command(mac, 'quick-fix').shortcut, '⌥↩')
    assert.equal(command(mac, 'refactor').shortcut, '⌃T')
    assert.equal(command(mac, 'organize-imports').shortcut, '⌥⇧O')
    assert.equal(command(mac, 'find-references').shortcut, '⇧F12')
    assert.equal(command(mac, 'call-hierarchy').shortcut, '⌃⌥H')
    assert.equal(command(mac, 'toggle-word-wrap').shortcut, '⌥Z')
    assert.equal(command(mac, 'go-to-line').shortcut, '⌃G')
    assert.equal(command(mac, 'close-editor').shortcut, '⌘W')
    assert.equal(command(mac, 'zoom-in').shortcut, '⌘+')
    assert.equal(command(mac, 'open-settings').shortcut, null)

    // 终端里的拆分键两类平台不一样。
    assert.equal(command(mac, 'split-terminal').shortcut, '⌘D')
    assert.equal(command(mac, 'toggle-git-blame').shortcut, null)

    const linux = buildCommands('en-US', { platform: Linux })
    assert.equal(command(linux, 'split-terminal').shortcut, 'Ctrl+Shift+5')
    assert.equal(command(linux, 'go-to-file').shortcut, 'Ctrl+P')
    assert.equal(command(linux, 'go-to-symbol').shortcut, 'Ctrl+Shift+O')
    assert.equal(command(linux, 'format-document').shortcut, 'Ctrl+Alt+L')
    assert.equal(command(linux, 'quick-fix').shortcut, 'Alt+Enter')
    assert.equal(command(linux, 'refactor').shortcut, 'Ctrl+Alt+Shift+T')
    assert.equal(command(linux, 'organize-imports').shortcut, 'Alt+Shift+O')
    assert.equal(command(linux, 'find-references').shortcut, 'Shift+F12')
    assert.equal(command(linux, 'call-hierarchy').shortcut, 'Ctrl+Alt+H')
    assert.equal(command(linux, 'zoom-out').shortcut, 'Ctrl+-')

    // 改过的快捷键照改过的显示。
    const rebound = buildCommands('en-US', {
      keymap: { ...KeymapForTests, 'quick-open': 'Ctrl+E', 'save-current': 'Mod+Alt+S' },
    })
    assert.equal(command(rebound, 'go-to-file').shortcut, '⌃E')
    assert.equal(command(rebound, 'save-current').shortcut, '⌥⌘S')
  })

  void test('leaves out commands that cannot run now and keeps the registry order', () => {
    const items = buildCommands('en-US', { isAvailable: (id) => id !== 'format-document' })
    assert.equal(items.some((item) => item.id === 'format-document'), false)
    assert.deepEqual(
      items.map((item) => item.id),
      WORKBENCH_PALETTE_COMMANDS.map((definition) => definition.id).filter(
        (id) => id !== 'format-document'
      )
    )
  })

  void test('keeps the English name as an alias only when the interface is not English', () => {
    assert.equal(command(buildCommands('en-US'), 'toggle-word-wrap').alias, null)
    const chinese = command(buildCommands('zh-CN'), 'toggle-word-wrap')
    assert.equal(chinese.label, '切换自动换行')
    assert.equal(chinese.alias, 'Toggle Word Wrap')
  })
})

void describe('Workbench command palette filtering', () => {
  void test('lists everything in registry order for an empty query', () => {
    const items = buildCommands('en-US')
    assert.deepEqual(
      filterWorkbenchPaletteCommands(items, '  ').map((match) => match.command.id),
      items.map((item) => item.id)
    )
  })

  void test('matches names fuzzily and returns the matched characters', () => {
    const items = buildCommands('en-US')
    const [first] = filterWorkbenchPaletteCommands(items, 'tww')
    assert.equal(first?.command.id, 'toggle-word-wrap')
    assert.deepEqual(first?.labelMatches, [0, 7, 12])
    assert.equal(first?.aliasMatches, null)

    assert.equal(filterWorkbenchPaletteCommands(items, 'format')[0]?.command.id, 'format-document')
    // 几段都要命中，顺序不限。
    assert.equal(filterWorkbenchPaletteCommands(items, 'wrap toggle')[0]?.command.id, 'toggle-word-wrap')
    assert.deepEqual(filterWorkbenchPaletteCommands(items, 'zzzz'), [])
  })

  void test('finds Chinese names by Chinese or by their English alias', () => {
    const items = buildCommands('zh-CN')
    const [byChinese] = filterWorkbenchPaletteCommands(items, '换行')
    assert.equal(byChinese?.command.id, 'toggle-word-wrap')
    assert.deepEqual(byChinese?.labelMatches, [4, 5])

    const [byAlias] = filterWorkbenchPaletteCommands(items, 'word wrap')
    assert.equal(byAlias?.command.id, 'toggle-word-wrap')
    assert.deepEqual(byAlias?.labelMatches, [])
    assert.deepEqual(byAlias?.aliasMatches, [7, 8, 9, 10, 12, 13, 14, 15])
  })

  void test('keeps the registry order between equally good matches', () => {
    const items = buildCommands('en-US')
    const ids = filterWorkbenchPaletteCommands(items, 'toggle').map((match) => match.command.id)
    assert.deepEqual(
      ids,
      WORKBENCH_PALETTE_COMMANDS.map((definition) => definition.id).filter((id) => id.startsWith('toggle-'))
    )
  })
})

void describe('Workbench command palette availability', () => {
  void test('editor commands need the current file editor in front', () => {
    assert.equal(isWorkbenchPaletteCommandAvailable('format-document', FileInFront), true)
    assert.equal(isWorkbenchPaletteCommandAvailable('toggle-read-only', FileInFront), true)
    assert.equal(isWorkbenchPaletteCommandAvailable('toggle-git-blame', FileInFront), true)
    for (const context of [
      { ...FileInFront, editorCovered: true },
      { ...FileInFront, activeFileIsText: false },
      { ...FileInFront, hasActiveFile: false },
    ]) {
      assert.equal(isWorkbenchPaletteCommandAvailable('format-document', context), false)
      assert.equal(isWorkbenchPaletteCommandAvailable('toggle-read-only', context), false)
      assert.equal(isWorkbenchPaletteCommandAvailable('toggle-git-blame', context), false)
    }
    // 只读文件不格式化，但能切回编辑。
    const readOnly = { ...FileInFront, canEditActiveFile: false }
    assert.equal(isWorkbenchPaletteCommandAvailable('format-document', readOnly), false)
    assert.equal(isWorkbenchPaletteCommandAvailable('toggle-read-only', readOnly), true)
    assert.equal(
      isWorkbenchPaletteCommandAvailable('toggle-read-only', { ...FileInFront, canToggleReadOnly: false }),
      false
    )
  })

  void test('code actions need an editable file that a language service looks after', () => {
    assert.equal(isWorkbenchPaletteCommandAvailable('quick-fix', FileInFront), true)
    assert.equal(
      isWorkbenchPaletteCommandAvailable('quick-fix', { ...FileInFront, activeFileLanguageService: 'external' }),
      true
    )
    // 重构、整理 import 只有内置 TypeScript 服务给。
    for (const id of ['refactor', 'organize-imports'] as const) {
      assert.equal(isWorkbenchPaletteCommandAvailable(id, FileInFront), true, id)
      assert.equal(
        isWorkbenchPaletteCommandAvailable(id, { ...FileInFront, activeFileLanguageService: 'external' }),
        false,
        id
      )
    }
    for (const context of [
      { ...FileInFront, activeFileLanguageService: null },
      { ...FileInFront, canEditActiveFile: false },
      { ...FileInFront, editorCovered: true },
      { ...FileInFront, hasActiveFile: false },
    ]) {
      for (const id of ['quick-fix', 'refactor', 'organize-imports'] as const)
        assert.equal(isWorkbenchPaletteCommandAvailable(id, context), false, id)
    }
  })

  void test('finding references needs a language service but not an editable file', () => {
    assert.equal(isWorkbenchPaletteCommandAvailable('find-references', FileInFront), true)
    for (const context of [
      { ...FileInFront, activeFileLanguageService: 'external' as const },
      { ...FileInFront, canEditActiveFile: false },
    ])
      assert.equal(isWorkbenchPaletteCommandAvailable('find-references', context), true)
    for (const context of [
      { ...FileInFront, activeFileLanguageService: null },
      { ...FileInFront, editorCovered: true },
      { ...FileInFront, hasActiveFile: false },
    ])
      assert.equal(isWorkbenchPaletteCommandAvailable('find-references', context), false)
  })

  void test('the call hierarchy needs the TypeScript service but not an editable file', () => {
    assert.equal(isWorkbenchPaletteCommandAvailable('call-hierarchy', FileInFront), true)
    assert.equal(
      isWorkbenchPaletteCommandAvailable('call-hierarchy', { ...FileInFront, canEditActiveFile: false }),
      true
    )
    for (const context of [
      { ...FileInFront, activeFileLanguageService: 'external' as const },
      { ...FileInFront, activeFileLanguageService: null },
      { ...FileInFront, editorCovered: true },
      { ...FileInFront, hasActiveFile: false },
    ])
      assert.equal(isWorkbenchPaletteCommandAvailable('call-hierarchy', context), false)
  })

  void test('test commands appear when the editor in front can run tests', () => {
    const testFile: WorkbenchPaletteCommandContext = {
      ...FileInFront,
      editorActions: ['run-test-at-cursor', 'run-test-file'],
    }
    for (const id of ['run-test-at-cursor', 'run-test-file'] as const) {
      assert.equal(isWorkbenchPaletteCommandAvailable(id, testFile), true, id)
      // 不是测试文件、没认出运行器：编辑器没登记这个动作。
      assert.equal(isWorkbenchPaletteCommandAvailable(id, FileInFront), false, id)
      assert.equal(isWorkbenchPaletteCommandAvailable(id, { ...testFile, editorCovered: true }), false, id)
    }
  })

  void test('debug commands appear only when they can do something', () => {
    // 调试光标处的测试、切换断点：眼前的编辑器做得了才有（测试文件 / JS、TS 文件）。
    const testFile: WorkbenchPaletteCommandContext = {
      ...FileInFront,
      editorActions: ['debug-test-at-cursor', 'toggle-breakpoint'],
    }
    for (const id of ['debug-test-at-cursor', 'toggle-breakpoint'] as const) {
      assert.equal(isWorkbenchPaletteCommandAvailable(id, testFile), true, id)
      assert.equal(isWorkbenchPaletteCommandAvailable(id, FileInFront), false, id)
      assert.equal(isWorkbenchPaletteCommandAvailable(id, { ...testFile, editorCovered: true }), false, id)
    }
    // 调试当前运行配置：▶ 指着一个 Node 程序才有。
    assert.equal(isWorkbenchPaletteCommandAvailable('debug-configuration', FileInFront), false)
    assert.equal(
      isWorkbenchPaletteCommandAvailable('debug-configuration', { ...FileInFront, canDebugConfiguration: true }),
      true
    )
    // 面板随时能开。
    assert.equal(isWorkbenchPaletteCommandAvailable('toggle-debug-panel', FileInFront), true)

    // 控制命令：继续与单步要程序停着，暂停要它在跑，结束只要在调试。
    const available = (debugStatus: WorkbenchPaletteCommandContext['debugStatus']): string[] =>
      (
        ['debug-continue', 'debug-pause', 'debug-step-over', 'debug-step-into', 'debug-step-out', 'debug-stop'] as const
      ).filter((id) => isWorkbenchPaletteCommandAvailable(id, { ...FileInFront, debugStatus }))
    assert.deepEqual(available('idle'), [])
    assert.deepEqual(available('running'), ['debug-pause', 'debug-stop'])
    assert.deepEqual(available('paused'), [
      'debug-continue',
      'debug-step-over',
      'debug-step-into',
      'debug-step-out',
      'debug-stop',
    ])

    // 右侧写着此刻的按键。
    const commands = buildCommands('zh-CN')
    assert.deepEqual(
      (['debug-continue', 'debug-step-over', 'debug-step-into', 'debug-step-out', 'debug-stop'] as const).map(
        (id) => `${command(commands, id).label} ${command(commands, id).shortcut}`
      ),
      ['调试：继续 F8', '调试：单步跳过 F10', '调试：单步进入 F11', '调试：单步跳出 ⇧F11', '调试：结束调试 ⇧F5']
    )
    assert.equal(command(buildCommands('en-US', { platform: Linux }), 'debug-step-out').shortcut, 'Shift+F11')
    assert.equal(command(commands, 'debug-pause').shortcut, null)
  })

  void test('go to line brings a covered text file back, but needs one', () => {
    assert.equal(isWorkbenchPaletteCommandAvailable('go-to-line', { ...FileInFront, editorCovered: true }), true)
    assert.equal(isWorkbenchPaletteCommandAvailable('go-to-line', { ...FileInFront, activeFileIsText: false }), false)
    assert.equal(isWorkbenchPaletteCommandAvailable('go-to-line', { ...FileInFront, hasActiveFile: false }), false)
    // 转到文件中的符号同样是对着当前文件：盖着别的也能用，没有文本文件不给。
    assert.equal(isWorkbenchPaletteCommandAvailable('go-to-symbol', FileInFront), true)
    assert.equal(isWorkbenchPaletteCommandAvailable('go-to-symbol', { ...FileInFront, editorCovered: true }), true)
    assert.equal(isWorkbenchPaletteCommandAvailable('go-to-symbol', { ...FileInFront, activeFileIsText: false }), false)
    assert.equal(isWorkbenchPaletteCommandAvailable('go-to-symbol', { ...FileInFront, hasActiveFile: false }), false)
  })

  void test('tab commands need something to act on', () => {
    const empty: WorkbenchPaletteCommandContext = {
      hasActiveFile: false,
      activeFileIsText: true,
      canEditActiveFile: false,
      canToggleReadOnly: false,
      editorCovered: false,
      openTabCount: 0,
      activeFileLanguageService: null,
      canSplitEditorRight: false,
      editorGroupCount: 1,
      editorActions: [],
      debugStatus: 'idle',
      canDebugConfiguration: false,
    }
    for (const id of ['save-current', 'save-all', 'close-editor', 'close-all-editors', 'reveal-active-file'] as const)
      assert.equal(isWorkbenchPaletteCommandAvailable(id, empty), false, id)
    // 盖在前面的对比、预览也能关。
    assert.equal(isWorkbenchPaletteCommandAvailable('close-editor', { ...empty, editorCovered: true }), true)
    for (const id of ['go-to-file', 'toggle-terminal', 'open-settings', 'toggle-word-wrap', 'navigate-back'] as const)
      assert.equal(isWorkbenchPaletteCommandAvailable(id, empty), true, id)
  })
})
