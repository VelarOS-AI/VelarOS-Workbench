/**
 * 界面上的快捷键提示跟着键位方案走：命令面板、编辑器的右键菜单、设置里提到的键，都是所选方案在这个平台上
 * 的那一组。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve as resolvePath } from 'node:path'

import { describe, test } from 'bun:test'

import { translateWorkbenchAppMessage } from '../src/renderer/src/i18n/useStandaloneWorkbenchLocalization'
import {
  formatWorkbenchEditorCommandHint,
  getWorkbenchEditorCommandChords,
  WORKBENCH_EDITOR_KEYMAP_COMMANDS,
  type WorkbenchEditorKeymapCommandId,
} from '../src/renderer/src/models/editor/workbenchEditorKeymap'
import {
  buildWorkbenchPaletteCommands,
  WORKBENCH_PALETTE_COMMANDS,
  type WorkbenchPaletteCommandId,
} from '../src/renderer/src/models/layout/workbenchCommandPalette'
import {
  getWorkbenchKeymapPresetShortcuts,
  resolveWorkbenchKeyboardShortcutMap,
} from '../src/renderer/src/models/layout/workbenchKeyboardShortcuts'
import {
  WORKBENCH_KEYMAP_PRESET_IDS,
  type WorkbenchKeymapPresetId,
} from '../src/renderer/src/models/layout/workbenchKeymapPresets'

import { KeymapTestPlatforms } from './helpers/workbenchKeymapChords'

const Mac = 'MacIntel'
const Windows = 'Win32'
const Linux = 'Linux x86_64'

function readSource(path: string): string {
  return readFileSync(resolvePath(process.cwd(), path), 'utf8')
}

/** 这个方案、这个平台上命令面板里各条命令右侧的提示（用方案的默认键，没有用户改过的）。 */
function paletteHints(
  preset: WorkbenchKeymapPresetId,
  platform: string
): Record<WorkbenchPaletteCommandId, Nullable<string>> {
  const commands = buildWorkbenchPaletteCommands({
    isAvailable: () => true,
    keymap: getWorkbenchKeymapPresetShortcuts(preset, platform),
    preset,
    platform,
    translate: (key) => translateWorkbenchAppMessage('en-US', key),
    translateAlias: (key) => translateWorkbenchAppMessage('en-US', key),
  })
  return Object.fromEntries(commands.map((command) => [command.id, command.shortcut])) as Record<
    WorkbenchPaletteCommandId,
    Nullable<string>
  >
}

