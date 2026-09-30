/**
 * 编辑器今天的键位表，在改成「键位方案」之前先钉住：哪个按键做哪件事、各平台分别是什么。
 *
 * 表照 CodeMirror 的写法记（`Mod-Shift-l`，`Mod` 在 macOS 上是 ⌘、别处是 Ctrl），按今天的先后顺序排：
 * 同一个键先登记的先得（`Mod-i` 在实例键位表里是触发补全，CodeMirror 自带的那条「扩大选区」就轮不到）。
 * 下面的测试拿它对照今天的三处来源：编辑器组件里的 `customKeymap`、代码动作的按键表、CodeMirror 自带的键位表。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { completionKeymap, startCompletion } from '@codemirror/autocomplete'
import {
  addCursorAbove,
  addCursorBelow,
  copyLineDown,
  copyLineUp,
  cursorMatchingBracket,
  cursorSyntaxLeft,
  cursorSyntaxRight,
  defaultKeymap,
  deleteLine,
  historyKeymap,
  indentLess,
  indentMore,
  indentSelection,
  indentWithTab,
  insertBlankLine,
  moveLineDown,
  moveLineUp,
  redo,
  redoSelection,
  selectLine,
  selectParentSyntax,
  selectSyntaxLeft,
  selectSyntaxRight,
  simplifySelection,
  toggleBlockComment,
  toggleComment,
  toggleTabFocusMode,
  undo,
  undoSelection,
} from '@codemirror/commands'
import { foldAll, foldCode, foldKeymap, unfoldAll, unfoldCode } from '@codemirror/language'
import { lintKeymap, nextDiagnostic, openLintPanel } from '@codemirror/lint'
import type { Command, KeyBinding } from '@codemirror/view'
import { describe, test } from 'bun:test'

import { resolveWorkbenchEditorCommandFromKey } from '../src/renderer/src/models/editor/workbenchEditorCommands'
import {
  listWorkbenchEditorKeymapBindings,
  resolveWorkbenchEditorKeymapCommand,
  WORKBENCH_EDITOR_KEYMAP_COMMANDS,
} from '../src/renderer/src/models/editor/workbenchEditorKeymap'

type PinnedPlatform = 'mac' | 'win' | 'linux'

/** 这条按键今天登记在哪：代码动作的按键表、补全自带的键位表、编辑器组件里的表，还是 CodeMirror 自带的几张表。 */
type PinnedSource = 'chords' | 'completion' | 'custom' | 'default' | 'history' | 'fold' | 'lint'

interface PinnedBinding {
  command: string
  source: PinnedSource
  /** 各平台都用的键；某个平台另给了就用那个平台的。 */
  key?: string
  mac?: string
  win?: string
  linux?: string
}

const PinnedPlatforms: readonly PinnedPlatform[] = ['mac', 'win', 'linux']

