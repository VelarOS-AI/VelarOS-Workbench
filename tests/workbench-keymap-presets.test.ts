/**
 * 键位方案下的全局快捷键：各方案的默认键、存下来的设置怎么读、用户改的键怎么叠在方案上面。
 * 编辑器命令那张表在 `workbench-editor-keymap.test.ts`。
 */
import assert from 'node:assert/strict'

import { describe, test } from 'bun:test'

import {
  buildWorkbenchKeymapConflicts,
  DEFAULT_WORKBENCH_KEYBOARD_SHORTCUT_MAP,
  DEFAULT_WORKBENCH_KEYMAP_SETTINGS,
  formatWorkbenchShortcutForPlatform,
  formatWorkbenchShortcutHint,
  getWorkbenchKeyboardShortcut,
  getWorkbenchKeymapPresetShortcuts,
  normalizeWorkbenchKeymapSettings,
  readWorkbenchKeyboardShortcutMap,
  readWorkbenchKeymapSettings,
  resetWorkbenchKeymapShortcut,
  resolveWorkbenchKeyboardShortcutMap,
  saveWorkbenchKeymapSettings,
  setWorkbenchKeymapShortcut,
  shortcutFromWorkbenchKeyboardEvent,
  WORKBENCH_KEYBOARD_SHORTCUT_DEFINITIONS,
  WORKBENCH_KEYMAP_CHANGED_EVENT,
  WORKBENCH_KEYMAP_STORAGE_KEY,
  type WorkbenchKeyboardShortcutAction,
  type WorkbenchKeyboardShortcutMap,
} from '../src/renderer/src/models/layout/workbenchKeyboardShortcuts'
import {
  normalizeWorkbenchKeymapPreset,
  resolveWorkbenchKeymapPlatform,
  WORKBENCH_KEYMAP_PRESET_IDS,
} from '../src/renderer/src/models/layout/workbenchKeymapPresets'
import type { StorageLike } from '../src/renderer/src/persistence/localStorageJsonStore'

import {
  keymapTestEventFor,
  type KeymapTestPlatform,
  KeymapTestPlatforms,
} from './helpers/workbenchKeymapChords'

const Mac = 'MacIntel'
const Windows = 'Win32'
const Linux = 'Linux x86_64'

const Actions = WORKBENCH_KEYBOARD_SHORTCUT_DEFINITIONS.map((definition) => definition.action)

function createMemoryStorage(initial: Record<string, string> = {}): StorageLike & {
  values: Map<string, string>
} {
  const values = new Map(Object.entries(initial))
  return {
    values,
    getItem: (key) => values.get(key) ?? null,
    removeItem: (key) => {
      values.delete(key)
    },
    setItem: (key, value) => {
      values.set(key, value)
    },
  }
}

/** 这个方案里与 Workbench 不一样的那几项。 */
function differences(
  preset: 'vscode' | 'jetbrains',
  platform: KeymapTestPlatform
): Partial<WorkbenchKeyboardShortcutMap> {
  const workbench = getWorkbenchKeymapPresetShortcuts('workbench', platform)
  const shortcuts = getWorkbenchKeymapPresetShortcuts(preset, platform)
  return Object.fromEntries(Actions.flatMap((action) =>
    shortcuts[action] === workbench[action] ? [] : [[action, shortcuts[action]]]
  ))
}

