/**
 * 工作台键盘快捷键模型。
 *
 * 解析与匹配两步原本是约 50 行自研逻辑，本版本改用快捷键库：
 *  - 我们把外部统一写法 `"Mod+P"` 翻译成库内部写法：主修饰键按平台落到 Mac 上的 Meta、
 *    其它平台上的 Control，比历史"任意一个主修饰键都算 Mod"的实现更贴近原生体验；Mac 上的
 *    Control 另写作 `Ctrl`。
 *  - 测试可能直接传裸字段键盘事件对象，用一层适配包装补齐标准事件方法。
 *
 * 显示格式、持久化、捕获（事件到短串）是应用特化逻辑，仍由本文件内部实现。
 */

import { type KeyBindingPress, matchKeyBindingPress, parseKeybinding } from 'tinykeys'

import { isFunction,isString, Log, toNullable } from '@velaros-ai/core'

import {
  createLocalStorageJsonStore,
  type StorageLike,
} from '../../persistence/localStorageJsonStore'

const log = Log.tag('workbench-keyboard-shortcuts')

export type WorkbenchKeyboardShortcutAction =
  | 'close-right-tool'
  | 'quick-open'
  | 'reopen-closed-tab'
  | 'run-last-command'
  | 'save-all'
  | 'save-current'
  | 'toggle-actions'
  | 'toggle-changes'
  | 'toggle-problems'

export interface WorkbenchKeyboardShortcutDefinition {
  action: WorkbenchKeyboardShortcutAction
  defaultShortcut: string
}

export type WorkbenchKeyboardShortcutMap = Record<WorkbenchKeyboardShortcutAction, string>

export interface WorkbenchKeymapConflict {
  actions: WorkbenchKeyboardShortcutAction[]
  shortcut: string
}

interface WorkbenchKeyboardEventLike {
  altKey: boolean
  ctrlKey: boolean
  key: string
  metaKey: boolean
  shiftKey: boolean
}

export const WORKBENCH_KEYMAP_CHANGED_EVENT = 'velaros:workbench-keymap-changed'

const STORAGE_KEY = 'velaros.workbench.keymap.v1'
const SUPPORTED_NAMED_SHORTCUT_KEYS = new Set([
  'Backspace',
  'Delete',
  'End',
  'Enter',
  'Escape',
  'Home',
  'PageDown',
  'PageUp',
  'Space',
  'Tab',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'ArrowUp',
])

export const WORKBENCH_KEYBOARD_SHORTCUT_DEFINITIONS: WorkbenchKeyboardShortcutDefinition[] = [
  { action: 'quick-open', defaultShortcut: 'Mod+P' },
  { action: 'reopen-closed-tab', defaultShortcut: 'Mod+Shift+T' },
  { action: 'save-current', defaultShortcut: 'Mod+S' },
  { action: 'save-all', defaultShortcut: 'Mod+Shift+S' },
  { action: 'run-last-command', defaultShortcut: 'Mod+Enter' },
  { action: 'toggle-problems', defaultShortcut: 'Mod+Shift+I' },
  { action: 'toggle-changes', defaultShortcut: 'Mod+Shift+G' },
  { action: 'toggle-actions', defaultShortcut: 'Mod+Shift+A' },
  { action: 'close-right-tool', defaultShortcut: 'Escape' },
]

export const DEFAULT_WORKBENCH_KEYBOARD_SHORTCUT_MAP =
  WORKBENCH_KEYBOARD_SHORTCUT_DEFINITIONS.reduce<WorkbenchKeyboardShortcutMap>(
    (map, definition) => ({
      ...map,
      [definition.action]: definition.defaultShortcut,
    }),
    {} as WorkbenchKeyboardShortcutMap
  )

/** 当前宿主平台串（renderer 里是 navigator.platform）；拿不到时按非 Apple 平台处理。 */
function currentWorkbenchPlatform(): string {
  return typeof navigator === 'undefined' ? '' : navigator.platform
}

/** Apple 平台上主修饰键 `Mod` 是 ⌘，Control 是另一颗键；其它平台上 `Mod` 就是 Ctrl。 */
export function isAppleWorkbenchPlatform(platform: string = currentWorkbenchPlatform()): boolean {
  return /Mac|iPhone|iPad/i.test(platform)
}

