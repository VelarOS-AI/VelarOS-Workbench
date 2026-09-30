/**
 * 设置里「快捷键」「编辑器按键」两段：选键位方案，全局快捷键显示所选方案的默认键、可以另录，编辑器命令的键
 * 只读地列出来。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve as resolvePath } from 'node:path'

import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, test } from 'bun:test'

import type { WorkbenchKeyboardShortcutOverrides } from '../src/renderer/src/models/layout/workbenchKeyboardShortcuts'
import type { WorkbenchKeymapPresetId } from '../src/renderer/src/models/layout/workbenchKeymapPresets'
import type { AppLocale } from '../src/shared/contracts'

import { shareHostReactWithLinkedUi } from './helpers/linkedUiReact'

shareHostReactWithLinkedUi()

// 会加载共享包的模块都放在上面那一步之后再加载（静态 import 在任何代码执行之前就解析完了）。
const { WorkbenchLocalizationProvider } = await import('../src/renderer/src/i18n')
const { translateWorkbenchAppMessage } = await import(
  '../src/renderer/src/i18n/useStandaloneWorkbenchLocalization'
)
const { WORKBENCH_EDITOR_KEYMAP_COMMANDS } = await import(
  '../src/renderer/src/models/editor/workbenchEditorKeymap'
)
const {
  buildWorkbenchKeymapConflicts,
  getWorkbenchKeymapPresetShortcuts,
  resolveWorkbenchKeyboardShortcutMap,
  WORKBENCH_KEYBOARD_SHORTCUT_DEFINITIONS,
} = await import('../src/renderer/src/models/layout/workbenchKeyboardShortcuts')
const { WorkbenchEditorKeysDescriptionKeys, WorkbenchEditorKeysSettings, WorkbenchKeymapSettings } =
  await import('../src/renderer/src/components/settings/WorkbenchKeymapSettings')

const Mac = 'MacIntel'
const Windows = 'Win32'
const Linux = 'Linux x86_64'

function readSource(path: string): string {
  return readFileSync(resolvePath(process.cwd(), path), 'utf8')
}

function localized(locale: AppLocale, children: ReturnType<typeof createElement>): string {
  return renderToStaticMarkup(
    createElement(WorkbenchLocalizationProvider, {
      value: {
        locale,
        setLocale: async () => undefined,
        t: (key, params) => translateWorkbenchAppMessage(locale, key, params),
      },
      children,
    })
  )
}

function renderShortcuts(options: {
  preset: WorkbenchKeymapPresetId
  platform: string
  overrides?: WorkbenchKeyboardShortcutOverrides
  locale?: AppLocale
}): string {
  const keymap = resolveWorkbenchKeyboardShortcutMap(
    { preset: options.preset, overrides: options.overrides ?? {} },
    options.platform
  )
  return localized(
    options.locale ?? 'en-US',
    createElement(WorkbenchKeymapSettings, {
      capturingAction: null,
      conflicts: buildWorkbenchKeymapConflicts(keymap),
      keymap,
      preset: options.preset,
      presetShortcuts: getWorkbenchKeymapPresetShortcuts(options.preset, options.platform),
      platform: options.platform,
      onCapturingActionChange: () => undefined,
      onPresetChange: () => undefined,
      onResetShortcut: () => undefined,
      onSetShortcut: () => undefined,
    })
  )
}

function renderEditorKeys(
  preset: WorkbenchKeymapPresetId,
  platform: string,
  locale: AppLocale = 'en-US'
): string {
  return localized(locale, createElement(WorkbenchEditorKeysSettings, { preset, platform }))
}

interface RenderedRow {
  /** 这一行是哪个动作 / 哪个编辑器命令。 */
  id: string
  title: string
  /** 名字下面的说明。 */
  note: string
  /** 右边的文字：按键，或「未设置」。 */
  keys: string[]
  html: string
}

/**
 * 一段里的各行。测试里样式模块是空的（没有类名），行靠 `data-shortcut-action` / `data-editor-command` 认；
 * 行里第一个 div 是名字与说明，第二个是右边的控件。
 */