void describe('keymap presets: app-wide shortcuts', () => {
  void test('the Workbench preset is the keymap there was before presets', () => {
    const common: Omit<WorkbenchKeyboardShortcutMap, 'navigate-back' | 'navigate-forward'> = {
      'quick-open': 'Mod+P',
      'command-palette': 'Mod+Shift+P',
      'go-to-symbol': 'Mod+Shift+O',
      'find-in-files': 'Mod+Shift+F',
      'reopen-closed-tab': 'Mod+Shift+T',
      'split-editor-right': 'Mod+Backslash',
      'focus-left-editor-group': 'Mod+1',
      'focus-right-editor-group': 'Mod+2',
      'save-current': 'Mod+S',
      'save-all': 'Mod+Shift+S',
      'run-last-command': 'Mod+Enter',
      'debug-continue': 'F8',
      'debug-step-over': 'F10',
      'debug-step-into': 'F11',
      'debug-step-out': 'Shift+F11',
      'debug-stop': 'Shift+F5',
      'toggle-problems': 'Mod+Shift+I',
      'toggle-changes': 'Mod+Shift+G',
      'toggle-actions': 'Mod+Shift+A',
      'close-right-tool': 'Escape',
    }
    assert.deepEqual(getWorkbenchKeymapPresetShortcuts('workbench', Mac), {
      ...common,
      'navigate-back': 'Ctrl+Minus',
      'navigate-forward': 'Ctrl+Shift+Minus',
    })
    for (const platform of [Windows, Linux])
      assert.deepEqual(getWorkbenchKeymapPresetShortcuts('workbench', platform), {
        ...common,
        'navigate-back': 'Alt+ArrowLeft',
        'navigate-forward': 'Alt+ArrowRight',
      })

    // 设置里的排列顺序没变；默认的那张表就是 Workbench 方案在当前平台上的键。
    assert.deepEqual(Actions, [
      'quick-open',
      'command-palette',
      'go-to-symbol',
      'find-in-files',
      'navigate-back',
      'navigate-forward',
      'reopen-closed-tab',
      'split-editor-right',
      'focus-left-editor-group',
      'focus-right-editor-group',
      'save-current',
      'save-all',
      'run-last-command',
      'debug-continue',
      'debug-step-over',
      'debug-step-into',
      'debug-step-out',
      'debug-stop',
      'toggle-problems',
      'toggle-changes',
      'toggle-actions',
      'close-right-tool',
    ])
    assert.deepEqual(
      DEFAULT_WORKBENCH_KEYBOARD_SHORTCUT_MAP,
      getWorkbenchKeymapPresetShortcuts('workbench')
    )
    for (const definition of WORKBENCH_KEYBOARD_SHORTCUT_DEFINITIONS)
      assert.equal(
        definition.defaultShortcut,
        DEFAULT_WORKBENCH_KEYBOARD_SHORTCUT_MAP[definition.action]
      )
  })

  void test('the VS Code preset changes these shortcuts', () => {
    assert.deepEqual(differences('vscode', Mac), {
      'save-all': 'Mod+Alt+KeyS',
      'debug-continue': 'F5',
      'toggle-problems': 'Mod+Shift+M',
      'toggle-changes': 'Ctrl+Shift+G',
      'toggle-actions': 'Mod+Ctrl+I',
    })
    assert.deepEqual(differences('vscode', Windows), {
      'debug-continue': 'F5',
      'toggle-problems': 'Mod+Shift+M',
      'toggle-actions': 'Mod+Alt+I',
    })
    // Linux 上后退 / 前进是另一组键。
    assert.deepEqual(differences('vscode', Linux), {
      'navigate-back': 'Mod+Alt+Minus',
      'navigate-forward': 'Mod+Shift+Minus',
      'debug-continue': 'F5',
      'toggle-problems': 'Mod+Shift+M',
      'toggle-actions': 'Mod+Alt+I',
    })
  })

  void test('the JetBrains preset changes these shortcuts', () => {
    const debugKeys = {
      'debug-continue': 'F9',
      'debug-step-over': 'F8',
      'debug-step-into': 'F7',
      'debug-step-out': 'Shift+F8',
      'debug-stop': 'Mod+F2',
    }
    assert.deepEqual(differences('jetbrains', Mac), {
      'quick-open': 'Mod+Shift+O',
      'command-palette': 'Mod+Shift+A',
      'go-to-symbol': 'Mod+F12',
      'navigate-back': 'Mod+[',
      'navigate-forward': 'Mod+]',
      ...debugKeys,
      'toggle-problems': 'Mod+6',
      'toggle-changes': 'Mod+9',
      'toggle-actions': '',
    })
    for (const platform of [Windows, Linux])
      assert.deepEqual(differences('jetbrains', platform), {
        // Ctrl+Shift+N（转到文件）是应用菜单的「新建项目」：快速打开留着 Ctrl+P。
        'command-palette': 'Mod+Shift+A',
        'go-to-symbol': 'Mod+F12',
        'navigate-back': 'Mod+Alt+ArrowLeft',
        'navigate-forward': 'Mod+Alt+ArrowRight',
        'run-last-command': 'Mod+F5',
        ...debugKeys,
        'toggle-problems': 'Alt+6',
        'toggle-changes': 'Alt+9',
        'toggle-actions': '',
      })
  })

  void test('the Vim preset uses the Workbench shortcuts', () => {
    for (const platform of KeymapTestPlatforms)
      assert.deepEqual(
        getWorkbenchKeymapPresetShortcuts('vim', platform),
        getWorkbenchKeymapPresetShortcuts('workbench', platform)
      )
  })

  void test('every action has a key in every preset, or is unbound on purpose', () => {
    for (const preset of WORKBENCH_KEYMAP_PRESET_IDS) {
      for (const platform of KeymapTestPlatforms) {
        const shortcuts = getWorkbenchKeymapPresetShortcuts(preset, platform)
        assert.deepEqual(Object.keys(shortcuts), Actions, `${preset} ${platform}`)
        assert.deepEqual(
          Actions.filter((action) => shortcuts[action] === ''),
          // JetBrains 没有给 AI 聊天的键，Workbench 的那个键在这个方案里是「查找操作」。
          preset === 'jetbrains' ? ['toggle-actions'] : [],
          `${preset} ${platform}`
        )
      }
    }
  })

  void test('no two actions share a key inside a preset, and every key fires its own action', () => {
    for (const preset of WORKBENCH_KEYMAP_PRESET_IDS) {
      for (const platform of KeymapTestPlatforms) {
        const shortcuts = getWorkbenchKeymapPresetShortcuts(preset, platform)
        assert.deepEqual(buildWorkbenchKeymapConflicts(shortcuts), [], `${preset} ${platform}`)
        for (const action of Actions) {
          const shortcut = shortcuts[action]
          if (!shortcut) continue
          assert.equal(
            getWorkbenchKeyboardShortcut(keymapTestEventFor(shortcut, platform), shortcuts, platform),
            action,
            `${preset} ${platform} ${shortcut}`
          )
        }
      }
    }

    // 没有键的动作什么键都触发不了它。
    const jetbrains = getWorkbenchKeymapPresetShortcuts('jetbrains', Mac)
    assert.equal(
      getWorkbenchKeyboardShortcut(keymapTestEventFor('Mod+Shift+A', Mac), jetbrains, Mac),
      'command-palette'
    )
    assert.equal(
      getWorkbenchKeyboardShortcut(
        { key: '', code: '', altKey: false, ctrlKey: false, metaKey: false, shiftKey: false },
        jetbrains,
        Mac
      ),
      null
    )
  })

  void test('platforms: macOS, Windows, Linux; anything unknown counts as Linux', () => {
    assert.equal(resolveWorkbenchKeymapPlatform(Mac), 'mac')
    assert.equal(resolveWorkbenchKeymapPlatform('iPad'), 'mac')
    assert.equal(resolveWorkbenchKeymapPlatform(Windows), 'windows')
    assert.equal(resolveWorkbenchKeymapPlatform(Linux), 'linux')
    assert.equal(resolveWorkbenchKeymapPlatform(''), 'linux')
  })
})

