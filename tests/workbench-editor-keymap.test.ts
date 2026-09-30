/**
 * 编辑器命令的键位表：各方案、各平台上按键怎么落到命令，表里有没有一个键两个意思，哪些键让给了应用菜单。
 * Workbench 方案与改成键位方案之前逐键一致，钉在 `workbench-editor-keymap-pin.test.ts`。
 */
import assert from 'node:assert/strict'

import { standardKeymap } from '@codemirror/commands'
import { describe, test } from 'bun:test'

import {
  getWorkbenchEditorCommandChords,
  getWorkbenchEditorCommandShortcut,
  listWorkbenchEditorKeymapBindings,
  resolveWorkbenchEditorKeymapCommand,
  WORKBENCH_EDITOR_KEYMAP_COMMANDS,
  type WorkbenchEditorKeymapCommandId,
  WorkbenchEditorKeymapSharedChords,
} from '../src/renderer/src/models/editor/workbenchEditorKeymap'
import {
  getWorkbenchKeymapPresetShortcuts,
  WORKBENCH_KEYBOARD_SHORTCUT_DEFINITIONS,
} from '../src/renderer/src/models/layout/workbenchKeyboardShortcuts'
import {
  WORKBENCH_KEYMAP_PRESET_IDS,
  type WorkbenchKeymapPresetId,
} from '../src/renderer/src/models/layout/workbenchKeymapPresets'

import {
  keymapTestEventFor,
  type KeymapTestPlatform,
  KeymapTestPlatforms,
  keymapTestSignature,
} from './helpers/workbenchKeymapChords'
import { listWorkbenchMenuKeys, listWorkbenchMenuRoles } from './helpers/workbenchMenuAccelerators'

const Mac = 'MacIntel'
const Windows = 'Win32'
const Linux = 'Linux x86_64'

const TablePresets = ['workbench', 'vscode', 'jetbrains'] as const
type TablePreset = (typeof TablePresets)[number]

type Chords = Partial<Record<WorkbenchEditorKeymapCommandId, readonly string[]>>

/** 这个方案里与 Workbench 不一样的命令和它们的键。 */
function differences(preset: TablePreset, platform: KeymapTestPlatform): Chords {
  return Object.fromEntries(
    WORKBENCH_EDITOR_KEYMAP_COMMANDS.flatMap((command) => {
      const chords = getWorkbenchEditorCommandChords(command, preset, platform)
      const workbench = getWorkbenchEditorCommandChords(command, 'workbench', platform)
      return JSON.stringify(chords) === JSON.stringify(workbench) ? [] : [[command, chords]]
    })
  )
}

function resolve(chord: string, platform: KeymapTestPlatform, preset: WorkbenchKeymapPresetId) {
  return resolveWorkbenchEditorKeymapCommand(keymapTestEventFor(chord, platform), platform, preset)
}

function key(
  code: string,
  value: string,
  modifiers: { alt?: boolean; ctrl?: boolean; meta?: boolean; shift?: boolean; keyCode?: number } = {}
) {
  return {
    code,
    key: value,
    keyCode: modifiers.keyCode,
    altKey: !!modifiers.alt,
    ctrlKey: !!modifiers.ctrl,
    metaKey: !!modifiers.meta,
    shiftKey: !!modifiers.shift,
  }
}

