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
 *
 * 每个动作的默认键随键位方案变（见 `WorkbenchKeyboardShortcutPresets`）；用户自己改过的键叠在所选方案的
 * 默认键上面，存的是「方案 + 改过的那几项」。
 */

import { type KeyBindingPress, matchKeyBindingPress, parseKeybinding } from 'tinykeys'

import { isFunction, isRecord, isString, Log, toNullable } from '@velaros-ai/core'

import {
  createLocalStorageJsonStore,
  type StorageLike,
} from '../../persistence/localStorageJsonStore'

import {
  currentWorkbenchPlatform,
  DEFAULT_WORKBENCH_KEYMAP_PRESET,
  isAppleWorkbenchPlatform,
  normalizeWorkbenchKeymapPreset,
  pickWorkbenchPlatformKeys,
  resolveWorkbenchKeymapPlatform,
  resolveWorkbenchKeymapTablePreset,
  type WorkbenchKeymapPresetId,
  type WorkbenchKeymapTablePresetId,
  type WorkbenchPresetKeys,
} from './workbenchKeymapPresets'

export { isAppleWorkbenchPlatform } from './workbenchKeymapPresets'

const log = Log.tag('workbench-keyboard-shortcuts')

export type WorkbenchKeyboardShortcutAction =
  | 'close-right-tool'
  | 'command-palette'
  | 'debug-continue'
  | 'debug-step-into'
  | 'debug-step-out'
  | 'debug-step-over'
  | 'debug-stop'
  | 'find-in-files'
  | 'focus-left-editor-group'
  | 'focus-right-editor-group'
  | 'go-to-symbol'
  | 'navigate-back'
  | 'navigate-forward'
  | 'quick-open'
  | 'reopen-closed-tab'
  | 'run-last-command'
  | 'save-all'
  | 'save-current'
  | 'split-editor-right'
  | 'toggle-actions'
  | 'toggle-changes'
  | 'toggle-problems'

export interface WorkbenchKeyboardShortcutDefinition {
  action: WorkbenchKeyboardShortcutAction
  /** Workbench 方案在当前平台上的默认键。 */
  defaultShortcut: string
}

/** 每个动作现在用的键；空串表示这个动作没有键（所选方案里没给，用户也没录）。 */
export type WorkbenchKeyboardShortcutMap = Record<WorkbenchKeyboardShortcutAction, string>

/** 用户自己改过的键：只有与所选方案的默认键不一样的那几项。 */
export type WorkbenchKeyboardShortcutOverrides = Partial<WorkbenchKeyboardShortcutMap>

/** 存下来的键位设置：选的方案，加上用户自己改过的键。 */
export interface WorkbenchKeymapSettings {
  preset: WorkbenchKeymapPresetId
  overrides: WorkbenchKeyboardShortcutOverrides
}

export interface WorkbenchKeymapConflict {
  actions: WorkbenchKeyboardShortcutAction[]
  shortcut: string
}

interface WorkbenchKeyboardEventLike {
  altKey: boolean
  ctrlKey: boolean
  key: string
  /** 物理键位（`Minus`、`KeyP`）：`key` 随 ⇧、⌥ 变了的键靠它认。 */
  code?: string
  metaKey: boolean
  shiftKey: boolean
}

export const WORKBENCH_KEYMAP_CHANGED_EVENT = 'velaros:workbench-keymap-changed'

/** 键位设置存在这个键下（`{ preset, overrides }`）。以前的 `…keymap.v1` 存的是整张「动作 → 键」表，不再读。 */
export const WORKBENCH_KEYMAP_STORAGE_KEY = 'velaros.workbench.keymap.v2'

/** 按物理键位写的字母、数字键（`KeyS`、`Digit6`）：macOS 上按着 ⌥ 打出来的是别的字符（⌥S 是 ß），只能认键位。 */
const PhysicalShortcutKeyPattern = /^(?:Key[A-Z]|Digit\d)$/u

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
  // 按物理键认的减号（⌃⇧- 打出来是 _，只能认键位）。
  'Minus',
  // 按物理键认的反斜杠（中文输入法下这个键打出来是顿号）。
  'Backslash',
])

type WorkbenchKeyboardShortcutPreset = Record<
  WorkbenchKeyboardShortcutAction,
  WorkbenchPresetKeys<string>
>