void describe('editor command hints', () => {
  void test('show the first key of the command in the chosen preset, in the notation of the platform', () => {
    const hint = formatWorkbenchEditorCommandHint
    // Workbench：不给方案就是它。
    assert.equal(hint('format-document', undefined, Mac), '⌥⌘L')
    assert.equal(hint('format-document', 'workbench', Windows), 'Ctrl+Alt+L')
    assert.equal(hint('rename-symbol', 'workbench', Mac), '⇧F6')
    assert.equal(hint('go-to-definition', 'workbench', Linux), 'F12')
    assert.equal(hint('quick-fix', 'workbench', Mac), '⌥↩')
    assert.equal(hint('refactor', 'workbench', Mac), '⌃T')
    assert.equal(hint('refactor', 'workbench', Windows), 'Ctrl+Alt+Shift+T')
    assert.equal(hint('move-line-up', 'workbench', Mac), '⌥↑')
    assert.equal(hint('move-line-up', 'workbench', Windows), 'Alt+↑')

    // VS Code。
    assert.equal(hint('format-document', 'vscode', Mac), '⌥⇧F')
    assert.equal(hint('format-document', 'vscode', Windows), 'Alt+Shift+F')
    assert.equal(hint('format-document', 'vscode', Linux), 'Ctrl+Alt+L')
    assert.equal(hint('rename-symbol', 'vscode', Mac), 'F2')
    assert.equal(hint('quick-fix', 'vscode', Mac), '⌘.')
    assert.equal(hint('quick-fix', 'vscode', Linux), 'Ctrl+.')
    assert.equal(hint('call-hierarchy', 'vscode', Mac), '⌥⇧H')
    assert.equal(hint('refactor', 'vscode', Mac), '⌃⇧R')
    assert.equal(hint('trigger-completion', 'vscode', Mac), '⌃Space')
    assert.equal(hint('select-line', 'vscode', Windows), 'Ctrl+L')

    // JetBrains。
    assert.equal(hint('go-to-definition', 'jetbrains', Mac), '⌘B')
    assert.equal(hint('go-to-definition', 'jetbrains', Windows), 'Ctrl+B')
    assert.equal(hint('find-references', 'jetbrains', Mac), '⌥F7')
    assert.equal(hint('quick-fix', 'jetbrains', Linux), 'Alt+Enter')
    assert.equal(hint('organize-imports', 'jetbrains', Mac), '⌃⌥O')
    assert.equal(hint('go-to-line', 'jetbrains', Mac), '⌘L')
    assert.equal(hint('go-to-line', 'jetbrains', Windows), 'Ctrl+G')
    assert.equal(hint('copy-line-down', 'jetbrains', Mac), '⌘D')
    assert.equal(hint('delete-line', 'jetbrains', Mac), '⌘⌫')
    assert.equal(hint('delete-line', 'jetbrains', Linux), 'Ctrl+Y')
    assert.equal(hint('move-line-down', 'jetbrains', Windows), 'Alt+Shift+↓')

    // Vim 方案的键位与 Workbench 相同。
    for (const platform of KeymapTestPlatforms)
      for (const command of WORKBENCH_EDITOR_KEYMAP_COMMANDS)
        assert.equal(hint(command, 'vim', platform), hint(command, 'workbench', platform))
  })

  void test('a command without a key in the preset has no hint', () => {
    assert.equal(formatWorkbenchEditorCommandHint('expand-selection', 'workbench', Mac), '')
    assert.equal(formatWorkbenchEditorCommandHint('previous-problem', 'workbench', Windows), '')
    assert.equal(formatWorkbenchEditorCommandHint('copy-line-up', 'jetbrains', Mac), '')
    assert.equal(formatWorkbenchEditorCommandHint('open-lint-panel', 'vscode', Linux), '')
    // 有没有提示与表里有没有键是一回事。
    for (const preset of WORKBENCH_KEYMAP_PRESET_IDS)
      for (const platform of KeymapTestPlatforms)
        for (const command of WORKBENCH_EDITOR_KEYMAP_COMMANDS)
          assert.equal(
            formatWorkbenchEditorCommandHint(command, preset, platform) !== '',
            getWorkbenchEditorCommandChords(command, preset, platform).length > 0,
            `${preset} ${platform} ${command}`
          )
  })

  void test('the word wrap hint in settings always has a key to name', () => {
    for (const preset of WORKBENCH_KEYMAP_PRESET_IDS) {
      assert.equal(formatWorkbenchEditorCommandHint('toggle-word-wrap', preset, Mac), '⌥Z')
      assert.equal(formatWorkbenchEditorCommandHint('toggle-word-wrap', preset, Windows), 'Alt+Z')
      assert.equal(formatWorkbenchEditorCommandHint('toggle-word-wrap', preset, Linux), 'Alt+Z')
    }
  })
})

