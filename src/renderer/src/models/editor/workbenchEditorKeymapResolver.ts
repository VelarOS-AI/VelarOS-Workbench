/**
 * 一次按键是编辑器的哪个命令：把按键对到键位表（`workbenchEditorKeymap.ts`）里的一组键上。编辑器据此分发按键
 * （`workbenchCodeMirrorEditorCommands.ts`），Vim 方案据此认哪些键是编辑器命令的（`workbenchEditorVimKeys.ts`）。
 * 不引 CodeMirror。
 */
import {
  currentWorkbenchPlatform,
  DEFAULT_WORKBENCH_KEYMAP_PRESET,
  resolveWorkbenchKeymapPlatform,
  resolveWorkbenchKeymapTablePreset,
  type WorkbenchKeymapPlatform,
  type WorkbenchKeymapPresetId,
} from '../layout/workbenchKeymapPresets'

import {
  listWorkbenchEditorKeymapBindings,
  workbenchEditorChordSignature,
  type WorkbenchEditorKeymapCommandId,
} from './workbenchEditorKeymap'

const commandsBySignature = new Map<string, ReadonlyMap<string, WorkbenchEditorKeymapCommandId>>()

function resolveCommandsBySignature(
  preset: WorkbenchKeymapPresetId,
  platform: string
): ReadonlyMap<string, WorkbenchEditorKeymapCommandId> {
  const cacheKey = `${resolveWorkbenchKeymapTablePreset(preset)}:${resolveWorkbenchKeymapPlatform(platform)}`
  let commands = commandsBySignature.get(cacheKey)
  if (!commands) {
    const bySignature = new Map<string, WorkbenchEditorKeymapCommandId>()
    // 表里不该有同键的两个命令（测试钉着）；万一有，排在前面的先得。
    for (const binding of listWorkbenchEditorKeymapBindings(preset, platform))
      if (!bySignature.has(binding.signature)) bySignature.set(binding.signature, binding.command)
    commands = bySignature
    commandsBySignature.set(cacheKey, commands)
  }
  return commands
}

export interface WorkbenchEditorKeyEventLike {
  key: string
  code: string
  /** 浏览器给的虚拟键码（已废弃但都有）；测试里的事件可以不给，那就按 `code` 认键位。 */
  keyCode?: number
  altKey: boolean
  ctrlKey: boolean
  metaKey: boolean
  shiftKey: boolean
}

const NamedKeys = new Set([
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'ArrowUp',
  'Backspace',
  'Delete',
  'End',
  'Enter',
  'Escape',
  'Home',
  'PageDown',
  'PageUp',
  'Tab',
])

/** 美式键盘上各物理键位不按 Shift 打出来的字符。 */
const UsCodeCharacters: Readonly<Record<string, string>> = {
  Backquote: '`',
  Backslash: '\\',
  BracketLeft: '[',
  BracketRight: ']',
  Comma: ',',
  Equal: '=',
  Minus: '-',
  Period: '.',
  Quote: "'",
  Semicolon: ';',
  Slash: '/',
}

/** 虚拟键码对应的字符（标点那几个；字母、数字直接算）。 */
const KeyCodeCharacters: Readonly<Record<number, string>> = {
  59: ';',
  61: '=',
  173: '-',
  186: ';',
  187: '=',
  188: ',',
  189: '-',
  190: '.',
  191: '/',
  192: '`',
  219: '[',
  220: '\\',
  221: ']',
  222: "'",
}

/** 美式键盘上按着 Shift 打出来的符号对应的那个键。 */
const UsShiftedCharacters: Readonly<Record<string, string>> = {
  '!': '1',
  '"': "'",
  '#': '3',
  $: '4',
  '%': '5',
  '&': '7',
  '(': '9',
  ')': '0',
  '*': '8',
  '+': '=',
  ':': ';',
  '<': ',',
  '>': '.',
  '?': '/',
  '@': '2',
  '^': '6',
  _: '-',
  '{': '[',
  '|': '\\',
  '}': ']',
  '~': '`',
}

/**
 * 这个键不看打出来的字是哪个键：先看虚拟键码（它跟着键盘布局上的拉丁字母走，非拉丁布局下是美式键位上的
 * 那个字母），没有就看物理键位。
 */