interface WorkbenchKeyboardTargetLike {
  isContentEditable?: boolean
  tagName?: string
}

/** 按键落在输入框、文本域或可编辑区（编辑器正文、富文本输入）里：这类按键先归那段文字。 */
export function isWorkbenchTextEntryTarget(target: Nullable<EventTarget>): boolean {
  if (!target) return false

  const element = target as WorkbenchKeyboardTargetLike
  const tagName = element.tagName?.toUpperCase()
  return tagName === 'INPUT' || tagName === 'TEXTAREA' || element.isContentEditable === true
}

/**
 * 把外部统一写法翻译为 tinykeys 的修饰键名，让 `parseKeybinding` 直接消费：`Mod` 按平台落到
 * `Meta`（Apple）或 `Control`，`Ctrl` 是字面的 Control 键。平台由调用方给出，不用 tinykeys 在模块
 * 加载时读到的那一份，测试才能在任何系统上按指定平台匹配。
 *
 * 单词边界匹配避免误伤 `"Modify"` / `"Mode"` 这类合法 key 名（虽然 keymap 不会出现，但保险起见）。
 */
function toTinykeysSyntax(shortcut: string, isApple: boolean): string {
  return shortcut.replace(/\bMod\b/g, isApple ? 'Meta' : 'Control').replace(/\bCtrl\b/g, 'Control')
}

const parsedShortcutCache = new Map<string, Nullable<KeyBindingPress>>()

function parseTinykeysShortcut(
  shortcut: string,
  platform: string = currentWorkbenchPlatform()
): Nullable<KeyBindingPress> {
  const isApple = isAppleWorkbenchPlatform(platform)
  const cacheKey = `${isApple ? 'apple' : 'other'}\u0000${shortcut}`
  if (parsedShortcutCache.has(cacheKey)) return toNullable(parsedShortcutCache.get(cacheKey))
  try {
    const presses = parseKeybinding(toTinykeysSyntax(shortcut, isApple))
    // 当前只支持单 press（"Mod+P"），不接受多键序列（"g g"）。
    if (presses.length !== 1) {
      parsedShortcutCache.set(cacheKey, null)
      return null
    }
    const press = presses[0]
    if (!press) {
      parsedShortcutCache.set(cacheKey, null)
      return null
    }
    const [, key] = press
    if (isString(key) && !isSupportedShortcutKey(normalizeShortcutKey(key))) {
      parsedShortcutCache.set(cacheKey, null)
      return null
    }
    parsedShortcutCache.set(cacheKey, press)
    return press
  } catch (error) {
    log.debug('快捷键解析失败', { shortcut, error })
    parsedShortcutCache.set(cacheKey, null)
    return null
  }
}

/**
 * 快捷键库内部用标准事件方法判断修饰键。
 * 真实键盘事件自带这个方法；测试用裸字段对象时缺这个方法，因此这里适配一层让两种调用都能走同一路径。
 */
function toMatchableEvent(event: WorkbenchKeyboardEventLike): KeyboardEvent {
  if (isFunction((event as Partial<KeyboardEvent>).getModifierState)) return event as KeyboardEvent

  const shim = {
    altKey: event.altKey,
    ctrlKey: event.ctrlKey,
    key: event.key,
    metaKey: event.metaKey,
    shiftKey: event.shiftKey,
    code: '',
    getModifierState(name: string): boolean {
      if (name === 'Alt' || name === 'AltGraph') return event.altKey
      switch (name) {
        case 'Control': {
          return event.ctrlKey
        }
        case 'Meta': {
          return event.metaKey
        }
        case 'Shift': {
          return event.shiftKey
        }
        default: {
          return false
        }
      }
    },
  }
  return shim as KeyboardEvent
}