void describe('command palette hints', () => {
  /** 面板里右侧提示的是编辑器命令的键的那几条，各是哪个命令。 */
  const EditorCommands: Partial<Record<WorkbenchPaletteCommandId, WorkbenchEditorKeymapCommandId>> = {
    'call-hierarchy': 'call-hierarchy',
    'find-references': 'find-references',
    'format-document': 'format-document',
    'go-to-line': 'go-to-line',
    'organize-imports': 'organize-imports',
    'quick-fix': 'quick-fix',
    refactor: 'refactor',
    'toggle-word-wrap': 'toggle-word-wrap',
  }

  void test('editor commands take their hint from the editor key table, menu keys stay fixed', () => {
    const editor: Partial<Record<WorkbenchPaletteCommandId, string>> = {}
    const fixed: Partial<Record<WorkbenchPaletteCommandId, string>> = {}
    for (const definition of WORKBENCH_PALETTE_COMMANDS) {
      if (!definition.shortcut) continue
      if ('editor' in definition.shortcut) editor[definition.id] = definition.shortcut.editor
      if ('fixed' in definition.shortcut) fixed[definition.id] = definition.shortcut.fixed
    }
    assert.deepEqual(editor, EditorCommands)
    // 写死的只剩应用菜单的键（关闭编辑器、编辑器缩放）：菜单不随键位方案变。
    assert.deepEqual(fixed, {
      'close-editor': 'Mod+W',
      'zoom-in': 'Mod++',
      'zoom-out': 'Mod+-',
      'zoom-reset': 'Mod+0',
    })
  })

  void test('follow the chosen preset on every platform', () => {
    for (const preset of WORKBENCH_KEYMAP_PRESET_IDS)
      for (const platform of KeymapTestPlatforms) {
        const hints = paletteHints(preset, platform)
        for (const [id, command] of Object.entries(EditorCommands))
          assert.equal(
            hints[id as WorkbenchPaletteCommandId],
            formatWorkbenchEditorCommandHint(command, preset, platform) || null,
            `${preset} ${platform} ${id}`
          )
      }

    const vscodeMac = paletteHints('vscode', Mac)
    assert.equal(vscodeMac['format-document'], '⌥⇧F')
    assert.equal(vscodeMac['quick-fix'], '⌘.')
    assert.equal(vscodeMac['call-hierarchy'], '⌥⇧H')
    assert.equal(vscodeMac['refactor'], '⌃⇧R')
    assert.equal(vscodeMac['go-to-line'], '⌃G')
    // 全局快捷键的提示用方案的默认键。
    assert.equal(vscodeMac['toggle-problems'], '⇧⌘M')
    assert.equal(vscodeMac['toggle-git'], '⌃⇧G')
    assert.equal(vscodeMac['toggle-chat'], '⌃⌘I')
    assert.equal(vscodeMac['save-all'], '⌥⌘S')
    assert.equal(vscodeMac['debug-continue'], 'F5')

    const vscodeLinux = paletteHints('vscode', Linux)
    assert.equal(vscodeLinux['format-document'], 'Ctrl+Alt+L')
    assert.equal(vscodeLinux['navigate-back'], 'Ctrl+Alt+-')
    assert.equal(vscodeLinux['toggle-chat'], 'Ctrl+Alt+I')

    const jetbrainsMac = paletteHints('jetbrains', Mac)
    assert.equal(jetbrainsMac['go-to-file'], '⇧⌘O')
    assert.equal(jetbrainsMac['go-to-symbol'], '⌘F12')
    assert.equal(jetbrainsMac['go-to-line'], '⌘L')
    assert.equal(jetbrainsMac['find-references'], '⌥F7')
    assert.equal(jetbrainsMac['organize-imports'], '⌃⌥O')
    assert.equal(jetbrainsMac['navigate-back'], '⌘[')
    assert.equal(jetbrainsMac['toggle-problems'], '⌘6')
    assert.equal(jetbrainsMac['debug-step-over'], 'F8')

    const jetbrainsWindows = paletteHints('jetbrains', Windows)
    assert.equal(jetbrainsWindows['go-to-file'], 'Ctrl+P')
    assert.equal(jetbrainsWindows['navigate-back'], 'Ctrl+Alt+←')
    assert.equal(jetbrainsWindows['run-last-command'], 'Ctrl+F5')
    assert.equal(jetbrainsWindows['toggle-git'], 'Alt+9')
    assert.equal(jetbrainsWindows['debug-stop'], 'Ctrl+F2')

    // 应用菜单的键不随方案变。
    for (const preset of WORKBENCH_KEYMAP_PRESET_IDS) {
      assert.equal(paletteHints(preset, Mac)['close-editor'], '⌘W')
      assert.equal(paletteHints(preset, Linux)['zoom-reset'], 'Ctrl+0')
    }
  })

  void test('an action without a key shows no hint, and a key the user recorded shows instead', () => {
    // JetBrains 方案里「切换 AI 聊天」没有键。
    for (const platform of KeymapTestPlatforms)
      assert.equal(paletteHints('jetbrains', platform)['toggle-chat'], null)

    const rebound = buildWorkbenchPaletteCommands({
      isAvailable: () => true,
      keymap: resolveWorkbenchKeyboardShortcutMap(
        { preset: 'jetbrains', overrides: { 'toggle-actions': 'Mod+Shift+J' } },
        Mac
      ),
      preset: 'jetbrains',
      platform: Mac,
      translate: (key) => key,
      translateAlias: (key) => key,
    })
    assert.equal(rebound.find((command) => command.id === 'toggle-chat')?.shortcut, '⇧⌘J')
    // 编辑器命令的提示不受全局快捷键的改动影响。
    assert.equal(rebound.find((command) => command.id === 'go-to-line')?.shortcut, '⌘L')
  })
})