function baseKeyCharacter(event: WorkbenchEditorKeyEventLike): Nullable<string> {
  const { keyCode, code } = event
  if (keyCode) {
    if (keyCode >= 65 && keyCode <= 90) return String.fromCharCode(keyCode + 32)
    if (keyCode >= 48 && keyCode <= 57) return String.fromCharCode(keyCode)
    const character = KeyCodeCharacters[keyCode]
    if (character) return character
  }
  if (/^Key[A-Z]$/u.test(code)) return code.slice(3).toLowerCase()
  if (/^Digit\d$/u.test(code)) return code.slice(5)
  return UsCodeCharacters[code] ?? null
}

/**
 * 一次按键可能对上的几组键，先对上的算数。修饰键要一个不多、一个不少。
 *
 * 字符键照打出来的字认（用 Dvorak、AZERTY 这类布局的人按的是标着那个字母的键）；打出来的字靠不住时改看
 * 这个键本身是哪个（`baseKeyCharacter`）：
 *  - macOS 上按着 ⌥：打出来的是别的字符（⌥Z 是 Ω）；
 *  - Windows / Linux 上同时按着 Ctrl 与 Alt：AltGr 就是这样到的。Windows 上打出来的字与这个键本身的字符不一样
 *    时，那是在用 AltGr 输入（波兰语的 ł、德语键盘上的 [），不算快捷键；
 *  - 打出来的不是 ASCII 字符（西里尔、希腊字母这类布局）。
 */
function eventSignatures(
  event: WorkbenchEditorKeyEventLike,
  platform: WorkbenchKeymapPlatform
): string[] {
  const modifiers = {
    alt: event.altKey,
    ctrl: event.ctrlKey,
    meta: event.metaKey,
    shift: event.shiftKey,
  }
  const { key } = event
  if (key === ' ') return [workbenchEditorChordSignature({ ...modifiers, key: 'Space' })]
  if (NamedKeys.has(key) || /^F\d{1,2}$/u.test(key)) return [workbenchEditorChordSignature({ ...modifiers, key })]

  const base = baseKeyCharacter(event)

  if (platform === 'mac' ? event.altKey : event.ctrlKey && event.altKey) {
    const typesAnotherCharacter =
      key.length === 1 && (UsShiftedCharacters[key] ?? key.toLowerCase()) !== base
    if (platform === 'windows' && typesAnotherCharacter) return []
    return base ? [workbenchEditorChordSignature({ ...modifiers, key: base })] : []
  }

  const typed = key.length === 1 && key > ' ' && key <= '~' ? key : null
  const signatures: string[] = []
  if (typed !== null) {
    signatures.push(workbenchEditorChordSignature({ ...modifiers, key: typed.toLowerCase() }))
    // 这个布局上要按着 Shift 才打得出来的符号（AZERTY、德语键盘上的 /）：Shift 不算在这组键里。
    if (event.shiftKey && !/[a-z]/iu.test(typed))
      signatures.push(workbenchEditorChordSignature({ ...modifiers, shift: false, key: typed }))
  }
  if (base && base !== typed?.toLowerCase() && (event.altKey || event.ctrlKey || event.metaKey))
    signatures.push(workbenchEditorChordSignature({ ...modifiers, key: base }))
  return signatures
}

/**
 * 这次按键在这个方案里是编辑器的哪个命令；不是返回 null。`platform` 不给用当前宿主平台（测试里指定，结果
 * 不随跑测试的系统变）。
 */
export function resolveWorkbenchEditorKeymapCommand(
  event: WorkbenchEditorKeyEventLike,
  platform: string = currentWorkbenchPlatform(),
  preset: WorkbenchKeymapPresetId = DEFAULT_WORKBENCH_KEYMAP_PRESET
): Nullable<WorkbenchEditorKeymapCommandId> {
  const commands = resolveCommandsBySignature(preset, platform)
  for (const signature of eventSignatures(event, resolveWorkbenchKeymapPlatform(platform))) {
    const command = commands.get(signature)
    if (command) return command
  }
  return null
}