/** 今天的键位表，先登记的在前。 */
const PinnedWorkbenchEditorBindings: readonly PinnedBinding[] = [
  // 代码动作与跟着符号走的导航：直接接 keydown，排在所有键位表前面。
  { command: 'quick-fix', source: 'chords', key: 'Alt-Enter' },
  { command: 'quick-fix', source: 'chords', key: 'Mod-.' },
  {
    command: 'refactor',
    source: 'chords',
    mac: 'Ctrl-t',
    win: 'Ctrl-Alt-Shift-t',
    linux: 'Ctrl-Alt-Shift-t',
  },
  { command: 'organize-imports', source: 'chords', key: 'Shift-Alt-o' },
  { command: 'call-hierarchy', source: 'chords', key: 'Ctrl-Alt-h' },
  { command: 'find-references', source: 'chords', key: 'Shift-F12' },
  { command: 'find-references', source: 'chords', key: 'Alt-F7' },
  // 补全自带的键位表（优先级最高的那一张）里触发补全的键。
  { command: 'trigger-completion', source: 'completion', key: 'Ctrl-Space' },
  // 编辑器组件里的表，照源码里的顺序。
  { command: 'trigger-completion', source: 'custom', key: 'Mod-i' },
  { command: 'go-to-definition', source: 'custom', key: 'F12' },
  { command: 'rename-symbol', source: 'custom', key: 'Shift-F6' },
  { command: 'select-all-occurrences', source: 'custom', key: 'Mod-Shift-l' },
  { command: 'select-next-occurrence', source: 'custom', key: 'Mod-d' },
  { command: 'toggle-line-comment', source: 'custom', key: 'Mod-/' },
  { command: 'format-document', source: 'custom', key: 'Mod-Alt-l' },
  { command: 'toggle-word-wrap', source: 'custom', key: 'Alt-z' },
  { command: 'indent-more', source: 'custom', key: 'Mod-]' },
  { command: 'indent-less', source: 'custom', key: 'Mod-[' },
  { command: 'save', source: 'custom', key: 'Mod-s' },
  { command: 'find', source: 'custom', key: 'Mod-f' },
  { command: 'replace', source: 'custom', key: 'Mod-h', mac: 'Mod-Alt-f' },
  { command: 'find-next', source: 'custom', key: 'F3' },
  { command: 'find-next', source: 'custom', mac: 'Mod-g' },
  { command: 'find-previous', source: 'custom', key: 'Shift-F3' },
  { command: 'cancel', source: 'custom', key: 'Escape' },
  { command: 'go-to-line', source: 'custom', key: 'Ctrl-g' },
  { command: 'navigate-back', source: 'custom', win: 'Alt-ArrowLeft', linux: 'Alt-ArrowLeft' },
  { command: 'navigate-forward', source: 'custom', win: 'Alt-ArrowRight', linux: 'Alt-ArrowRight' },
  { command: 'go-to-line', source: 'custom', key: 'Mod-l' },
  { command: 'indent-more', source: 'custom', key: 'Tab' },
  { command: 'indent-less', source: 'custom', key: 'Shift-Tab' },
  // CodeMirror 自带的 defaultKeymap 里标准键之外的那几条。
  { command: 'cursor-syntax-left', source: 'default', key: 'Alt-ArrowLeft', mac: 'Ctrl-ArrowLeft' },
  {
    command: 'select-syntax-left',
    source: 'default',
    key: 'Shift-Alt-ArrowLeft',
    mac: 'Shift-Ctrl-ArrowLeft',
  },
  { command: 'cursor-syntax-right', source: 'default', key: 'Alt-ArrowRight', mac: 'Ctrl-ArrowRight' },
  {
    command: 'select-syntax-right',
    source: 'default',
    key: 'Shift-Alt-ArrowRight',
    mac: 'Shift-Ctrl-ArrowRight',
  },
  { command: 'move-line-up', source: 'default', key: 'Alt-ArrowUp' },
  { command: 'copy-line-up', source: 'default', key: 'Shift-Alt-ArrowUp' },
  { command: 'move-line-down', source: 'default', key: 'Alt-ArrowDown' },
  { command: 'copy-line-down', source: 'default', key: 'Shift-Alt-ArrowDown' },
  { command: 'add-cursor-above', source: 'default', key: 'Mod-Alt-ArrowUp' },
  { command: 'add-cursor-below', source: 'default', key: 'Mod-Alt-ArrowDown' },
  { command: 'cancel', source: 'default', key: 'Escape' },
  { command: 'insert-blank-line', source: 'default', key: 'Mod-Enter' },
  { command: 'select-line', source: 'default', key: 'Alt-l', mac: 'Ctrl-l' },
  { command: 'expand-selection', source: 'default', key: 'Mod-i' },
  { command: 'indent-less', source: 'default', key: 'Mod-[' },
  { command: 'indent-more', source: 'default', key: 'Mod-]' },
  { command: 'reindent-selection', source: 'default', key: 'Mod-Alt-\\' },
  { command: 'delete-line', source: 'default', key: 'Shift-Mod-k' },
  { command: 'jump-to-bracket', source: 'default', key: 'Shift-Mod-\\' },
  { command: 'toggle-line-comment', source: 'default', key: 'Mod-/' },
  // CodeMirror 把它写成 `Alt-A`：大写字母就是带 Shift。
  { command: 'toggle-block-comment', source: 'default', key: 'Shift-Alt-a' },
  { command: 'toggle-tab-focus-mode', source: 'default', key: 'Ctrl-m', mac: 'Shift-Alt-m' },
  { command: 'undo', source: 'history', key: 'Mod-z' },
  { command: 'redo', source: 'history', key: 'Mod-y', mac: 'Mod-Shift-z' },
  { command: 'redo', source: 'history', linux: 'Ctrl-Shift-z' },
  { command: 'undo-selection', source: 'history', key: 'Mod-u' },
  { command: 'redo-selection', source: 'history', key: 'Alt-u', mac: 'Mod-Shift-u' },
  { command: 'fold', source: 'fold', key: 'Ctrl-Shift-[', mac: 'Cmd-Alt-[' },
  { command: 'unfold', source: 'fold', key: 'Ctrl-Shift-]', mac: 'Cmd-Alt-]' },
  { command: 'fold-all', source: 'fold', key: 'Ctrl-Alt-[' },
  { command: 'unfold-all', source: 'fold', key: 'Ctrl-Alt-]' },
  { command: 'open-lint-panel', source: 'lint', key: 'Mod-Shift-m' },
  { command: 'next-problem', source: 'lint', key: 'F8' },
]

