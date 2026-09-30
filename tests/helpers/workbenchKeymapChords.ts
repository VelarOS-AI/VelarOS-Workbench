/**
 * 键位表测试共用的：把表里的写法（`Mod+Shift+L`）落到某个平台上的一组键，以及美式键盘上按这组键时浏览器给的事件。
 */

export const KeymapTestPlatforms = ['MacIntel', 'Win32', 'Linux x86_64'] as const
export type KeymapTestPlatform = (typeof KeymapTestPlatforms)[number]

export interface KeymapTestChord {
  alt: boolean
  ctrl: boolean
  meta: boolean
  shift: boolean
  /** 具名键（`Enter`、`ArrowLeft`、`F12`、`Space`）或小写的字符。 */
  key: string
}

/** 按物理键位写的键（全局快捷键里的 `Minus`、`KeyS`）对应的字符。 */
function physicalKeyCharacter(key: string): string {
  if (key === 'Minus') return '-'
  if (key === 'Backslash') return '\\'
  return /^(?:Key[A-Z]|Digit\d)$/u.test(key) ? key.slice(-1) : key
}

export function parseKeymapTestChord(chord: string, platform: KeymapTestPlatform): KeymapTestChord {
  const parts = chord.split(/\b\+/u)
  const key = physicalKeyCharacter(parts.pop() ?? '')
  const modifiers = new Set(parts)
  const mac = platform === 'MacIntel'
  const mod = modifiers.has('Mod')
  return {
    alt: modifiers.has('Alt'),
    ctrl: modifiers.has('Ctrl') || (mod && !mac),
    meta: modifiers.has('Meta') || (mod && mac),
    shift: modifiers.has('Shift'),
    key: key.length === 1 ? key.toLowerCase() : key,
  }
}

/** 一组键在一个平台上的样子：两组键相同就是它相同。 */
export function keymapTestChordSignature(chord: KeymapTestChord): string {
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

export function keymapTestSignature(chord: string, platform: KeymapTestPlatform): string {
  return keymapTestChordSignature(parseKeymapTestChord(chord, platform))
}

const UsKeyCodes: Readonly<Record<string, string>> = {
  '`': 'Backquote',
  '-': 'Minus',
  '=': 'Equal',
  '[': 'BracketLeft',
  ']': 'BracketRight',
  '\\': 'Backslash',
  ';': 'Semicolon',
  "'": 'Quote',
  ',': 'Comma',
  '.': 'Period',
  '/': 'Slash',
}
const UsShiftedCharacters: Readonly<Record<string, string>> = {
  '`': '~',
  '-': '_',
  '=': '+',
  '[': '{',
  ']': '}',
  '\\': '|',
  ';': ':',
  "'": '"',
  ',': '<',
  '.': '>',
  '/': '?',
  '1': '!',
  '2': '@',
  '3': '#',
  '4': '$',
  '5': '%',
  '6': '^',
  '7': '&',
  '8': '*',
  '9': '(',
  '0': ')',
}

export interface KeymapTestKeyEvent {
  key: string
  code: string
  altKey: boolean
  ctrlKey: boolean
  metaKey: boolean
  shiftKey: boolean
}

/**
 * 美式键盘上按下这组键时浏览器给的事件：`key` 是打出来的字，`code` 是物理键位。macOS 上按着 ⌥ 打出来的是
 * 别的字符（⌥Z 是 Ω），这里不逐个列，给一个不是 ASCII 的字符。
 */
export function keymapTestKeyEvent(chord: KeymapTestChord, platform: KeymapTestPlatform): KeymapTestKeyEvent {
  const modifiers = {
    altKey: chord.alt,
    ctrlKey: chord.ctrl,
    metaKey: chord.meta,
    shiftKey: chord.shift,
  }
  if (chord.key.length > 1)
    return { ...modifiers, key: chord.key === 'Space' ? ' ' : chord.key, code: chord.key }

  const code = /^[a-z]$/u.test(chord.key)
    ? `Key${chord.key.toUpperCase()}`
    : /^\d$/u.test(chord.key)
      ? `Digit${chord.key}`
      : UsKeyCodes[chord.key]
  if (!code) throw new Error(`No key position for "${chord.key}"`)

  const key =
    platform === 'MacIntel' && chord.alt
      ? '¤'
      : chord.shift
        ? (UsShiftedCharacters[chord.key] ?? chord.key.toUpperCase())
        : chord.key
  return { ...modifiers, key, code }
}

export function keymapTestEventFor(chord: string, platform: KeymapTestPlatform): KeymapTestKeyEvent {
  return keymapTestKeyEvent(parseKeymapTestChord(chord, platform), platform)
}