void describe('editor keymap: the presets', () => {
  void test('the VS Code preset changes these commands', () => {
    const common: Chords = {
      'find-references': ['Shift+F12'],
      'call-hierarchy': ['Shift+Alt+H'],
      'rename-symbol': ['F2'],
      'quick-fix': ['Mod+.'],
      'previous-problem': ['Shift+F8'],
      'open-lint-panel': [],
      'go-to-line': ['Ctrl+G'],
      'select-all-occurrences': ['Mod+Shift+L', 'Mod+F2'],
      'select-line': ['Mod+L'],
    }
    assert.deepEqual(differences('vscode', Mac), {
      ...common,
      refactor: ['Ctrl+Shift+R'],
      'format-document': ['Shift+Alt+F'],
      'trigger-completion': ['Ctrl+Space', 'Mod+I', 'Alt+Escape'],
      'find-previous': ['Shift+F3', 'Mod+Shift+G'],
      'expand-selection': ['Mod+Ctrl+Shift+ArrowRight'],
      'toggle-tab-focus-mode': ['Ctrl+Shift+M'],
    })
    assert.deepEqual(differences('vscode', Windows), {
      ...common,
      // Ctrl+Shift+R（重构）是应用菜单的「强制重新加载」：留着 Workbench 的键，所以这里没有它。
      'format-document': ['Shift+Alt+F'],
      'trigger-completion': ['Ctrl+Space', 'Mod+I'],
      redo: ['Mod+Y', 'Mod+Shift+Z'],
      'expand-selection': ['Shift+Alt+ArrowRight'],
      'select-syntax-left': [],
      'select-syntax-right': [],
    })
    assert.deepEqual(differences('vscode', Linux), {
      ...common,
      // Ctrl+Shift+I（格式化）是应用菜单的「开发者工具」：格式化留着 Workbench 的键。
      'trigger-completion': ['Ctrl+Space', 'Mod+I'],
      'navigate-back': [],
      'navigate-forward': [],
      'toggle-block-comment': ['Mod+Shift+A'],
      'copy-line-up': ['Ctrl+Shift+Alt+ArrowUp'],
      'copy-line-down': ['Ctrl+Shift+Alt+ArrowDown'],
      'expand-selection': ['Shift+Alt+ArrowRight'],
      'add-cursor-above': ['Ctrl+Shift+ArrowUp', 'Shift+Alt+ArrowUp'],
      'add-cursor-below': ['Ctrl+Shift+ArrowDown', 'Shift+Alt+ArrowDown'],
      'select-syntax-left': [],
      'select-syntax-right': [],
    })
  })

  void test('the JetBrains preset changes these commands', () => {
    const common: Chords = {
      'go-to-definition': ['Mod+B'],
      'find-references': ['Alt+F7', 'Mod+Alt+F7'],
      'quick-fix': ['Alt+Enter'],
      'organize-imports': ['Ctrl+Alt+O'],
      'trigger-completion': ['Ctrl+Space', 'Mod+I'],
      'next-problem': ['F2'],
      'previous-problem': ['Shift+F2'],
      'indent-more': ['Tab'],
      'indent-less': ['Shift+Tab'],
      'reindent-selection': ['Ctrl+Alt+I'],
      'move-line-up': ['Shift+Alt+ArrowUp'],
      'move-line-down': ['Shift+Alt+ArrowDown'],
      'copy-line-up': [],
      'copy-line-down': ['Mod+D'],
      'insert-blank-line': ['Shift+Enter'],
    }
    assert.deepEqual(differences('jetbrains', Mac), {
      ...common,
      'find-next': ['Mod+G', 'F3'],
      'find-previous': ['Mod+Shift+G', 'Shift+F3'],
      'go-to-line': ['Mod+L'],
      'toggle-block-comment': ['Mod+Alt+/'],
      'delete-line': ['Mod+Backspace'],
      'select-next-occurrence': ['Ctrl+G'],
      'select-all-occurrences': ['Mod+Ctrl+G'],
      'expand-selection': ['Alt+ArrowUp'],
      'jump-to-bracket': ['Ctrl+M'],
    })
    const other: Chords = {
      ...common,
      'open-lint-panel': [],
      'find-next': ['F3', 'Mod+L'],
      'find-previous': ['Shift+F3', 'Mod+Shift+L'],
      'go-to-line': ['Ctrl+G'],
      'navigate-back': [],
      'navigate-forward': [],
      'toggle-block-comment': ['Mod+Shift+/'],
      redo: ['Mod+Shift+Z'],
      'select-next-occurrence': ['Alt+J'],
      'select-all-occurrences': ['Ctrl+Alt+Shift+J'],
      'jump-to-bracket': ['Mod+Shift+M'],
    }
    // Windows 上 Ctrl+Y（删除行）是应用菜单的「重做」：删除行留着 Workbench 的键。
    assert.deepEqual(differences('jetbrains', Windows), other)
    assert.deepEqual(differences('jetbrains', Linux), { ...other, 'delete-line': ['Mod+Y'] })
  })

  void test('the Vim preset uses the Workbench table', () => {
    for (const platform of KeymapTestPlatforms) {
      assert.deepEqual(
        listWorkbenchEditorKeymapBindings('vim', platform),
        listWorkbenchEditorKeymapBindings('workbench', platform)
      )
      assert.equal(resolve('Shift+F6', platform, 'vim'), 'rename-symbol')
    }
  })

  void test('every key of every preset resolves to its command, on every platform', () => {
    for (const preset of WORKBENCH_KEYMAP_PRESET_IDS) {
      for (const platform of KeymapTestPlatforms) {
        for (const binding of listWorkbenchEditorKeymapBindings(preset, platform))
          assert.equal(
            resolve(binding.chord, platform, preset),
            binding.command,
            `${preset} ${platform} ${binding.chord}`
          )
      }
    }
  })

  void test('the same key means different things in different presets', () => {
    // F2：VS Code 里改名，JetBrains 里下一个问题，Workbench 里没有。
    assert.equal(resolve('F2', Mac, 'workbench'), null)
    assert.equal(resolve('F2', Mac, 'vscode'), 'rename-symbol')
    assert.equal(resolve('F2', Mac, 'jetbrains'), 'next-problem')
    // ⌘D / Ctrl+D：选中下一处相同的文字，JetBrains 里是往下复制一行。
    assert.equal(resolve('Mod+D', Linux, 'workbench'), 'select-next-occurrence')
    assert.equal(resolve('Mod+D', Linux, 'vscode'), 'select-next-occurrence')
    assert.equal(resolve('Mod+D', Linux, 'jetbrains'), 'copy-line-down')
    // ⌘L / Ctrl+L：跳到行；VS Code 里选中一行；JetBrains 在 Windows / Linux 上是查找下一处。
    assert.equal(resolve('Mod+L', Mac, 'workbench'), 'go-to-line')
    assert.equal(resolve('Mod+L', Mac, 'vscode'), 'select-line')
    assert.equal(resolve('Mod+L', Mac, 'jetbrains'), 'go-to-line')
    assert.equal(resolve('Mod+L', Windows, 'jetbrains'), 'find-next')
    // Ctrl+Y：重做；JetBrains 在 Linux 上是删除行，在 Windows 上编辑器不占（菜单的「重做」）。
    assert.equal(resolve('Mod+Y', Windows, 'workbench'), 'redo')
    assert.equal(resolve('Mod+Y', Linux, 'jetbrains'), 'delete-line')
    assert.equal(resolve('Mod+Y', Windows, 'jetbrains'), null)
    assert.equal(resolve('Mod+Shift+Z', Windows, 'jetbrains'), 'redo')
    // ⌥↑：上移一行，JetBrains 在 macOS 上是扩大选区（上移行是 ⇧⌥↑，Workbench 里那是往上复制一行）。
    assert.equal(resolve('Alt+ArrowUp', Mac, 'workbench'), 'move-line-up')
    assert.equal(resolve('Alt+ArrowUp', Mac, 'jetbrains'), 'expand-selection')
    assert.equal(resolve('Shift+Alt+ArrowUp', Mac, 'workbench'), 'copy-line-up')
    assert.equal(resolve('Shift+Alt+ArrowUp', Mac, 'jetbrains'), 'move-line-up')
    // ⌘] 在 JetBrains 方案的 macOS 上是全局的「前进」，编辑器不占。
    assert.equal(resolve('Mod+]', Mac, 'workbench'), 'indent-more')
    assert.equal(resolve('Mod+]', Mac, 'jetbrains'), null)
    // 查找引用、快速修复各家各一个键，Workbench 两个都认。
    assert.equal(resolve('Alt+F7', Mac, 'vscode'), null)
    assert.equal(resolve('Shift+F12', Mac, 'jetbrains'), null)
    assert.equal(resolve('Mod+.', Windows, 'jetbrains'), null)
    assert.equal(resolve('Alt+Enter', Windows, 'vscode'), null)
  })

  void test('the hint of a command is its first key', () => {
    assert.equal(getWorkbenchEditorCommandShortcut('go-to-line', 'workbench', Mac), 'Ctrl+G')
    assert.equal(getWorkbenchEditorCommandShortcut('go-to-line', 'jetbrains', Mac), 'Mod+L')
    assert.equal(getWorkbenchEditorCommandShortcut('rename-symbol', 'vscode', Windows), 'F2')
    assert.equal(getWorkbenchEditorCommandShortcut('refactor', 'workbench', Mac), 'Ctrl+T')
    assert.equal(getWorkbenchEditorCommandShortcut('refactor', 'vscode', Mac), 'Ctrl+Shift+R')
    assert.equal(getWorkbenchEditorCommandShortcut('refactor', 'vscode', Linux), 'Ctrl+Alt+Shift+T')
    assert.equal(getWorkbenchEditorCommandShortcut('format-document', 'vscode', Windows), 'Shift+Alt+F')
    assert.equal(getWorkbenchEditorCommandShortcut('format-document', 'vscode', Linux), 'Mod+Alt+L')
    assert.equal(getWorkbenchEditorCommandShortcut('trigger-completion', 'workbench', Mac), 'Mod+I')
    assert.equal(getWorkbenchEditorCommandShortcut('trigger-completion', 'jetbrains', Mac), 'Ctrl+Space')
    assert.equal(getWorkbenchEditorCommandShortcut('expand-selection', 'workbench', Mac), null)
    assert.equal(getWorkbenchEditorCommandShortcut('find-references', 'vim', Linux), 'Shift+F12')
    // 不给方案、不给平台：Workbench 方案，当前平台。
    assert.equal(getWorkbenchEditorCommandShortcut('rename-symbol'), 'Shift+F6')
  })
})