void describe('keymap presets: stored settings', () => {
  void test('the stored preset and the user keys are validated on read', () => {
    assert.deepEqual(normalizeWorkbenchKeymapSettings(undefined), DEFAULT_WORKBENCH_KEYMAP_SETTINGS)
    assert.deepEqual(normalizeWorkbenchKeymapSettings('vscode'), DEFAULT_WORKBENCH_KEYMAP_SETTINGS)
    assert.deepEqual(normalizeWorkbenchKeymapSettings([]), DEFAULT_WORKBENCH_KEYMAP_SETTINGS)

    for (const preset of WORKBENCH_KEYMAP_PRESET_IDS)
      assert.deepEqual(normalizeWorkbenchKeymapSettings({ preset }), { preset, overrides: {} })
    // 不认识的方案名（手改的、别的版本写的）：用默认方案，不去猜它是哪一个。
    for (const preset of ['VSCode', 'vs-code', 'intellij', 'emacs', '', 3, null])
      assert.equal(normalizeWorkbenchKeymapSettings({ preset }).preset, 'workbench')
    assert.equal(normalizeWorkbenchKeymapPreset('jetbrains'), 'jetbrains')

    assert.deepEqual(
      normalizeWorkbenchKeymapSettings({
        preset: 'jetbrains',
        overrides: {
          'quick-open': 'Mod+E',
          // 不认识的动作、不是字符串的、解析不了的键、分两步按的键：都丢掉，那个动作用方案的默认键。
          'open-everything': 'Mod+K',
          'save-all': 12,
          'toggle-problems': '',
          'toggle-changes': 'Mod+Hyper+G+',
          'go-to-symbol': 'Mod+K Mod+O',
          'toggle-actions': 'Mod+Alt+KeyA',
        },
        somethingElse: true,
      }),
      { preset: 'jetbrains', overrides: { 'quick-open': 'Mod+E', 'toggle-actions': 'Mod+Alt+KeyA' } }
    )
    assert.deepEqual(normalizeWorkbenchKeymapSettings({ preset: 'vim', overrides: 'Mod+P' }), {
      preset: 'vim',
      overrides: {},
    })
  })

  void test('the keymap that older versions stored is not read or converted', () => {
    // 以前存的是整张「动作 → 键」表，在另一个键下。
    const oldKeymap = { ...DEFAULT_WORKBENCH_KEYBOARD_SHORTCUT_MAP, 'quick-open': 'Mod+E' }
    const storage = createMemoryStorage({
      'velaros.workbench.keymap.v1': JSON.stringify(oldKeymap),
    })
    assert.equal(WORKBENCH_KEYMAP_STORAGE_KEY, 'velaros.workbench.keymap.v2')
    assert.deepEqual(readWorkbenchKeymapSettings(storage), DEFAULT_WORKBENCH_KEYMAP_SETTINGS)
    assert.deepEqual(readWorkbenchKeyboardShortcutMap(storage), DEFAULT_WORKBENCH_KEYBOARD_SHORTCUT_MAP)

    // 那种形状就算放到新的键下也不认：没有方案、没有改过的键。
    assert.deepEqual(normalizeWorkbenchKeymapSettings(oldKeymap), DEFAULT_WORKBENCH_KEYMAP_SETTINGS)

    // 坏掉的 JSON 同样回到默认设置。
    storage.setItem(WORKBENCH_KEYMAP_STORAGE_KEY, '{"preset":')
    assert.deepEqual(readWorkbenchKeymapSettings(storage), DEFAULT_WORKBENCH_KEYMAP_SETTINGS)
  })

  void test('saving writes the preset and only the keys the user changed', () => {
    const storage = createMemoryStorage()
    const events: unknown[] = []
    const target = {
      dispatchEvent: (event: Event) => {
        events.push((event as CustomEvent).detail)
        assert.equal(event.type, WORKBENCH_KEYMAP_CHANGED_EVENT)
        return true
      },
    } as unknown as Window

    saveWorkbenchKeymapSettings(
      { preset: 'vscode', overrides: { 'quick-open': 'Mod+E' } },
      storage,
      target
    )
    const stored = { preset: 'vscode', overrides: { 'quick-open': 'Mod+E' } }
    assert.deepEqual(JSON.parse(storage.values.get(WORKBENCH_KEYMAP_STORAGE_KEY) ?? ''), stored)
    assert.deepEqual(events, [stored])
    assert.deepEqual(readWorkbenchKeymapSettings(storage), stored)
    assert.equal(readWorkbenchKeyboardShortcutMap(storage)['quick-open'], 'Mod+E')
    assert.equal(readWorkbenchKeyboardShortcutMap(storage)['toggle-problems'], 'Mod+Shift+M')
  })
})