function rows(html: string): RenderedRow[] {
  return html
    .split(/(?=<div data-(?:shortcut-action|editor-command)=")/u)
    .slice(1)
    .map((row) => {
      const metaEnd = row.indexOf('</div>')
      const texts = (part: string): string[] =>
        [...part.matchAll(/>([^<>]+)</gu)].map((match) => decode(match[1]!))
      const meta = texts(row.slice(0, metaEnd))
      return {
        id: /^<div data-(?:shortcut-action|editor-command)="([^"]+)"/u.exec(row)?.[1] ?? '',
        title: meta[0] ?? '',
        note: meta.slice(1).join(' '),
        keys: texts(row.slice(metaEnd)),
        html: row,
      }
    })
}

function decode(text: string): string {
  return text.replaceAll('&amp;', '&').replaceAll('&#x27;', "'").replaceAll('&quot;', '"')
}

function row(html: string, title: string): RenderedRow {
  const found = rows(html).find((candidate) => candidate.title === title)
  assert.ok(found, `no row titled "${title}"`)
  return found
}

void describe('keymap preset selector', () => {
  void test('shows the chosen preset with its one-line description', () => {
    const expectations: Array<[WorkbenchKeymapPresetId, string, string]> = [
      ['workbench', 'Workbench', "Workbench's own keys: a mix of VS Code and JetBrains."],
      ['vscode', 'VS Code', 'The default keys of VS Code.'],
      ['jetbrains', 'JetBrains', 'The default keys of IntelliJ IDEA and WebStorm.'],
      ['vim', 'Vim', 'Workbench keys, plus Vim modal editing in the file editor.'],
    ]
    for (const [preset, label, description] of expectations) {
      const html = renderShortcuts({ preset, platform: Mac })
      const selector = html.slice(0, html.indexOf('<div data-shortcut-action='))
      assert.match(selector, /Keymap preset/u)
      assert.ok(decode(selector).includes(description), `${preset} description`)
      // 选择框上是方案的名字；用的是设置里别的下拉同一个控件（小号）。
      assert.match(
        selector,
        new RegExp(
          `<button[^>]*data-slot="select-trigger"[^>]*velar-select-size-sm[^>]*aria-label="${label}"`,
          'u'
        )
      )
    }
    assert.match(renderShortcuts({ preset: 'vscode', platform: Mac, locale: 'zh-CN' }), /键位方案/u)
    assert.match(
      renderShortcuts({ preset: 'vscode', platform: Mac, locale: 'zh-CN' }),
      /照 VS Code 的默认键位。/u
    )
  })

  void test('every preset has a description in both languages', () => {
    const source = readSource('src/renderer/src/components/settings/WorkbenchKeymapSettings.tsx')
    // 下拉里每一项都带着名字和一句话说明。
    assert.match(
      source,
      /options=\{WORKBENCH_KEYMAP_PRESET_IDS\.map\(\(id\) => \(\{\s*value: id,\s*label: PresetLabels\[id\],\s*description: t\(PresetDescriptionKeys\[id\]\),\s*\}\)\)\}/u
    )
    for (const name of ['Workbench', 'Vscode', 'Jetbrains', 'Vim'])
      for (const locale of ['zh-CN', 'en-US'] as const) {
        const key = `workbench.settingsKeymapPreset${name}Description`
        assert.notEqual(translateWorkbenchAppMessage(locale, key), key, `${locale} ${key}`)
      }
  })
})