function normalizeShortcutKey(key: string): string {
  const normalized = key.trim()
  if (!normalized) return ''

  const lower = normalized.toLowerCase()
  if (lower === ' ') return 'Space'

  if (lower === 'escape' || lower === 'esc') return 'Escape'

  if (lower === 'enter' || lower === 'return') return 'Enter'

  switch (lower) {
    case 'arrowup': {
      return 'ArrowUp'
    }
    case 'arrowdown': {
      return 'ArrowDown'
    }
    case 'arrowleft': {
      return 'ArrowLeft'
    }
    case 'arrowright': {
      return 'ArrowRight'
    }
  }

  if (/^f\d{1,2}$/i.test(normalized)) return normalized.toUpperCase()

  if (normalized.length === 1) return normalized.toUpperCase()

  return normalized[0].toUpperCase() + normalized.slice(1)
}

function isSupportedShortcutKey(key: string): boolean {
  if (key.length === 1) return true

  if (SUPPORTED_NAMED_SHORTCUT_KEYS.has(key)) return true

  const functionKeyMatch = /^F(\d{1,2})$/.exec(key)
  if (!functionKeyMatch) return false

  const functionKeyNumber = +functionKeyMatch[1]
  return functionKeyNumber >= 1 && functionKeyNumber <= 24
}

function shortcutMatchesEvent(
  shortcut: string,
  event: WorkbenchKeyboardEventLike,
  platform: string
): boolean {
  const press = parseTinykeysShortcut(shortcut, platform)
  if (!press) return false
  return matchKeyBindingPress(toMatchableEvent(event), press)
}

/**
 * 把一次按键录成快捷键写法。`Mod` 只代表各平台的主修饰键（Apple 的 ⌘、其它平台的 Ctrl）；
 * Apple 平台上的 Control 是另一颗键，录成 `Ctrl`——并进 `Mod` 的话，录下的 ⌃P 实际要按 ⌘P 才触发。
 * 其它平台上的 Win / Super 键同理录成 `Meta`。
 */
export function shortcutFromWorkbenchKeyboardEvent(
  event: WorkbenchKeyboardEventLike,
  platform: string = currentWorkbenchPlatform()
): Nullable<string> {
  const key = normalizeShortcutKey(event.key)
  if (
    !key ||
    !isSupportedShortcutKey(key) ||
    key === 'Alt' ||
    key === 'Control' ||
    key === 'Meta' ||
    key === 'Shift' ||
    key === 'Dead'
  ) return null

  const isApple = isAppleWorkbenchPlatform(platform)
  const parts: string[] = []
  if (isApple ? event.metaKey : event.ctrlKey) {
    parts.push('Mod')
  }
  if (isApple ? event.ctrlKey : event.metaKey) {
    parts.push(isApple ? 'Ctrl' : 'Meta')
  }
  if (event.altKey) {
    parts.push('Alt')
  }
  if (event.shiftKey) {
    parts.push('Shift')
  }
  parts.push(key)

  return parts.join('+')
}

export function formatWorkbenchShortcutForPlatform(
  shortcut: string,
  platform: string = currentWorkbenchPlatform()
): string {
  return shortcut.replace(/\bMod\b/g, isAppleWorkbenchPlatform(platform) ? 'Cmd' : 'Ctrl')
}

/** Apple 菜单的修饰键顺序与符号：⌃ ⌥ ⇧ ⌘。 */
const AppleShortcutModifierGlyphs: ReadonlyArray<readonly [string, string]> = [
  ['Ctrl', '⌃'],
  ['Alt', '⌥'],
  ['Shift', '⇧'],
  ['Mod', '⌘'],
  ['Meta', '⌘'],
]

const AppleShortcutKeyGlyphs: Readonly<Record<string, string>> = {
  ArrowDown: '↓',
  ArrowLeft: '←',
  ArrowRight: '→',
  ArrowUp: '↑',
  Backspace: '⌫',
  Delete: '⌦',
  Enter: '↩',
  Escape: 'Esc',
  Tab: '⇥',
}

/**
 * 界面上的快捷键提示（空编辑区、快速打开标题等）：按当前 keymap 与平台现算，不写死。
 * Apple 平台用菜单符号（`⌘⇧I`），其它平台用 `Ctrl+Shift+I`。
 */