void describe('keymap presets: the user keys on top of a preset', () => {
  void test('a changed key stays when the preset changes; the rest follows the preset', () => {
    const changed = setWorkbenchKeymapShortcut(DEFAULT_WORKBENCH_KEYMAP_SETTINGS, 'quick-open', 'Mod+E', Mac)
    assert.deepEqual(changed, { preset: 'workbench', overrides: { 'quick-open': 'Mod+E' } })

    for (const preset of WORKBENCH_KEYMAP_PRESET_IDS) {
      const keymap = resolveWorkbenchKeyboardShortcutMap({ ...changed, preset }, Mac)
      assert.deepEqual(keymap, {
        ...getWorkbenchKeymapPresetShortcuts(preset, Mac),
        'quick-open': 'Mod+E',
      })
    }
    assert.equal(
      resolveWorkbenchKeyboardShortcutMap({ ...changed, preset: 'jetbrains' }, Mac)['command-palette'],
      'Mod+Shift+A'
    )
  })

  void test('reset returns to the default of the chosen preset', () => {
    const vscode = { preset: 'vscode' as const, overrides: {} }
    const changed = setWorkbenchKeymapShortcut(vscode, 'toggle-problems', 'Mod+Shift+I', Mac)
    assert.equal(resolveWorkbenchKeyboardShortcutMap(changed, Mac)['toggle-problems'], 'Mod+Shift+I')

    const reset = resetWorkbenchKeymapShortcut(changed, 'toggle-problems')
    assert.deepEqual(reset, vscode)
    assert.equal(resolveWorkbenchKeyboardShortcutMap(reset, Mac)['toggle-problems'], 'Mod+Shift+M')

    // 录回方案的默认键就等于重置：不记成改过的，以后换方案它跟着方案走。
    assert.deepEqual(setWorkbenchKeymapShortcut(changed, 'toggle-problems', 'Mod+Shift+M', Mac), vscode)
    // 同一个键在另一个方案里不是默认键，那就是改过的。
    assert.deepEqual(
      setWorkbenchKeymapShortcut(DEFAULT_WORKBENCH_KEYMAP_SETTINGS, 'toggle-problems', 'Mod+Shift+M', Mac),
      { preset: 'workbench', overrides: { 'toggle-problems': 'Mod+Shift+M' } }
    )
    // 解析不了的键不收。
    assert.equal(setWorkbenchKeymapShortcut(changed, 'quick-open', 'Mod+', Mac), changed)
    // 没有键的动作可以录一个，重置回到没有键。
    const jetbrains = { preset: 'jetbrains' as const, overrides: {} }
    const chat = setWorkbenchKeymapShortcut(jetbrains, 'toggle-actions', 'Mod+Shift+J', Mac)
    assert.equal(resolveWorkbenchKeyboardShortcutMap(chat, Mac)['toggle-actions'], 'Mod+Shift+J')
    assert.equal(
      resolveWorkbenchKeyboardShortcutMap(resetWorkbenchKeymapShortcut(chat, 'toggle-actions'), Mac)[
        'toggle-actions'
      ],
      ''
    )
  })

  void test('conflicts are found against the chosen preset', () => {
    // ⇧⌘M 在 Workbench 方案里没有动作用，在 VS Code 方案里是「切换问题」。
    const overrides = { 'quick-open': 'Mod+Shift+M' }
    assert.deepEqual(
      buildWorkbenchKeymapConflicts(
        resolveWorkbenchKeyboardShortcutMap({ preset: 'workbench', overrides }, Mac)
      ),
      []
    )
    assert.deepEqual(
      buildWorkbenchKeymapConflicts(
        resolveWorkbenchKeyboardShortcutMap({ preset: 'vscode', overrides }, Mac)
      ),
      [{ shortcut: 'mod+shift+m', actions: ['quick-open', 'toggle-problems'] }]
    )
    // 没有键的动作不与谁冲突。
    const unbound: Partial<Record<WorkbenchKeyboardShortcutAction, string>> = {}
    assert.deepEqual(
      buildWorkbenchKeymapConflicts(
        resolveWorkbenchKeyboardShortcutMap({ preset: 'jetbrains', overrides: unbound }, Mac)
      ),
      []
    )
  })
})

