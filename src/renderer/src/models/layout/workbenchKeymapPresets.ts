/**
 * 键位方案：设置里选一种，全局快捷键和编辑器里的按键一起跟着换。
 *
 *  - `workbench`：工作台自己的一套（默认），VS Code 与 JetBrains 的混合；
 *  - `vscode`：VS Code 的默认键位（Default Keyboard Shortcuts，macOS / Windows / Linux 各一份）；
 *  - `jetbrains`：IntelliJ 平台的默认键位（macOS 键位表，Windows / Linux 是 `$default`）；
 *  - `vim`：键位照 `workbench`，另在文件编辑器里加 Vim 的模式编辑。
 *
 * 表有两张：全局快捷键各方案的默认键在 `workbenchKeyboardShortcuts.ts`，编辑器命令的按键在
 * `models/editor/workbenchEditorKeymap.ts`。这里是两张表共用的：方案的名字、平台、各平台的键怎么取。
 */
import { isRecord, isString } from '@velaros-ai/velaros/core'

export type WorkbenchKeymapPresetId = 'workbench' | 'vscode' | 'jetbrains' | 'vim'

/** 设置里的排列顺序。 */
export const WORKBENCH_KEYMAP_PRESET_IDS: readonly WorkbenchKeymapPresetId[] = [
  'workbench',
  'vscode',
  'jetbrains',
  'vim',
]

export const DEFAULT_WORKBENCH_KEYMAP_PRESET: WorkbenchKeymapPresetId = 'workbench'

/** 存下来的方案名不认识（手改过、别的版本写的）就用默认的。 */
export function normalizeWorkbenchKeymapPreset(value: unknown): WorkbenchKeymapPresetId {
  return isString(value) && (WORKBENCH_KEYMAP_PRESET_IDS as readonly string[]).includes(value)
    ? (value as WorkbenchKeymapPresetId)
    : DEFAULT_WORKBENCH_KEYMAP_PRESET
}

/** 有自己的键位表的方案。 */
export type WorkbenchKeymapTablePresetId = Exclude<WorkbenchKeymapPresetId, 'vim'>

/** 这个方案的键位查哪张表：Vim 没有自己的表，用 Workbench 的。 */
export function resolveWorkbenchKeymapTablePreset(
  preset: WorkbenchKeymapPresetId
): WorkbenchKeymapTablePresetId {
  return preset === 'vim' ? 'workbench' : preset
}

/** 键位表分的三个平台。 */
export type WorkbenchKeymapPlatform = 'mac' | 'windows' | 'linux'

/** 当前宿主平台串（renderer 里是 navigator.platform）；拿不到时按非 Apple 平台处理。 */
export function currentWorkbenchPlatform(): string {
  return typeof navigator === 'undefined' ? '' : navigator.platform
}

/** Apple 平台上主修饰键 `Mod` 是 ⌘，Control 是另一颗键；其它平台上 `Mod` 就是 Ctrl。 */
export function isAppleWorkbenchPlatform(platform: string = currentWorkbenchPlatform()): boolean {
  return /Mac|iPhone|iPad/i.test(platform)
}

/** 平台串（`MacIntel`、`Win32`、`Linux x86_64`）归到键位表的三个平台里；认不出来的按 Linux。 */
export function resolveWorkbenchKeymapPlatform(
  platform: string = currentWorkbenchPlatform()
): WorkbenchKeymapPlatform {
  if (isAppleWorkbenchPlatform(platform)) return 'mac'
  return /Win/i.test(platform) ? 'windows' : 'linux'
}

/** 各平台不一样的键：`other` 是 Windows 与 Linux 共用的，两者不一样时另给 `linux`。 */
export interface WorkbenchPlatformKeys<T> {
  mac: T
  other: T
  linux?: T
}

/** 表里的一格：各平台都一样就直接写，不一样写成 `WorkbenchPlatformKeys`。 */
export type WorkbenchPresetKeys<T> = T | WorkbenchPlatformKeys<T>

function isWorkbenchPlatformKeys<T>(
  keys: WorkbenchPresetKeys<T>
): keys is WorkbenchPlatformKeys<T> {
  return isRecord(keys) && 'mac' in keys && 'other' in keys
}

export function pickWorkbenchPlatformKeys<T>(
  keys: WorkbenchPresetKeys<T>,
  platform: WorkbenchKeymapPlatform
): T {
  if (!isWorkbenchPlatformKeys(keys)) return keys
  if (platform === 'mac') return keys.mac
  return platform === 'linux' && keys.linux !== undefined ? keys.linux : keys.other
}