export function formatWorkbenchShortcutHint(
  shortcut: string,
  platform: string = currentWorkbenchPlatform()
): string {
  const parts = shortcut.split(/\b\+/)
  const key = parts.pop() ?? ''
  const modifiers = new Set(parts)

  if (isAppleWorkbenchPlatform(platform)) {
    const glyphs = AppleShortcutModifierGlyphs.flatMap(([name, glyph]) =>
      modifiers.has(name) ? [glyph] : []
    )
    return [...new Set(glyphs)].join('') + (AppleShortcutKeyGlyphs[key] ?? key)
  }

  const metaLabel = /Win/i.test(platform) ? 'Win' : 'Super'
  const labels = [
    modifiers.has('Mod') || modifiers.has('Ctrl') ? 'Ctrl' : null,
    modifiers.has('Meta') ? metaLabel : null,
    modifiers.has('Alt') ? 'Alt' : null,
    modifiers.has('Shift') ? 'Shift' : null,
    key === 'Escape' ? 'Esc' : key,
  ]
  return labels.filter(isString).join('+')
}

export function normalizeWorkbenchKeyboardShortcutMap(
  map: Partial<WorkbenchKeyboardShortcutMap> | undefined
): WorkbenchKeyboardShortcutMap {
  return WORKBENCH_KEYBOARD_SHORTCUT_DEFINITIONS.reduce<WorkbenchKeyboardShortcutMap>(
    (result, definition) => {
      const shortcut = map?.[definition.action]
      result[definition.action] =
        isString(shortcut) && parseTinykeysShortcut(shortcut)
          ? shortcut
          : definition.defaultShortcut
      return result
    },
    {} as WorkbenchKeyboardShortcutMap
  )
}

export function buildWorkbenchKeymapConflicts(
  keymap: WorkbenchKeyboardShortcutMap
): WorkbenchKeymapConflict[] {
  const actionsByShortcut = new Map<string, WorkbenchKeyboardShortcutAction[]>()

  WORKBENCH_KEYBOARD_SHORTCUT_DEFINITIONS.forEach((definition) => {
    const shortcut = keymap[definition.action]
    const normalized = shortcut.trim().toLowerCase()
    if (!normalized) return

    actionsByShortcut.set(normalized, [
      ...(actionsByShortcut.get(normalized) ?? []),
      definition.action,
    ])
  })

  return [...actionsByShortcut.entries()]
    .filter(([, actions]) => actions.length > 1)
    .map(([shortcut, actions]) => ({ shortcut, actions }))
}

const workbenchKeyboardShortcutStore = createLocalStorageJsonStore<WorkbenchKeyboardShortcutMap>({
  key: STORAGE_KEY,
  fallback: DEFAULT_WORKBENCH_KEYBOARD_SHORTCUT_MAP,
  normalize: (value) =>
    normalizeWorkbenchKeyboardShortcutMap(value as Partial<WorkbenchKeyboardShortcutMap>),
  log,
  readErrorLevel: 'warn',
  readErrorMessage: '工作台快捷键配置读取失败',
  writeErrorMessage: '工作台快捷键配置写入失败',
})

export function readWorkbenchKeyboardShortcutMap(
  storage?: StorageLike
): WorkbenchKeyboardShortcutMap {
  return workbenchKeyboardShortcutStore.read(storage)
}

export function saveWorkbenchKeyboardShortcutMap(
  map: WorkbenchKeyboardShortcutMap,
  storage: StorageLike | undefined = undefined,
  target: Window = window
): void {
  const normalized = normalizeWorkbenchKeyboardShortcutMap(map)
  workbenchKeyboardShortcutStore.write(normalized, storage)
  target.dispatchEvent(
    new CustomEvent(WORKBENCH_KEYMAP_CHANGED_EVENT, {
      detail: normalized,
    })
  )
}

export function getWorkbenchKeyboardShortcut(
  event: WorkbenchKeyboardEventLike,
  keymap: WorkbenchKeyboardShortcutMap = DEFAULT_WORKBENCH_KEYBOARD_SHORTCUT_MAP,
  platform: string = currentWorkbenchPlatform()
): Nullable<WorkbenchKeyboardShortcutAction> {
  const action = WORKBENCH_KEYBOARD_SHORTCUT_DEFINITIONS.find((definition) =>
    shortcutMatchesEvent(keymap[definition.action], event, platform)
  )?.action

  return toNullable(action)
}