void describe('editor keymap: one key, one meaning', () => {
  void test('every key is written with known names', () => {
    const chordPattern =
      /^(?:(?:Mod|Ctrl|Alt|Shift)\+)*(?:[A-Z]|[`\-=[\]\\;',./]|F\d{1,2}|Arrow(?:Up|Down|Left|Right)|Enter|Escape|Tab|Space|Backspace)$/u
    for (const preset of TablePresets) {
      for (const platform of KeymapTestPlatforms) {
        for (const { chord, command } of listWorkbenchEditorKeymapBindings(preset, platform)) {
          assert.match(chord, chordPattern, `${preset} ${platform} ${command}`)
          const modifiers = chord.split(/\b\+/u).slice(0, -1)
          assert.equal(new Set(modifiers).size, modifiers.length, chord)
          // 主修饰键在 Windows / Linux 上就是 Ctrl：两个不写在一起。
          assert.ok(!(modifiers.includes('Mod') && modifiers.includes('Ctrl') && platform !== Mac), chord)
        }
      }
    }
  })

  void test('no key belongs to two editor commands', () => {
    for (const preset of TablePresets) {
      for (const platform of KeymapTestPlatforms) {
        const commandsByKey = new Map<string, string[]>()
        for (const { chord, command } of listWorkbenchEditorKeymapBindings(preset, platform)) {
          const signature = keymapTestSignature(chord, platform)
          commandsByKey.set(signature, [...(commandsByKey.get(signature) ?? []), command])
        }
        assert.deepEqual(
          [...commandsByKey].filter(([, commands]) => commands.length > 1),
          [],
          `${preset} ${platform}`
        )
      }
    }
  })

  void test('an editor command shares a key with an app-wide shortcut only where that is meant', () => {
    const allowed = new Set(
      WorkbenchEditorKeymapSharedChords.map(({ command, action }) => `${command} / ${action}`)
    )
    const actions = new Set(WORKBENCH_KEYBOARD_SHORTCUT_DEFINITIONS.map(({ action }) => action as string))
    for (const { action, note } of WorkbenchEditorKeymapSharedChords) {
      assert.ok(actions.has(action), action)
      assert.ok(note.length > 0, action)
    }

    const found = new Set<string>()
    for (const preset of TablePresets) {
      for (const platform of KeymapTestPlatforms) {
        const commandByKey = new Map(
          listWorkbenchEditorKeymapBindings(preset, platform).map(({ chord, command }) => [
            keymapTestSignature(chord, platform),
            command,
          ])
        )
        const shortcuts = getWorkbenchKeymapPresetShortcuts(preset, platform)
        for (const [action, shortcut] of Object.entries(shortcuts)) {
          const command = shortcut ? commandByKey.get(keymapTestSignature(shortcut, platform)) : undefined
          if (!command) continue
          const pair = `${command} / ${action}`
          assert.ok(allowed.has(pair), `${preset} ${platform}: ${shortcut} is both ${pair}`)
          found.add(pair)
        }
      }
    }
    // 列着的每一处都确实出现在某个方案里。
    assert.deepEqual([...found].sort(), [...allowed].sort())

    // 各方案里同键的是哪几处。
    const shared = (preset: TablePreset, platform: KeymapTestPlatform): string[] => {
      const shortcuts = getWorkbenchKeymapPresetShortcuts(preset, platform)
      return listWorkbenchEditorKeymapBindings(preset, platform)
        .filter(({ chord }) =>
          Object.values(shortcuts).some(
            (shortcut) =>
              !!shortcut && keymapTestSignature(shortcut, platform) === keymapTestSignature(chord, platform)
          )
        )
        .map(({ chord }) => chord)
    }
    assert.deepEqual(shared('workbench', Mac), ['F8', 'Mod+S', 'Mod+Enter', 'Escape'])
    assert.deepEqual(shared('workbench', Windows), [
      'F8',
      'Alt+ArrowLeft',
      'Alt+ArrowRight',
      'Mod+S',
      'Mod+Enter',
      'Escape',
    ])
    assert.deepEqual(shared('vscode', Mac), ['Mod+S', 'Mod+Enter', 'Escape'])
    assert.deepEqual(shared('vscode', Linux), ['Mod+S', 'Mod+Enter', 'Escape'])
    assert.deepEqual(shared('jetbrains', Mac), ['Mod+S', 'Escape'])
    assert.deepEqual(shared('jetbrains', Linux), ['Mod+S', 'Escape'])
  })

  void test('every command has a key in every preset, or is unbound on purpose', () => {
    const unbound = (preset: TablePreset, platform: KeymapTestPlatform): string[] =>
      WORKBENCH_EDITOR_KEYMAP_COMMANDS.filter(
        (command) => getWorkbenchEditorCommandChords(command, preset, platform).length === 0
      )

    // Workbench：今天就没有键的那几个（见钉住的表），外加新命令「上一个问题」。
    assert.deepEqual(unbound('workbench', Mac), [
      'previous-problem',
      'navigate-back',
      'navigate-forward',
      'expand-selection',
    ])
    for (const platform of [Windows, Linux] as const)
      assert.deepEqual(unbound('workbench', platform), [
        'previous-problem',
        'expand-selection',
        'cursor-syntax-left',
        'cursor-syntax-right',
      ])

    assert.deepEqual(unbound('vscode', Mac), ['open-lint-panel', 'navigate-back', 'navigate-forward'])
    assert.deepEqual(unbound('vscode', Windows), [
      'open-lint-panel',
      'cursor-syntax-left',
      'cursor-syntax-right',
      'select-syntax-left',
      'select-syntax-right',
    ])
    assert.deepEqual(unbound('vscode', Linux), [
      'open-lint-panel',
      'navigate-back',
      'navigate-forward',
      'cursor-syntax-left',
      'cursor-syntax-right',
      'select-syntax-left',
      'select-syntax-right',
    ])

    assert.deepEqual(unbound('jetbrains', Mac), ['navigate-back', 'navigate-forward', 'copy-line-up'])
    for (const platform of [Windows, Linux] as const)
      assert.deepEqual(unbound('jetbrains', platform), [
        'open-lint-panel',
        'navigate-back',
        'navigate-forward',
        'copy-line-up',
        'expand-selection',
        'cursor-syntax-left',
        'cursor-syntax-right',
      ])
  })
})

void describe('editor keymap: keys that belong to the application menu', () => {
  void test('the menu uses these roles', () => {
    // 多了一个 role 就要在 helpers/workbenchMenuAccelerators.ts 里补上它的键。
    assert.deepEqual(listWorkbenchMenuRoles().sort(), [
      'appMenu',
      'editMenu',
      'forceReload',
      'front',
      'minimize',
      'reload',
      'toggleDevTools',
      'togglefullscreen',
      'window',
      'zoom',
    ])
    const macKeys = listWorkbenchMenuKeys(Mac).map(({ signature }) => signature)
    for (const signature of ['Meta+w', 'Meta+o', 'Meta+Shift+n', 'Meta+r', 'Meta+-', 'Meta+=', 'Meta+0', 'Meta+q'])
      assert.ok(macKeys.includes(signature), signature)
    const linuxKeys = listWorkbenchMenuKeys(Linux).map(({ signature }) => signature)
    for (const signature of ['Ctrl+w', 'Ctrl+Shift+n', 'Ctrl+Shift+r', 'Ctrl+Shift+i', 'Ctrl+Shift+z', 'F11'])
      assert.ok(linuxKeys.includes(signature), signature)
    assert.ok(listWorkbenchMenuKeys(Windows).some(({ signature }) => signature === 'Ctrl+y'))
    assert.ok(!linuxKeys.includes('Ctrl+y'))
  })

  void test('no preset puts a command on a menu key', () => {
    /**
     * 与菜单同键的只有这些：
     *  - 撤销、重做：与菜单那一项是同一件事，编辑器自己做；
     *  - Workbench 一直以来就占着的三个键（改键位方案之前就是这样，各方案照旧）。
     */
    const allowed = (item: string, name: string, platform: KeymapTestPlatform): boolean =>
      (item === 'undo' && name === 'undo')
      || (item === 'redo' && name === 'redo')
      || (platform !== Mac && item === 'toggleDevTools' && name === 'toggle-problems')
      || (platform !== Mac && item === 'minimize' && name === 'toggle-tab-focus-mode')
      || (platform !== Mac && item === 'togglefullscreen' && name === 'debug-step-into')

    const onMenuKeys: string[] = []
    for (const preset of TablePresets) {
      for (const platform of KeymapTestPlatforms) {
        const menu = new Map(listWorkbenchMenuKeys(platform).map(({ signature, item }) => [signature, item]))
        const bindings: Array<readonly [name: string, chord: string]> = [
          ...listWorkbenchEditorKeymapBindings(preset, platform).map(
            ({ command, chord }) => [command, chord] as const
          ),
          ...Object.entries(getWorkbenchKeymapPresetShortcuts(preset, platform)).filter(
            ([, shortcut]) => !!shortcut
          ),
        ]
        for (const [name, chord] of bindings) {
          const item = menu.get(keymapTestSignature(chord, platform))
          if (!item) continue
          assert.ok(allowed(item, name, platform), `${preset} ${platform}: ${name} on ${chord} (menu: ${item})`)
          onMenuKeys.push(`${preset} ${platform} ${name} ${chord}`)
        }
      }
    }
    // Workbench 占着的那三个键只在这些方案、这些平台上出现。
    assert.deepEqual(
      onMenuKeys.filter((entry) => !/ (?:undo|redo) /u.test(entry)),
      [
        'workbench Win32 toggle-tab-focus-mode Ctrl+M',
        'workbench Win32 debug-step-into F11',
        'workbench Win32 toggle-problems Mod+Shift+I',
        'workbench Linux x86_64 toggle-tab-focus-mode Ctrl+M',
        'workbench Linux x86_64 debug-step-into F11',
        'workbench Linux x86_64 toggle-problems Mod+Shift+I',
        'vscode Win32 toggle-tab-focus-mode Ctrl+M',
        'vscode Win32 debug-step-into F11',
        'vscode Linux x86_64 toggle-tab-focus-mode Ctrl+M',
        'vscode Linux x86_64 debug-step-into F11',
        'jetbrains Win32 toggle-tab-focus-mode Ctrl+M',
        'jetbrains Linux x86_64 toggle-tab-focus-mode Ctrl+M',
      ]
    )
  })

  void test('the IDE keys that the menu owns are not in the tables', () => {
    const chords = (preset: TablePreset, platform: KeymapTestPlatform): Set<string> =>
      new Set([
        ...listWorkbenchEditorKeymapBindings(preset, platform).map(({ chord }) =>
          keymapTestSignature(chord, platform)
        ),
        ...Object.values(getWorkbenchKeymapPresetShortcuts(preset, platform))
          .filter(Boolean)
          .map((shortcut) => keymapTestSignature(shortcut, platform)),
      ])
    // VS Code：重构 Ctrl+Shift+R（强制重新加载）、Linux 上格式化 Ctrl+Shift+I（开发者工具）。
    assert.ok(!chords('vscode', Windows).has('Ctrl+Shift+r'))
    assert.ok(!chords('vscode', Linux).has('Ctrl+Shift+i'))
    assert.ok(chords('vscode', Mac).has('Ctrl+Shift+r'))
    // JetBrains：转到文件 Ctrl+Shift+N（新建项目）、替换 ⌘R / Ctrl+R 与 macOS 上的重新运行 ⌘R（重新加载）、
    // 扩展选区 Ctrl+W（关闭编辑器）、折叠 ⌘- / Ctrl+- 与展开 ⌘+ / Ctrl+=（编辑区缩放）、Windows 上删除行 Ctrl+Y（重做）。
    for (const platform of [Windows, Linux] as const) {
      for (const signature of ['Ctrl+Shift+n', 'Ctrl+r', 'Ctrl+w', 'Ctrl+-', 'Ctrl+='])
        assert.ok(!chords('jetbrains', platform).has(signature), `${platform} ${signature}`)
    }
    for (const signature of ['Meta+r', 'Meta+-', 'Meta+=', 'Meta+Shift+-', 'Meta+Shift+='])
      assert.ok(!chords('jetbrains', Mac).has(signature), signature)
    assert.ok(!chords('jetbrains', Windows).has('Ctrl+y'))
    assert.ok(chords('jetbrains', Linux).has('Ctrl+y'))
  })
})

void describe('editor keymap: keys that CodeMirror keeps', () => {
  /** CodeMirror 的标准键在这个平台上的样子（带 Shift 的那一半也算）。 */
  function standardKeys(platform: KeymapTestPlatform): Set<string> {
    const field = platform === Mac ? 'mac' : platform === Windows ? 'win' : 'linux'
    return new Set(
      standardKeymap.flatMap((binding) => {
        const name = binding[field] || binding.key
        if (!name) return []
        const chord = name.replaceAll('-', '+').replace(/\bCmd\b/u, 'Mod')
        return binding.shift ? [chord, `Shift+${chord}`] : [chord]
      }).map((chord) => keymapTestSignature(chord, platform))
    )
  }

  void test('the presets take these standard keys, and no others', () => {
    const taken = (preset: TablePreset, platform: KeymapTestPlatform): string[] => {
      const standard = standardKeys(platform)
      return listWorkbenchEditorKeymapBindings(preset, platform)
        .filter(({ chord }) => standard.has(keymapTestSignature(chord, platform)))
        .map(({ command, chord }) => `${command} ${chord}`)
    }
    // macOS 上的 ⌃T、⌃⌥H 本来是 Emacs 式的换位、向前删一个词：Workbench 一直拿它们做重构、调用层次。
    assert.deepEqual(taken('workbench', Mac), ['call-hierarchy Ctrl+Alt+H', 'refactor Ctrl+T'])
    assert.deepEqual(taken('workbench', Windows), [])
    assert.deepEqual(taken('workbench', Linux), [])
    // VS Code 的重构、调用层次是别的键，这两个标准键就回来了。
    for (const platform of KeymapTestPlatforms) assert.deepEqual(taken('vscode', platform), [])
    // JetBrains：⌘⌫ 是删除行（标准键是删到行首），⇧↩ 是在下面开一个新行（标准键是换行）。
    assert.deepEqual(taken('jetbrains', Mac), [
      'call-hierarchy Ctrl+Alt+H',
      'refactor Ctrl+T',
      'delete-line Mod+Backspace',
      'insert-blank-line Shift+Enter',
    ])
    assert.deepEqual(taken('jetbrains', Windows), ['insert-blank-line Shift+Enter'])
    assert.deepEqual(taken('jetbrains', Linux), ['insert-blank-line Shift+Enter'])
  })
})

void describe('editor keymap: which key was pressed', () => {
  const workbench = (event: ReturnType<typeof key>, platform: string) =>
    resolveWorkbenchEditorKeymapCommand(event, platform)

  void test('modifiers must match exactly', () => {
    assert.equal(workbench(key('KeyD', 'd', { meta: true }), Mac), 'select-next-occurrence')
    assert.equal(workbench(key('KeyD', 'D', { meta: true, shift: true }), Mac), null)
    assert.equal(workbench(key('KeyD', 'd', { meta: true, ctrl: true }), Mac), null)
    assert.equal(workbench(key('KeyD', 'd', { ctrl: true }), Mac), null)
    assert.equal(workbench(key('KeyD', 'd', { ctrl: true }), Linux), 'select-next-occurrence')
    assert.equal(workbench(key('KeyD', 'd', { meta: true }), Linux), null)
    assert.equal(workbench(key('KeyD', 'd'), Mac), null)
    assert.equal(workbench(key('Tab', 'Tab'), Mac), 'indent-more')
    assert.equal(workbench(key('Tab', 'Tab', { shift: true }), Mac), 'indent-less')
    assert.equal(workbench(key('Tab', 'Tab', { ctrl: true }), Mac), null)
    assert.equal(workbench(key('Escape', 'Escape'), Linux), 'cancel')
    assert.equal(workbench(key('Escape', 'Escape', { shift: true }), Linux), null)
    assert.equal(workbench(key('Space', ' ', { ctrl: true }), Mac), 'trigger-completion')
    // 光按修饰键不是哪个命令。
    assert.equal(workbench(key('MetaLeft', 'Meta', { meta: true }), Mac), null)
    assert.equal(workbench(key('ShiftLeft', 'Shift', { shift: true }), Linux), null)
  })

  void test('Shift changes the character; the key is written without it', () => {
    // ⇧⌘L：有的系统给 `L`，macOS 上按着 ⌘ 时给 `l`。
    assert.equal(workbench(key('KeyL', 'L', { meta: true, shift: true }), Mac), 'select-all-occurrences')
    assert.equal(workbench(key('KeyL', 'l', { meta: true, shift: true }), Mac), 'select-all-occurrences')
    // Ctrl+Shift+[ 打出来的是 {。
    assert.equal(workbench(key('BracketLeft', '{', { ctrl: true, shift: true }), Linux), 'fold')
    assert.equal(workbench(key('BracketLeft', '{', { ctrl: true, shift: true, keyCode: 219 }), Linux), 'fold')
    assert.equal(workbench(key('Backslash', '|', { meta: true, shift: true }), Mac), 'jump-to-bracket')
  })

  void test('a letter is the key that types it, whatever the layout', () => {
    // Dvorak：标着 D 的键在 QWERTY 的 H 位上。
    assert.equal(workbench(key('KeyH', 'd', { ctrl: true, keyCode: 68 }), Linux), 'select-next-occurrence')
    // QWERTY 上 D 的那个位置在 Dvorak 上打的是 e：不是「选中下一处」。
    assert.equal(workbench(key('KeyD', 'e', { ctrl: true, keyCode: 69 }), Linux), null)
    // 德语键盘：Alt+Z 是标着 Z 的那个键（在 QWERTY 的 Y 位上）。
    assert.equal(workbench(key('KeyY', 'z', { alt: true, keyCode: 90 }), Linux), 'toggle-word-wrap')
    assert.equal(workbench(key('KeyZ', 'y', { alt: true, keyCode: 89 }), Linux), null)
    // AZERTY、德语键盘上 / 要按着 Shift 才打得出来：Ctrl+/ 仍是行注释。
    assert.equal(workbench(key('Digit7', '/', { ctrl: true, shift: true, keyCode: 55 }), Linux), 'toggle-line-comment')
  })

  void test('a layout without Latin letters goes by the position of the key', () => {
    // 俄语布局：D 位上打出来的是 в。
    assert.equal(workbench(key('KeyD', 'в', { meta: true, keyCode: 68 }), Mac), 'select-next-occurrence')
    assert.equal(workbench(key('KeyD', 'в', { ctrl: true }), Windows), 'select-next-occurrence')
    assert.equal(workbench(key('KeyL', 'Д', { ctrl: true, shift: true }), Linux), 'select-all-occurrences')
    // 不带 Ctrl / ⌘ / Alt 的就是在打字。
    assert.equal(workbench(key('KeyD', 'в'), Mac), null)
  })

  void test('Option on macOS types another character: the key itself decides', () => {
    // ⌥Z 是 Ω，⇧⌥A 是 Å，⌥⌘L 是 ¬。
    assert.equal(workbench(key('KeyZ', 'Ω', { alt: true }), Mac), 'toggle-word-wrap')
    assert.equal(workbench(key('KeyA', 'Å', { alt: true, shift: true }), Mac), 'toggle-block-comment')
    assert.equal(workbench(key('KeyL', '¬', { alt: true, meta: true }), Mac), 'format-document')
    // ⌥U 是死键。
    assert.equal(
      resolveWorkbenchEditorKeymapCommand(key('KeyF', 'Dead', { alt: true, shift: true }), Mac, 'vscode'),
      'format-document'
    )
    // 德语键盘上 ⌥L 打出来的是 @（ASCII），⌥⌘L 照样是格式化。
    assert.equal(workbench(key('KeyL', '@', { alt: true, meta: true, keyCode: 76 }), Mac), 'format-document')
    // 键码跟着布局上的字母走：Dvorak 上标着 L 的键在 QWERTY 的 P 位上。
    assert.equal(workbench(key('KeyP', '¬', { alt: true, meta: true, keyCode: 76 }), Mac), 'format-document')
  })

  void test('Ctrl+Alt on Windows and Linux: the key itself decides; AltGr typing is left alone', () => {
    assert.equal(workbench(key('KeyL', 'l', { ctrl: true, alt: true }), Windows), 'format-document')
    assert.equal(workbench(key('KeyL', 'l', { ctrl: true, alt: true }), Linux), 'format-document')
    assert.equal(workbench(key('BracketLeft', '[', { ctrl: true, alt: true }), Windows), 'fold-all')
    assert.equal(workbench(key('KeyT', 'T', { ctrl: true, alt: true, shift: true }), Windows), 'refactor')
    // Windows 上 AltGr 到的时候就是 Ctrl+Alt：波兰语的 ł（AltGr+L）、德语键盘上的 [（AltGr+8）是在打字。
    assert.equal(workbench(key('KeyL', 'ł', { ctrl: true, alt: true, keyCode: 76 }), Windows), null)
    assert.equal(workbench(key('Digit8', '[', { ctrl: true, alt: true, keyCode: 56 }), Windows), null)
    assert.equal(workbench(key('KeyQ', '@', { ctrl: true, alt: true, keyCode: 81 }), Windows), null)
    // Linux 上 AltGr 不是 Ctrl+Alt，按着这两个键打出来别的字符照样按键本身认。
    assert.equal(workbench(key('KeyT', 'þ', { ctrl: true, alt: true, shift: true }), Linux), 'refactor')
  })
})