/**
 * 各方案里每个动作的默认键（空串：这个方案里它没有键）。动作的先后就是设置里的排列顺序；一个键碰上两个
 * 动作时排在前面的先得。
 *
 * VS Code、JetBrains 两张表照它们自己的默认键位抄。对不上的几种情况都留着 Workbench 的键，并在那一行写明：
 *  - 那个 IDE 里没有对应的动作，或者对应的动作没有默认键；
 *  - 它的键在这里按不到——应用菜单占着（菜单的键不去盖）、要连按两下或者分两步按；
 *  - 它的键在这个方案里已经给了别的动作（写明给了谁）。
 */
const WorkbenchKeyboardShortcutPresets: Record<
  WorkbenchKeymapTablePresetId,
  WorkbenchKeyboardShortcutPreset
> = {
  workbench: {
    'quick-open': 'Mod+P',
    // 命令面板与 VS Code 一致：⇧⌘P / Ctrl+Shift+P。
    'command-palette': 'Mod+Shift+P',
    // 转到文件中的符号（快速打开的 `@` 模式），与 VS Code 一致：⇧⌘O，其它平台 Ctrl+Shift+O。
    'go-to-symbol': 'Mod+Shift+O',
    // 在项目里搜索（侧栏的搜索面板），与 VS Code 一致：⇧⌘F，其它平台 Ctrl+Shift+F。
    'find-in-files': 'Mod+Shift+F',
    // 后退 / 前进与 VS Code 一致：macOS 上 ⌃- / ⌃⇧-（按物理键认，⇧- 打出来是 _），其它平台 Alt+← / Alt+→。
    'navigate-back': { mac: 'Ctrl+Minus', other: 'Alt+ArrowLeft' },
    'navigate-forward': { mac: 'Ctrl+Shift+Minus', other: 'Alt+ArrowRight' },
    'reopen-closed-tab': 'Mod+Shift+T',
    // 把当前标签挪到右边那组（没有就新开），与 VS Code 拆分编辑器同一个键：⌘\ / Ctrl+\。
    'split-editor-right': 'Mod+Backslash',
    // 编辑区并排两组时把焦点放到左边 / 右边那组，与 VS Code 一致：⌘1 / ⌘2，其它平台 Ctrl+1 / Ctrl+2。
    'focus-left-editor-group': 'Mod+1',
    'focus-right-editor-group': 'Mod+2',
    'save-current': 'Mod+S',
    'save-all': 'Mod+Shift+S',
    'run-last-command': 'Mod+Enter',
    // 调试的控制键，与 Chrome 开发者工具、VS Code 同一组。只在调试中生效（见 useWorkbenchDebugShortcuts）：
    // 没在调试时 F8 仍是编辑器里的「下一个问题」，F11 仍归系统与菜单。
    'debug-continue': 'F8',
    'debug-step-over': 'F10',
    'debug-step-into': 'F11',
    'debug-step-out': 'Shift+F11',
    'debug-stop': 'Shift+F5',
    'toggle-problems': 'Mod+Shift+I',
    'toggle-changes': 'Mod+Shift+G',
    'toggle-actions': 'Mod+Shift+A',
    'close-right-tool': 'Escape',
  },
  vscode: {
    'quick-open': 'Mod+P',
    'command-palette': 'Mod+Shift+P',
    'go-to-symbol': 'Mod+Shift+O',
    'find-in-files': 'Mod+Shift+F',
    // macOS 上 ⌃- / ⌃⇧-，Windows 上 Alt+← / Alt+→，Linux 上 Ctrl+Alt+- / Ctrl+Shift+-。
    'navigate-back': { mac: 'Ctrl+Minus', other: 'Alt+ArrowLeft', linux: 'Mod+Alt+Minus' },
    'navigate-forward': {
      mac: 'Ctrl+Shift+Minus',
      other: 'Alt+ArrowRight',
      linux: 'Mod+Shift+Minus',
    },
    'reopen-closed-tab': 'Mod+Shift+T',
    'split-editor-right': 'Mod+Backslash',
    'focus-left-editor-group': 'Mod+1',
    'focus-right-editor-group': 'Mod+2',
    'save-current': 'Mod+S',
    // macOS 上 ⌥⌘S（按物理键认）。Windows 上是分两步按的 Ctrl+K S，Linux 上没有默认键：留 Workbench 的。
    'save-all': { mac: 'Mod+Alt+KeyS', other: 'Mod+Shift+S' },
    // VS Code 里「重新运行上一个任务」没有默认键：留 Workbench 的。
    'run-last-command': 'Mod+Enter',
    // 继续是 F5；单步与结束和 Workbench 相同。
    'debug-continue': 'F5',
    'debug-step-over': 'F10',
    'debug-step-into': 'F11',
    'debug-step-out': 'Shift+F11',
    'debug-stop': 'Shift+F5',
    // 「问题」面板 ⇧⌘M / Ctrl+Shift+M。
    'toggle-problems': 'Mod+Shift+M',
    // 「源代码管理」：macOS 上是 ⌃⇧G（Control，不是 ⌘），其它平台 Ctrl+Shift+G。
    'toggle-changes': { mac: 'Ctrl+Shift+G', other: 'Mod+Shift+G' },
    // 聊天：⌃⌘I / Ctrl+Alt+I。
    'toggle-actions': { mac: 'Mod+Ctrl+I', other: 'Mod+Alt+I' },
    // 没有对应的键（VS Code 里 Esc 各管各的浮层）：留 Workbench 的。
    'close-right-tool': 'Escape',
  },
  jetbrains: {
    // 「转到文件」：macOS 上 ⇧⌘O。Windows / Linux 上是 Ctrl+Shift+N——应用菜单的「新建项目」占着，留 Workbench
    // 的 Ctrl+P。（「随处搜索」要连按两下 Shift，这里按不出来。）
    'quick-open': { mac: 'Mod+Shift+O', other: 'Mod+P' },
    // 「查找操作」⇧⌘A / Ctrl+Shift+A。这个键在 Workbench 里是 AI 聊天，见下面的 `toggle-actions`。
    'command-palette': 'Mod+Shift+A',
    // 「文件结构」⌘F12 / Ctrl+F12。
    'go-to-symbol': 'Mod+F12',
    // 「在文件中查找」⇧⌘F / Ctrl+Shift+F。
    'find-in-files': 'Mod+Shift+F',
    // 后退 / 前进：macOS 上 ⌘[ / ⌘]，Windows / Linux 上 Ctrl+Alt+← / Ctrl+Alt+→。
    'navigate-back': { mac: 'Mod+[', other: 'Mod+Alt+ArrowLeft' },
    'navigate-forward': { mac: 'Mod+]', other: 'Mod+Alt+ArrowRight' },
    // 重新打开关闭的标签、拆分、在两组之间换焦点：默认键位里都没有键，留 Workbench 的。
    'reopen-closed-tab': 'Mod+Shift+T',
    'split-editor-right': 'Mod+Backslash',
    'focus-left-editor-group': 'Mod+1',
    'focus-right-editor-group': 'Mod+2',
    // ⌘S / Ctrl+S 在 JetBrains 里是「全部保存」，它没有只存当前文件的键。这里 ⌘S 仍是存当前文件（编辑器里
    // 同一个键带着「保存时格式化」），全部保存留 Workbench 的键。
    'save-current': 'Mod+S',
    'save-all': 'Mod+Shift+S',
    // 「重新运行」：Windows / Linux 上 Ctrl+F5。macOS 上是 ⌘R——应用菜单的「重新加载」占着，留 Workbench 的。
    'run-last-command': { mac: 'Mod+Enter', other: 'Mod+F5' },
    // 恢复程序 F9、步过 F8、步入 F7、步出 ⇧F8、停止 ⌘F2 / Ctrl+F2。
    'debug-continue': 'F9',
    'debug-step-over': 'F8',
    'debug-step-into': 'F7',
    'debug-step-out': 'Shift+F8',
    'debug-stop': 'Mod+F2',
    // 「问题」工具窗 ⌘6 / Alt+6，「Git」工具窗 ⌘9 / Alt+9。
    'toggle-problems': { mac: 'Mod+6', other: 'Alt+6' },
    'toggle-changes': { mac: 'Mod+9', other: 'Alt+9' },
    // JetBrains 里没有对应的键，而 Workbench 的 ⇧⌘A / Ctrl+Shift+A 在这个方案里给了「查找操作」：不给键
    // （要用就在设置里自己录一个）。
    'toggle-actions': '',
    // 没有对应的键（JetBrains 里 Esc 是把焦点放回编辑器）：留 Workbench 的。
    'close-right-tool': 'Escape',
  },
}