void describe('app-wide shortcut list', () => {
  void test('lists every action with the default key of the chosen preset', () => {
    const workbench = renderShortcuts({ preset: 'workbench', platform: Mac })
    assert.deepEqual(
      rows(workbench).map((item) => item.id),
      WORKBENCH_KEYBOARD_SHORTCUT_DEFINITIONS.map((definition) => definition.action)
    )
    assert.deepEqual(row(workbench, 'Quick open').keys, ['Cmd+P'])
    assert.deepEqual(row(workbench, 'Command palette').keys, ['Cmd+Shift+P'])
    assert.deepEqual(row(workbench, 'Toggle Problems').keys, ['Cmd+Shift+I'])
    assert.deepEqual(row(workbench, 'Go back').keys, ['Ctrl+-'])

    const vscode = renderShortcuts({ preset: 'vscode', platform: Mac })
    assert.deepEqual(row(vscode, 'Toggle Problems').keys, ['Cmd+Shift+M'])
    assert.deepEqual(row(vscode, 'Toggle Git').keys, ['Ctrl+Shift+G'])
    assert.deepEqual(row(vscode, 'Save all files').keys, ['Cmd+Alt+S'])
    assert.deepEqual(row(vscode, 'Debug: continue').keys, ['F5'])

    const jetbrains = renderShortcuts({ preset: 'jetbrains', platform: Windows })
    assert.deepEqual(row(jetbrains, 'Command palette').keys, ['Ctrl+Shift+A'])
    assert.deepEqual(row(jetbrains, 'Go to symbol in file').keys, ['Ctrl+F12'])
    assert.deepEqual(row(jetbrains, 'Toggle Git').keys, ['Alt+9'])
    assert.deepEqual(row(jetbrains, 'Debug: step over').keys, ['F8'])

    // Vim 方案的全局快捷键与 Workbench 相同。
    assert.deepEqual(
      rows(renderShortcuts({ preset: 'vim', platform: Linux })).map(({ title, keys }) => [title, keys]),
      rows(renderShortcuts({ preset: 'workbench', platform: Linux })).map(({ title, keys }) => [title, keys])
    )
  })

  void test('an action without a key in the preset says so instead of showing an empty button', () => {
    const jetbrains = renderShortcuts({ preset: 'jetbrains', platform: Mac })
    assert.deepEqual(row(jetbrains, 'Toggle AI Chat').keys, ['Not set'])
    assert.deepEqual(
      row(renderShortcuts({ preset: 'jetbrains', platform: Mac, locale: 'zh-CN' }), '切换 AI 聊天').keys,
      ['未设置']
    )
    // 没有哪一行的按钮是空的。
    for (const preset of ['workbench', 'vscode', 'jetbrains', 'vim'] as const)
      for (const platform of [Mac, Windows, Linux])
        for (const item of rows(renderShortcuts({ preset, platform })))
          assert.ok(item.keys[0], `${preset} ${platform} ${item.title}`)
  })

  void test('reset is offered only for keys the user changed, against the preset default', () => {
    const resetDisabled = (html: string, title: string): boolean =>
      /<button[^>]*disabled=""[^>]*aria-label="Reset shortcut"|<button[^>]*aria-label="Reset shortcut"[^>]*disabled=""/u.test(
        row(html, title).html
      )

    // 方案的默认键：没有可重置的。
    const vscode = renderShortcuts({ preset: 'vscode', platform: Mac })
    for (const item of rows(vscode)) assert.equal(resetDisabled(vscode, item.title), true, item.title)

    // 用户另录了一个：显示录的那个，能重置。
    const changed = renderShortcuts({
      preset: 'vscode',
      platform: Mac,
      overrides: { 'toggle-problems': 'Mod+Shift+I' },
    })
    assert.deepEqual(row(changed, 'Toggle Problems').keys, ['Cmd+Shift+I'])
    assert.equal(resetDisabled(changed, 'Toggle Problems'), false)
    assert.equal(resetDisabled(changed, 'Quick open'), true)

    // Workbench 方案下同一个键就是默认键：那一行没有可重置的（比的是所选方案，不是哪个固定的方案）。
    const workbench = renderShortcuts({ preset: 'workbench', platform: Mac })
    assert.deepEqual(row(workbench, 'Toggle Problems').keys, ['Cmd+Shift+I'])
    assert.equal(resetDisabled(workbench, 'Toggle Problems'), true)
  })

  void test('marks both actions of a conflict under the chosen preset', () => {
    // ⇧⌘A 在 JetBrains 方案里是命令面板；用户把 AI 聊天也录成它。
    const html = renderShortcuts({
      preset: 'jetbrains',
      platform: Mac,
      overrides: { 'toggle-actions': 'Mod+Shift+A' },
    })
    assert.match(html, /Some shortcuts use the same key sequence\./u)
    assert.match(row(html, 'Command palette').html, /data-conflict="true"/u)
    assert.match(row(html, 'Toggle AI Chat').html, /data-conflict="true"/u)
    assert.match(row(html, 'Quick open').html, /data-conflict="false"/u)

    // 同样的改动在 Workbench 方案里不冲突（那里它本来就是 AI 聊天的键）。
    const workbench = renderShortcuts({
      preset: 'workbench',
      platform: Mac,
      overrides: { 'toggle-actions': 'Mod+Shift+A' },
    })
    assert.doesNotMatch(workbench, /Some shortcuts use the same key sequence\./u)
    assert.doesNotMatch(workbench, /data-conflict="true"/u)
  })
})