/**
 * 每个平台上今天没有键的命令（同一个键先登记的先得）：
 *  - `expand-selection`：它的 `Mod-i` 被触发补全占了，各平台都按不到；
 *  - `cursor-syntax-left` / `cursor-syntax-right`：Windows / Linux 上的 Alt+← / Alt+→ 被后退 / 前进占了，只有 macOS 上有键；
 *  - `navigate-back` / `navigate-forward`：macOS 上编辑器不占键（⌃- / ⌃⇧- 是全局快捷键）。
 */
const PinnedUnboundCommands: Readonly<Record<PinnedPlatform, readonly string[]>> = {
  mac: ['expand-selection', 'navigate-back', 'navigate-forward'],
  win: ['cursor-syntax-left', 'cursor-syntax-right', 'expand-selection'],
  linux: ['cursor-syntax-left', 'cursor-syntax-right', 'expand-selection'],
}

interface PinnedChord {
  alt: boolean
  ctrl: boolean
  meta: boolean
  shift: boolean
  /** 具名键（`Enter`、`ArrowLeft`、`F12`）或小写的字符键。 */
  key: string
}

/** CodeMirror 的按键写法换成修饰键加键名；单个大写字母就是带 Shift 的那个字母。 */
function parsePinnedKey(name: string, platform: PinnedPlatform): PinnedChord {
  const parts = name.split('-')
  let key = parts.pop() ?? ''
  const modifiers = new Set(parts)
  // 键本身是 `-` 时最后一段是空的；这张表里没有这样的键。
  assert.notEqual(key, '', name)
  if (key.length === 1 && key !== key.toLowerCase()) {
    modifiers.add('Shift')
    key = key.toLowerCase()
  }
  const mod = modifiers.has('Mod')
  return {
    alt: modifiers.has('Alt'),
    ctrl: modifiers.has('Ctrl') || (mod && platform !== 'mac'),
    meta: modifiers.has('Cmd') || modifiers.has('Meta') || (mod && platform === 'mac'),
    shift: modifiers.has('Shift'),
    key,
  }
}

function chordSignature(chord: PinnedChord): string {
  return [
    chord.alt ? 'Alt' : '',
    chord.ctrl ? 'Ctrl' : '',
    chord.meta ? 'Meta' : '',
    chord.shift ? 'Shift' : '',
    chord.key,
  ]
    .filter(Boolean)
    .join('+')
}

function pinnedKeyFor(binding: PinnedBinding | KeyBinding, platform: PinnedPlatform): string | undefined {
  return binding[platform] || binding.key
}

/** 这个平台上实际生效的表：按键 → 命令。 */
function effectivePinnedTable(platform: PinnedPlatform): Map<string, string> {
  const table = new Map<string, string>()
  for (const binding of PinnedWorkbenchEditorBindings) {
    const name = pinnedKeyFor(binding, platform)
    if (!name) continue
    const signature = chordSignature(parsePinnedKey(name, platform))
    if (!table.has(signature)) table.set(signature, binding.command)
  }
  return table
}

const UsKeyCodes: Readonly<Record<string, string>> = {
  '.': 'Period',
  '/': 'Slash',
  '[': 'BracketLeft',
  ']': 'BracketRight',
  '\\': 'Backslash',
}
const UsShiftedCharacters: Readonly<Record<string, string>> = {
  '.': '>',
  '/': '?',
  '[': '{',
  ']': '}',
  '\\': '|',
}