const WorkbenchKeyboardShortcutActions = Object.keys(
  WorkbenchKeyboardShortcutPresets.workbench
) as WorkbenchKeyboardShortcutAction[]

const presetShortcutMaps = new Map<string, WorkbenchKeyboardShortcutMap>()

/** 这个方案在这个平台上各动作的默认键（Vim 方案用 Workbench 的）。 */
export function getWorkbenchKeymapPresetShortcuts(
  preset: WorkbenchKeymapPresetId,
  platform: string = currentWorkbenchPlatform()
): WorkbenchKeyboardShortcutMap {
  const tablePreset = resolveWorkbenchKeymapTablePreset(preset)
  const keymapPlatform = resolveWorkbenchKeymapPlatform(platform)
  const cacheKey = `${tablePreset}:${keymapPlatform}`
  let shortcuts = presetShortcutMaps.get(cacheKey)
  if (!shortcuts) {
    const table = WorkbenchKeyboardShortcutPresets[tablePreset]
    shortcuts = Object.fromEntries(
      WorkbenchKeyboardShortcutActions.map((action) => [
        action,
        pickWorkbenchPlatformKeys(table[action], keymapPlatform),
      ])
    ) as WorkbenchKeyboardShortcutMap
    presetShortcutMaps.set(cacheKey, shortcuts)
  }
  return shortcuts
}