void describe('where the hints are wired', () => {
  void test('the editor context menu shows the key of each editor command under the chosen preset', () => {
    const editor = readSource('src/renderer/src/components/editor/CodeMirrorEditor.tsx')
    assert.match(
      editor,
      /const hint = formatWorkbenchEditorCommandHint\(command, keymapPreset\)[\s\S]*?<span className=\{styles\.workbenchContextMenuLabel\}>\{label\}<\/span>\s*\{!!hint && <span className=\{styles\.workbenchContextMenuShortcut\}>\{hint\}<\/span>\}/u
    )
    const menu = editor.slice(editor.indexOf('className={styles.editorContextMenu}'))
    assert.deepEqual(
      [...menu.matchAll(/commandMenuLabel\('([a-z-]+)', t\('workbench\.(\w+)'\)\)/gu)].map(
        (match) => `${match[1]} ${match[2]}`
      ),
      [
        'rename-symbol editorContextRenameSymbol',
        'go-to-definition editorContextGoToDefinition',
        'find-references editorContextFindReferences',
        'call-hierarchy editorContextCallHierarchy',
        'quick-fix editorContextQuickFix',
        'refactor editorContextRefactor',
        'format-document editorContextFormatDocument',
        'organize-imports editorContextOrganizeImports',
      ]
    )
    // 提示让菜单变宽了：画出来以后量一下，伸到窗口右沿、下沿外面就收回来。
    assert.match(editor, /rect\.right - \(window\.innerWidth - 8\)/u)
    assert.match(editor, /rect\.bottom - \(window\.innerHeight - 8\)/u)
  })

  void test('the palette and the settings dialog are given the chosen preset', () => {
    const presentation = readSource('src/renderer/src/app/StandaloneWorkbenchPagePresentation.tsx')
    const quickOpen = readSource('src/renderer/src/components/QuickOpen.tsx')
    const settings = readSource('src/renderer/src/components/settings/WorkbenchSettingsDialog.tsx')

    assert.match(presentation, /<LazyQuickOpen[\s\S]*?keymapPreset=\{workbenchKeymap\.preset\}/u)
    assert.match(quickOpen, /keymap,\s*preset: keymapPreset,/u)
    assert.match(
      presentation,
      /<LazyWorkbenchSettingsDialog[\s\S]*?keymapPreset=\{workbenchKeymap\.preset\}\s*presetShortcuts=\{workbenchKeymap\.presetShortcuts\}/u
    )
    assert.match(presentation, /onKeymapPresetChange=\{workbenchKeymap\.setPreset\}/u)
    assert.match(
      settings,
      /shortcut: formatWorkbenchEditorCommandHint\('toggle-word-wrap', keymapPreset\)/u
    )
  })

  void test('no component spells out an editor key by hand', () => {
    for (const path of [
      'src/renderer/src/components/settings/WorkbenchSettingsDialog.tsx',
      'src/renderer/src/components/settings/WorkbenchKeymapSettings.tsx',
      'src/renderer/src/components/QuickOpen.tsx',
      'src/renderer/src/components/editor/EditorPanel.tsx',
    ]) {
      const code = readSource(path).replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gmu, '')
      assert.doesNotMatch(code, /[⌘⌥⌃⇧]|'(?:Ctrl|Alt|Shift|Cmd|Mod)\+/u, path)
    }
  })
})