void describe('keymap presets: keys written by their physical position', () => {
  void test('⌥⌘S matches by the key position and shows as the letter', () => {
    const keymap = getWorkbenchKeymapPresetShortcuts('vscode', Mac)
    assert.equal(keymap['save-all'], 'Mod+Alt+KeyS')
    // ⌥S 打出来的是 ß。
    const event = { key: 'ß', code: 'KeyS', metaKey: true, altKey: true, ctrlKey: false, shiftKey: false }
    assert.equal(getWorkbenchKeyboardShortcut(event, keymap, Mac), 'save-all')
    assert.equal(getWorkbenchKeyboardShortcut({ ...event, altKey: false, key: 's' }, keymap, Mac), 'save-current')

    assert.equal(formatWorkbenchShortcutHint('Mod+Alt+KeyS', Mac), '⌥⌘S')
    assert.equal(formatWorkbenchShortcutForPlatform('Mod+Alt+KeyS', Mac), 'Cmd+Alt+S')
    assert.equal(formatWorkbenchShortcutHint('Alt+Digit6', Windows), 'Alt+6')
  })

  void test('recording Option+letter on macOS writes the key position', () => {
    assert.equal(
      shortcutFromWorkbenchKeyboardEvent(
        { key: 'ß', code: 'KeyS', metaKey: true, altKey: true, ctrlKey: false, shiftKey: false },
        Mac
      ),
      'Mod+Alt+KeyS'
    )
    assert.equal(
      shortcutFromWorkbenchKeyboardEvent(
        { key: '¡', code: 'Digit1', metaKey: false, altKey: true, ctrlKey: false, shiftKey: false },
        Mac
      ),
      'Alt+Digit1'
    )
    // 别的平台上 Alt 加字母打出来的还是那个字母，照原来的办法记。
    assert.equal(
      shortcutFromWorkbenchKeyboardEvent(
        { key: 's', code: 'KeyS', metaKey: false, altKey: true, ctrlKey: true, shiftKey: false },
        Windows
      ),
      'Mod+Alt+S'
    )
    // 方向键、功能键不受影响。
    assert.equal(
      shortcutFromWorkbenchKeyboardEvent(
        { key: 'ArrowLeft', code: 'ArrowLeft', metaKey: true, altKey: true, ctrlKey: false, shiftKey: false },
        Mac
      ),
      'Mod+Alt+ArrowLeft'
    )
  })

  void test('hints and the settings list show the key cap', () => {
    assert.equal(formatWorkbenchShortcutHint('Mod+[', Mac), '⌘[')
    assert.equal(formatWorkbenchShortcutHint('Mod+Alt+ArrowLeft', Windows), 'Ctrl+Alt+←')
    assert.equal(formatWorkbenchShortcutHint('Mod+Alt+ArrowUp', Mac), '⌥⌘↑')
    assert.equal(formatWorkbenchShortcutHint('Mod+Ctrl+I', Mac), '⌃⌘I')
    assert.equal(formatWorkbenchShortcutHint('Mod+Alt+Minus', Linux), 'Ctrl+Alt+-')
    assert.equal(formatWorkbenchShortcutHint('Mod+F12', Mac), '⌘F12')
    assert.equal(formatWorkbenchShortcutHint('', Mac), '')
    assert.equal(formatWorkbenchShortcutHint('', Linux), '')

    assert.equal(formatWorkbenchShortcutForPlatform('Mod+Shift+P', Mac), 'Cmd+Shift+P')
    assert.equal(formatWorkbenchShortcutForPlatform('Mod+Shift+P', Windows), 'Ctrl+Shift+P')
    assert.equal(formatWorkbenchShortcutForPlatform('Ctrl+Shift+Minus', Mac), 'Ctrl+Shift+-')
    assert.equal(formatWorkbenchShortcutForPlatform('Mod+Backslash', Linux), 'Ctrl+\\')
    assert.equal(formatWorkbenchShortcutForPlatform('Mod++', Linux), 'Ctrl++')
    assert.equal(formatWorkbenchShortcutForPlatform('', Mac), '')
  })
})