/** Workbench 方案在当前平台上的默认键位。 */
export const DEFAULT_WORKBENCH_KEYBOARD_SHORTCUT_MAP = getWorkbenchKeymapPresetShortcuts(
  DEFAULT_WORKBENCH_KEYMAP_PRESET
)

export const WORKBENCH_KEYBOARD_SHORTCUT_DEFINITIONS: WorkbenchKeyboardShortcutDefinition[] =
  WorkbenchKeyboardShortcutActions.map((action) => ({
    action,
    defaultShortcut: DEFAULT_WORKBENCH_KEYBOARD_SHORTCUT_MAP[action],
  }))

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
    code: event.code ?? '',
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

  if (SUPPORTED_NAMED_SHORTCUT_KEYS.has(key) || PhysicalShortcutKeyPattern.test(key)) return true

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
 *
 * Apple 平台上按着 ⌥ 的字母、数字键打出来的是别的字符（⌥S 是 ß）：录物理键位（`KeyS`），按的时候也按键位认。
 */
export function shortcutFromWorkbenchKeyboardEvent(
  event: WorkbenchKeyboardEventLike,
  platform: string = currentWorkbenchPlatform()
): Nullable<string> {
  const isApple = isAppleWorkbenchPlatform(platform)
  const physicalKey =
    isApple && event.altKey && event.code && PhysicalShortcutKeyPattern.test(event.code)
      ? event.code
      : null
  const key = physicalKey ?? normalizeShortcutKey(event.key)
  if (
    !key ||
    !isSupportedShortcutKey(key) ||
    key === 'Alt' ||
    key === 'Control' ||
    key === 'Meta' ||
    key === 'Shift' ||
    key === 'Dead'
  ) return null

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

/** 按物理键位写的键（`Minus`、`KeyS`）显示成键帽上的字。 */
function physicalShortcutKeyLabel(key: string): string {
  if (key === 'Minus') return '-'
  if (key === 'Backslash') return '\\'
  return PhysicalShortcutKeyPattern.test(key) ? key.slice(-1) : key
}

/** 设置里录制按钮上的写法：`Cmd+Shift+P` / `Ctrl+Shift+P`。 */
export function formatWorkbenchShortcutForPlatform(
  shortcut: string,
  platform: string = currentWorkbenchPlatform()
): string {
  const parts = shortcut.split(/\b\+/)
  const key = physicalShortcutKeyLabel(parts.pop() ?? '')
  const primary = isAppleWorkbenchPlatform(platform) ? 'Cmd' : 'Ctrl'
  return [...parts.map((part) => (part === 'Mod' ? primary : part)), key].join('+')
}

/** Apple 菜单的修饰键顺序与符号：⌃ ⌥ ⇧ ⌘。 */
const AppleShortcutModifierGlyphs: ReadonlyArray<readonly [string, string]> = [
  ['Ctrl', '⌃'],
  ['Alt', '⌥'],
  ['Shift', '⇧'],
  ['Mod', '⌘'],
  ['Meta', '⌘'],
]

const ArrowShortcutKeyGlyphs: Readonly<Record<string, string>> = {
  ArrowDown: '↓',
  ArrowLeft: '←',
  ArrowRight: '→',
  ArrowUp: '↑',
}

const AppleShortcutKeyGlyphs: Readonly<Record<string, string>> = {
  ...ArrowShortcutKeyGlyphs,
  Backspace: '⌫',
  Delete: '⌦',
  Enter: '↩',
  Escape: 'Esc',
  Tab: '⇥',
}

/**
 * 界面上的快捷键提示（空编辑区、快速打开标题等）：按当前 keymap 与平台现算，不写死。
 * Apple 平台用菜单符号（`⌘⇧I`），其它平台用 `Ctrl+Shift+I`。没有键（空串）返回空串。
 */
export function formatWorkbenchShortcutHint(
  shortcut: string,
  platform: string = currentWorkbenchPlatform()
): string {
  const parts = shortcut.split(/\b\+/)
  const key = physicalShortcutKeyLabel(parts.pop() ?? '')
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
    key === 'Escape' ? 'Esc' : (ArrowShortcutKeyGlyphs[key] ?? key),
  ]
  return labels.filter(isString).join('+')
}