/** 美式键盘上按下这组键时浏览器给的事件（`key` 是打出来的字，`code` 是物理键位）。 */
function pinnedKeyEvent(chord: PinnedChord, platform: PinnedPlatform) {
  const modifiers = {
    altKey: chord.alt,
    ctrlKey: chord.ctrl,
    metaKey: chord.meta,
    shiftKey: chord.shift,
  }
  if (chord.key.length > 1) return { ...modifiers, key: chord.key === 'Space' ? ' ' : chord.key, code: chord.key }

  const code = /^[a-z]$/u.test(chord.key) ? `Key${chord.key.toUpperCase()}` : UsKeyCodes[chord.key]
  assert.ok(code, chord.key)
  // macOS 上按着 ⌥ 打出来的是别的字符（⌥Z 是 Ω）；这里不逐个列，给一个不是 ASCII 的字符就够说明问题。
  const key =
    platform === 'mac' && chord.alt
      ? '¤'
      : chord.shift
        ? (UsShiftedCharacters[chord.key] ?? chord.key.toUpperCase())
        : chord.key
  return { ...modifiers, key, code }
}

function platformName(platform: PinnedPlatform): string {
  return platform === 'mac' ? 'MacIntel' : platform === 'win' ? 'Win32' : 'Linux x86_64'
}

function readSource(relativePath: string): string {
  return readFileSync(resolve(process.cwd(), relativePath), 'utf8')
}

/** CodeMirror 自带的键位表里各条命令对应的名字（`shift` 是同一条绑定带 Shift 时的命令）。 */
const StockCommands: ReadonlyArray<readonly [string, Command]> = [
  ['trigger-completion', startCompletion],
  ['cursor-syntax-left', cursorSyntaxLeft],
  ['select-syntax-left', selectSyntaxLeft],
  ['cursor-syntax-right', cursorSyntaxRight],
  ['select-syntax-right', selectSyntaxRight],
  ['move-line-up', moveLineUp],
  ['copy-line-up', copyLineUp],
  ['move-line-down', moveLineDown],
  ['copy-line-down', copyLineDown],
  ['add-cursor-above', addCursorAbove],
  ['add-cursor-below', addCursorBelow],
  ['cancel', simplifySelection],
  ['insert-blank-line', insertBlankLine],
  ['select-line', selectLine],
  ['expand-selection', selectParentSyntax],
  ['indent-less', indentLess],
  ['indent-more', indentMore],
  ['reindent-selection', indentSelection],
  ['delete-line', deleteLine],
  ['jump-to-bracket', cursorMatchingBracket],
  ['toggle-line-comment', toggleComment],
  ['toggle-block-comment', toggleBlockComment],
  ['toggle-tab-focus-mode', toggleTabFocusMode],
  ['undo', undo],
  ['redo', redo],
  ['undo-selection', undoSelection],
  ['redo-selection', redoSelection],
  ['fold', foldCode],
  ['unfold', unfoldCode],
  ['fold-all', foldAll],
  ['unfold-all', unfoldAll],
  ['open-lint-panel', openLintPanel],
  ['next-problem', nextDiagnostic],
]

function stockCommandName(command: Command | undefined): string | undefined {
  return StockCommands.find(([, stock]) => stock === command)?.[0]
}

/** 一张自带键位表在某个平台上的内容：「按键 → 命令」，带 Shift 的那一半单独算一条。 */
function stockTable(bindings: readonly KeyBinding[], platform: PinnedPlatform): string[] {
  return bindings.flatMap((binding) => {
    const name = pinnedKeyFor(binding, platform)
    if (!name) return []
    const chord = parsePinnedKey(name, platform)
    const rows: string[] = []
    const run = stockCommandName(binding.run)
    if (run) rows.push(`${chordSignature(chord)} → ${run}`)
    const shifted = stockCommandName(binding.shift)
    if (shifted) rows.push(`${chordSignature({ ...chord, shift: true })} → ${shifted}`)
    return rows
  })
}

function pinnedTable(source: PinnedSource, platform: PinnedPlatform): string[] {
  return PinnedWorkbenchEditorBindings.flatMap((binding) => {
    const name = binding.source === source ? pinnedKeyFor(binding, platform) : undefined
    return name ? [`${chordSignature(parsePinnedKey(name, platform))} → ${binding.command}`] : []
  })
}