void describe('read-only editor key list', () => {
  void test('lists every editor command with its keys under the chosen preset', () => {
    const workbench = renderEditorKeys('workbench', Mac)
    assert.deepEqual(
      rows(workbench).map((item) => item.id),
      [...WORKBENCH_EDITOR_KEYMAP_COMMANDS]
    )
    assert.deepEqual(row(workbench, 'Go to definition').keys, ['F12'])
    assert.deepEqual(row(workbench, 'Find references').keys, ['Shift+F12', 'Alt+F7'])
    assert.deepEqual(row(workbench, 'Format document').keys, ['Cmd+Alt+L'])
    assert.deepEqual(row(workbench, 'Refactor').keys, ['Ctrl+T'])
    // 方向键写成箭头。
    assert.deepEqual(row(workbench, 'Move line up').keys, ['Alt+↑'])
    assert.deepEqual(row(workbench, 'Add cursor below').keys, ['Cmd+Alt+↓'])
    assert.deepEqual(row(workbench, 'Expand selection').keys, ['Not set'])

    const windows = renderEditorKeys('workbench', Windows)
    assert.deepEqual(row(windows, 'Format document').keys, ['Ctrl+Alt+L'])
    assert.deepEqual(row(windows, 'Refactor').keys, ['Ctrl+Alt+Shift+T'])
    assert.deepEqual(row(windows, 'Redo').keys, ['Ctrl+Y'])
    assert.deepEqual(row(renderEditorKeys('workbench', Linux), 'Redo').keys, ['Ctrl+Y', 'Ctrl+Shift+Z'])

    const vscode = renderEditorKeys('vscode', Mac)
    assert.deepEqual(row(vscode, 'Rename symbol').keys, ['F2'])
    assert.deepEqual(row(vscode, 'Quick fix').keys, ['Cmd+.'])
    assert.deepEqual(row(vscode, 'Trigger completion').keys, ['Ctrl+Space', 'Cmd+I', 'Alt+Escape'])

    const jetbrains = renderEditorKeys('jetbrains', Mac)
    assert.deepEqual(row(jetbrains, 'Go to definition').keys, ['Cmd+B'])
    assert.deepEqual(row(jetbrains, 'Copy line down').keys, ['Cmd+D'])
    assert.deepEqual(row(jetbrains, 'Copy line up').keys, ['Not set'])
    assert.deepEqual(row(jetbrains, 'Delete line').keys, ['Cmd+Backspace'])

    // 中文界面里每个命令也都有名字。
    const chinese = rows(renderEditorKeys('jetbrains', Mac, 'zh-CN'))
    assert.equal(chinese.length, WORKBENCH_EDITOR_KEYMAP_COMMANDS.length)
    for (const item of chinese) assert.doesNotMatch(item.title, /^workbench\.|^$/u)
    assert.deepEqual(chinese[0], { ...chinese[0]!, title: '转到定义', keys: ['Cmd+B'] })
  })

  void test('a key that differs from the Workbench preset shows the Workbench key underneath', () => {
    const vscode = renderEditorKeys('vscode', Mac)
    assert.equal(row(vscode, 'Rename symbol').note, 'Workbench preset: Shift+F6')
    assert.equal(row(vscode, 'Quick fix').note, 'Workbench preset: Alt+Enter / Cmd+.')
    assert.equal(row(vscode, 'Expand selection').note, 'Workbench preset: Not set')
    // 没变的不标。
    assert.equal(row(vscode, 'Go to definition').note, '')
    assert.equal(row(vscode, 'Save').note, '')

    const jetbrains = renderEditorKeys('jetbrains', Windows, 'zh-CN')
    assert.equal(row(jetbrains, '向下复制行').note, 'Workbench 方案：Shift+Alt+↓')
    assert.equal(row(jetbrains, '向上复制行').note, 'Workbench 方案：Shift+Alt+↑')
    assert.deepEqual(row(jetbrains, '向上复制行').keys, ['未设置'])

    // Workbench 与 Vim 方案：没有哪一行标着「变了」。
    for (const preset of ['workbench', 'vim'] as const)
      for (const platform of [Mac, Windows, Linux])
        for (const item of rows(renderEditorKeys(preset, platform)))
          assert.equal(item.note, '', `${preset} ${platform} ${item.title}`)
  })

  void test('is read-only and uses the row and tag styles the dialog already has', () => {
    const html = renderEditorKeys('jetbrains', Mac)
    assert.doesNotMatch(html, /<button|<input|<select|role="combobox"|tabindex/u)
    // 按键是设置里已有的那种小标签（语言那一行用的同一个），里面是 <kbd>：与录制按钮里的键同一种等宽字。
    assert.match(
      row(html, 'Go to definition').html,
      /<span data-tone="default"><kbd>Cmd\+B<\/kbd><\/span>/u
    )

    // 两个组件只用设置里已有的样式类，没有新加样式。
    const source = readSource('src/renderer/src/components/settings/WorkbenchKeymapSettings.tsx')
    const styles = readSource('src/renderer/src/styles/14-settings.module.css')
    const used = [...new Set([...source.matchAll(/styles\.(\w+)/gu)].map((match) => match[1]!))]
    assert.match(source, /import \{ SettingRow, WorkbenchSettingsPill \} from '\.\/WorkbenchSettingsParts'/u)
    assert.deepEqual(used.sort(), [
      'workbenchSettingsSectionPanel',
      'workbenchSettingsSelectTrigger',
      'workbenchSettingsShortcutCapture',
      'workbenchSettingsShortcutControls',
      'workbenchSettingsShortcutDescription',
      'workbenchSettingsShortcutList',
      'workbenchSettingsShortcutMeta',
      'workbenchSettingsShortcutRow',
      'workbenchSettingsShortcutTitle',
      'workbenchSettingsWarning',
    ])
    for (const name of used) assert.ok(styles.includes(`.${name}`), name)
    assert.doesNotMatch(source, /style=\{/u)
    // 行名 12px，与上面的快捷键列表同一个类。
    assert.match(
      styles,
      /\.workbenchSettingsShortcutTitle,\s*\.workbenchSettingsPluginName \{[^}]*font-size: 12px;/u
    )
  })

  void test('sits in the editor tab under the shortcut list, with a note for the Vim preset', () => {
    const dialog = readSource('src/renderer/src/components/settings/WorkbenchSettingsDialog.tsx')
    const group = dialog.slice(
      dialog.indexOf('function renderEditorGroup()'),
      dialog.indexOf('function renderPermissionsSection()')
    )
    const keymapAt = group.indexOf('{renderKeymapSection()}')
    const editorKeysAt = group.indexOf('<WorkbenchEditorKeysSettings preset={keymapPreset} />')
    assert.ok(keymapAt > 0 && editorKeysAt > keymapAt)
    assert.match(
      group,
      /title=\{t\('workbench\.settingsEditorKeys'\)\}\s*description=\{t\(WorkbenchEditorKeysDescriptionKeys\[keymapPreset\]\)\}/u
    )
    // 说明随方案变：有与 Workbench 不同的键的方案说下面标着原来的键，Vim 方案说哪些键先归 Vim。
    assert.deepEqual(
      Object.fromEntries(
        Object.entries(WorkbenchEditorKeysDescriptionKeys).map(([preset, key]) => [
          preset,
          translateWorkbenchAppMessage('en-US', key),
        ])
      ),
      {
        workbench:
          'Keys inside the editor follow the keymap preset; they are listed here and cannot be changed one by one.',
        vscode:
          'Keys inside the editor follow the keymap preset; they are listed here and cannot be changed one by one. Where a key differs from the Workbench preset, the Workbench key is shown underneath.',
        jetbrains:
          'Keys inside the editor follow the keymap preset; they are listed here and cannot be changed one by one. Where a key differs from the Workbench preset, the Workbench key is shown underneath.',
        vim: 'The Vim preset uses the same keys as the Workbench preset; they are listed here and cannot be changed one by one. Keys that Vim uses in the current mode (such as Ctrl+D, Ctrl+F and Ctrl+R in normal mode) go to Vim first.',
      }
    )
    for (const key of Object.values(WorkbenchEditorKeysDescriptionKeys))
      assert.notEqual(translateWorkbenchAppMessage('zh-CN', key), translateWorkbenchAppMessage('en-US', key))
    // 录键的状态留在对话框手里：录键时 Esc 是取消录键，不关设置。
    assert.match(dialog, /if \(event\.key === 'Escape' && !capturingAction\)/u)
    assert.match(dialog, /capturingAction=\{capturingAction\}/u)
    assert.match(dialog, /onCapturingActionChange=\{setCapturingAction\}/u)
  })
})