/**
 * 读出来的键位设置逐项校验：方案名不认识就用默认方案；改过的键里动作不认识的、不是字符串的、解析不了的都
 * 丢掉（那个动作用所选方案的默认键）。别的形状——包括以前存的整张「动作 → 键」表——读出来就是默认设置，
 * 不做换算。
 */
export function normalizeWorkbenchKeymapSettings(value: unknown): WorkbenchKeymapSettings {
  const stored = isRecord(value) ? value : {}
  const storedOverrides = isRecord(stored.overrides) ? stored.overrides : {}
  const overrides: WorkbenchKeyboardShortcutOverrides = {}
  for (const action of WorkbenchKeyboardShortcutActions) {
    const shortcut = storedOverrides[action]
    if (isString(shortcut) && parseTinykeysShortcut(shortcut)) overrides[action] = shortcut
  }
  return { preset: normalizeWorkbenchKeymapPreset(stored.preset), overrides }
}

/** 此刻生效的键位：所选方案的默认键，叠上用户自己改过的那几项。 */
export function resolveWorkbenchKeyboardShortcutMap(
  settings: WorkbenchKeymapSettings,
  platform: string = currentWorkbenchPlatform()
): WorkbenchKeyboardShortcutMap {
  return { ...getWorkbenchKeymapPresetShortcuts(settings.preset, platform), ...settings.overrides }
}

/**
 * 给一个动作换键。与所选方案的默认键一样就不记（它以后跟着方案走）；解析不了的键不收，设置原样返回。
 */
export function setWorkbenchKeymapShortcut(
  settings: WorkbenchKeymapSettings,
  action: WorkbenchKeyboardShortcutAction,
  shortcut: string,
  platform: string = currentWorkbenchPlatform()
): WorkbenchKeymapSettings {
  if (!parseTinykeysShortcut(shortcut, platform)) return settings

  const overrides = { ...settings.overrides }
  if (shortcut === getWorkbenchKeymapPresetShortcuts(settings.preset, platform)[action])
    delete overrides[action]
  else overrides[action] = shortcut
  return { preset: settings.preset, overrides }
}

/** 一个动作回到所选方案的默认键。 */
export function resetWorkbenchKeymapShortcut(
  settings: WorkbenchKeymapSettings,
  action: WorkbenchKeyboardShortcutAction
): WorkbenchKeymapSettings {
  const overrides = { ...settings.overrides }
  delete overrides[action]
  return { preset: settings.preset, overrides }
}

/** 同一个键给了两个动作的地方（没有键的动作不算）。按此刻生效的键位查，所以跟着所选方案走。 */
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

export const DEFAULT_WORKBENCH_KEYMAP_SETTINGS: WorkbenchKeymapSettings = {
  preset: DEFAULT_WORKBENCH_KEYMAP_PRESET,
  overrides: {},
}

const workbenchKeymapSettingsStore = createLocalStorageJsonStore<WorkbenchKeymapSettings>({
  key: WORKBENCH_KEYMAP_STORAGE_KEY,
  fallback: DEFAULT_WORKBENCH_KEYMAP_SETTINGS,
  normalize: normalizeWorkbenchKeymapSettings,
  log,
  readErrorLevel: 'warn',
  readErrorMessage: '工作台快捷键配置读取失败',
  writeErrorMessage: '工作台快捷键配置写入失败',
})

export function readWorkbenchKeymapSettings(storage?: StorageLike): WorkbenchKeymapSettings {
  return workbenchKeymapSettingsStore.read(storage)
}

export function saveWorkbenchKeymapSettings(
  settings: WorkbenchKeymapSettings,
  storage: StorageLike | undefined = undefined,
  target: Window = window
): void {
  const normalized = normalizeWorkbenchKeymapSettings(settings)
  workbenchKeymapSettingsStore.write(normalized, storage)
  target.dispatchEvent(
    new CustomEvent(WORKBENCH_KEYMAP_CHANGED_EVENT, {
      detail: normalized,
    })
  )
}

/** 此刻生效的键位（读存储）。 */
export function readWorkbenchKeyboardShortcutMap(
  storage?: StorageLike
): WorkbenchKeyboardShortcutMap {
  return resolveWorkbenchKeyboardShortcutMap(readWorkbenchKeymapSettings(storage))
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