void describe('the editor key bindings as they are today', () => {
  void test('the keymap in the editor component binds these keys, in this order', () => {
    const editor = readSource('src/renderer/src/components/editor/CodeMirrorEditor.tsx')
    const start = editor.indexOf('const customKeymap = keymap.of([')
    const end = editor.indexOf('indentWithTab,\n      ])', start)
    assert.ok(start > 0 && end > start)

    // 每条绑定写了哪些键（`key` 各平台通用，`mac` / `win` / `linux` 是那个平台的），照源码里的顺序。
    const declared = [...editor.slice(start, end).matchAll(/\b(key|mac|win|linux): '([^']+)'/gu)].map(
      ([, property, name]) => `${property}: ${name}`
    )
    const pinned = PinnedWorkbenchEditorBindings.filter(
      (binding) => binding.source === 'custom' && binding.key !== 'Tab' && binding.key !== 'Shift-Tab'
    ).flatMap((binding) =>
      (['key', 'mac', 'win', 'linux'] as const).flatMap((property) =>
        binding[property] ? [`${property}: ${binding[property]}`] : []
      )
    )
    assert.deepEqual(declared, pinned)

    // 表的最后是 CodeMirror 的 Tab / Shift-Tab（缩进、减少缩进）。
    assert.equal(indentWithTab.key, 'Tab')
    assert.equal(indentWithTab.run, indentMore)
    assert.equal(indentWithTab.shift, indentLess)

    // 代码动作的按键排在它前面，CodeMirror 自带的几张表排在它后面。
    assert.match(
      editor,
      /keymap: \[\s*workbenchEditorCommandKeys\(\(command\) => editorActionsRef\.current\.runCommand\(command\)\),\s*customKeymap,\s*\]/u
    )
    assert.match(
      editor,
      /keymap\.of\(\[\s*\.\.\.closeBracketsKeymap,\s*\.\.\.defaultKeymap,[\s\S]*?\.\.\.historyKeymap,\s*\.\.\.foldKeymap,\s*\.\.\.lintKeymap,\s*\]\)/u
    )
    assert.match(editor, /autocompletion\(\{[\s\S]*?defaultKeymap: true,/u)
  })

  void test('the code action keys resolve to these commands', () => {
    for (const platform of PinnedPlatforms) {
      for (const binding of PinnedWorkbenchEditorBindings) {
        const name = binding.source === 'chords' ? pinnedKeyFor(binding, platform) : undefined
        if (!name) continue
        assert.equal(
          resolveWorkbenchEditorCommandFromKey(
            pinnedKeyEvent(parsePinnedKey(name, platform), platform),
            platformName(platform)
          ),
          binding.command,
          `${platform} ${name}`
        )
      }
    }
  })

  void test("CodeMirror's own keymaps bind the rest", () => {
    // 标准键（方向键、Home / End、回车、退格、全选……）不在这张表里：它们不随键位方案变。
    const extras = defaultKeymap.slice(0, defaultKeymap.findIndex((binding) => binding.key === 'ArrowLeft'))
    for (const platform of PinnedPlatforms) {
      assert.deepEqual(stockTable(extras, platform), pinnedTable('default', platform), platform)
      assert.deepEqual(stockTable(historyKeymap, platform), pinnedTable('history', platform), platform)
      assert.deepEqual(stockTable(foldKeymap, platform), pinnedTable('fold', platform), platform)
      assert.deepEqual(stockTable(lintKeymap, platform), pinnedTable('lint', platform), platform)
      // 补全那张表里别的键（方向键、回车、Esc）是补全列表开着时用的；macOS 上另有两个带 ⌥ 的键，
      // 在美式键盘上是死键，按不出来。
      assert.deepEqual(
        stockTable(
          completionKeymap.filter((binding) => binding.key === 'Ctrl-Space'),
          platform
        ),
        pinnedTable('completion', platform),
        platform
      )
    }
  })

  void test('on every platform each key means one command, and these commands have no key', () => {
    for (const platform of PinnedPlatforms) {
      const table = effectivePinnedTable(platform)
      const bound = new Set(table.values())
      const commands = [...new Set(PinnedWorkbenchEditorBindings.map((binding) => binding.command))]
      assert.deepEqual(
        commands.filter((command) => !bound.has(command)).sort(),
        [...PinnedUnboundCommands[platform]].sort(),
        platform
      )
    }

    // 几个平台不一样的地方。
    const mac = effectivePinnedTable('mac')
    const win = effectivePinnedTable('win')
    const linux = effectivePinnedTable('linux')
    assert.equal(mac.get('Alt+Meta+f'), 'replace')
    assert.equal(win.get('Ctrl+h'), 'replace')
    assert.equal(mac.get('Meta+g'), 'find-next')
    assert.equal(win.get('Ctrl+g'), 'go-to-line')
    assert.equal(mac.get('Ctrl+g'), 'go-to-line')
    assert.equal(mac.get('Meta+l'), 'go-to-line')
    assert.equal(mac.get('Ctrl+l'), 'select-line')
    assert.equal(linux.get('Ctrl+l'), 'go-to-line')
    assert.equal(linux.get('Alt+l'), 'select-line')
    assert.equal(win.get('Alt+ArrowLeft'), 'navigate-back')
    assert.equal(mac.get('Alt+ArrowLeft'), undefined)
    assert.equal(mac.get('Ctrl+ArrowLeft'), 'cursor-syntax-left')
    assert.equal(mac.get('Meta+Shift+z'), 'redo')
    assert.equal(win.get('Ctrl+y'), 'redo')
    assert.equal(win.get('Ctrl+Shift+z'), undefined)
    assert.equal(linux.get('Ctrl+Shift+z'), 'redo')
    assert.equal(mac.get('Alt+Meta+['), 'fold')
    assert.equal(linux.get('Ctrl+Shift+['), 'fold')
    assert.equal(mac.get('Ctrl+t'), 'refactor')
    assert.equal(win.get('Alt+Ctrl+Shift+t'), 'refactor')
    assert.equal(mac.get('Meta+i'), 'trigger-completion')
  })
})

/** 键位表里的写法（`Mod+Shift+L`）换成与上面同一种写法的键。 */
function presetChordSignature(chord: string, platform: PinnedPlatform): string {
  const parts = chord.split(/\b\+/u)
  const key = parts.pop() ?? ''
  const modifiers = new Set(parts)
  const mod = modifiers.has('Mod')
  return chordSignature({
    alt: modifiers.has('Alt'),
    ctrl: modifiers.has('Ctrl') || (mod && platform !== 'mac'),
    meta: mod && platform === 'mac',
    shift: modifiers.has('Shift'),
    key: key.length === 1 ? key.toLowerCase() : key,
  })
}

void describe('the Workbench keymap preset is that table', () => {
  void test('every key of the table resolves to the same command', () => {
    for (const platform of PinnedPlatforms) {
      for (const binding of PinnedWorkbenchEditorBindings) {
        const name = pinnedKeyFor(binding, platform)
        if (!name) continue
        const chord = parsePinnedKey(name, platform)
        // 被先登记的同一个键盖住的那几条（`Mod-i` 的扩大选区……）按实际生效的命令算。
        const expected = effectivePinnedTable(platform).get(chordSignature(chord))
        assert.equal(
          resolveWorkbenchEditorKeymapCommand(pinnedKeyEvent(chord, platform), platformName(platform)),
          expected,
          `${platform} ${name}`
        )
      }
    }
  })

  void test('and the preset binds no other key', () => {
    for (const platform of PinnedPlatforms) {
      const preset = new Map(
        listWorkbenchEditorKeymapBindings('workbench', platformName(platform)).map((binding) => [
          presetChordSignature(binding.chord, platform),
          binding.command as string,
        ])
      )
      assert.deepEqual(
        [...preset].sort(([left], [right]) => left.localeCompare(right)),
        [...effectivePinnedTable(platform)].sort(([left], [right]) => left.localeCompare(right)),
        platform
      )
    }
  })

  void test('the commands of the table are the commands of the registry', () => {
    // 「上一个问题」是新加的命令：Workbench 方案里没有键，VS Code、JetBrains 方案里有。
    assert.deepEqual(
      [...WORKBENCH_EDITOR_KEYMAP_COMMANDS].sort(),
      [
        ...new Set(PinnedWorkbenchEditorBindings.map((binding) => binding.command)),
        'previous-problem',
      ].sort()
    )
  })
})
