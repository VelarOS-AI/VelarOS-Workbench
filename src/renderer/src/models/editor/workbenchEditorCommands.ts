/**
 * 编辑器里作用在光标处的命令：改代码的动作（快速修复、重构……）与跟着符号走的导航（查找引用……）。按键、
 * 右键菜单、命令面板都落到这里登记的命令上；命令怎么做在编辑器组件里。
 */
import { isAppleWorkbenchPlatform } from '../layout/workbenchKeyboardShortcuts'

/** 改代码的动作：只读的文件不给。 */
export type WorkbenchEditorCodeActionCommandId = 'organize-imports' | 'quick-fix' | 'refactor'

/** 跟着光标处的符号走的导航：不改代码，只读的文件也能用。 */
export type WorkbenchEditorNavigationCommandId = 'find-references'

export type WorkbenchEditorCommandId =
  | WorkbenchEditorCodeActionCommandId
  | WorkbenchEditorNavigationCommandId

export function isWorkbenchEditorNavigationCommand(
  command: WorkbenchEditorCommandId
): command is WorkbenchEditorNavigationCommandId {
  return command === 'find-references'
}

/** 页面（命令面板）交给编辑器去做的一次命令；每次序号加一，同一个命令连做两次也分得开。 */
export interface WorkbenchEditorCommandRequest {
  id: number
  command: WorkbenchEditorCommandId
}

/**
 * 一组按键。字符键同时认打出来的字（`key`）与物理键位（`code`）：macOS 上带 ⌥ 的组合打出来的是别的字符
 * （⇧⌥O 是 Ø），只能认键位；不带 ⌥ 的照打出来的字认，换了键盘布局也对。
 */
interface WorkbenchEditorKeyChord {
  code: string
  key?: string
  alt?: boolean
  ctrl?: boolean
  meta?: boolean
  shift?: boolean
}

interface WorkbenchEditorKeyBinding {
  command: WorkbenchEditorCommandId
  chords: (isApple: boolean) => readonly WorkbenchEditorKeyChord[]
}

/** 主修饰键：Apple 平台是 ⌘，其它平台是 Ctrl。 */
function mod(isApple: boolean): Pick<WorkbenchEditorKeyChord, 'ctrl' | 'meta'> {
  return isApple ? { meta: true } : { ctrl: true }
}

const WorkbenchEditorKeyBindings: readonly WorkbenchEditorKeyBinding[] = [
  // 快速修复：JetBrains 的 ⌥↩ / Alt+Enter，VS Code 的 ⌘. / Ctrl+.
  {
    command: 'quick-fix',
    chords: (isApple) => [
      { code: 'Enter', key: 'Enter', alt: true },
      { code: 'Period', key: '.', ...mod(isApple) },
    ],
  },
  // 重构：JetBrains 的 ⌃T；别的平台上 Ctrl+T 常被占着，用 Ctrl+Alt+Shift+T。
  {
    command: 'refactor',
    chords: (isApple) => [
      isApple
        ? { code: 'KeyT', key: 't', ctrl: true }
        : { code: 'KeyT', key: 't', ctrl: true, alt: true, shift: true },
    ],
  },
  // 整理 import：VS Code 的 ⇧⌥O / Shift+Alt+O。
  { command: 'organize-imports', chords: () => [{ code: 'KeyO', key: 'o', alt: true, shift: true }] },
  // 查找引用：VS Code 的 ⇧F12，JetBrains 的 ⌥F7 / Alt+F7。
  {
    command: 'find-references',
    chords: () => [
      { code: 'F12', key: 'F12', shift: true },
      { code: 'F7', key: 'F7', alt: true },
    ],
  },
]

export interface WorkbenchEditorKeyEventLike {
  key: string
  code: string
  altKey: boolean
  ctrlKey: boolean
  metaKey: boolean
  shiftKey: boolean
}

function chordMatches(chord: WorkbenchEditorKeyChord, event: WorkbenchEditorKeyEventLike): boolean {
  if (
    event.altKey !== !!chord.alt
    || event.ctrlKey !== !!chord.ctrl
    || event.metaKey !== !!chord.meta
    || event.shiftKey !== !!chord.shift
  ) return false
  // 带 ⌥ 的字符键只认键位：打出来的字随布局变。
  if (chord.alt && chord.key?.length === 1) return event.code === chord.code
  return event.code === chord.code || (!!chord.key && event.key.toLowerCase() === chord.key.toLowerCase())
}

/** 这次按键是不是编辑器的某个命令；不是返回 null。修饰键要一个不多、一个不少。 */
export function resolveWorkbenchEditorCommandFromKey(
  event: WorkbenchEditorKeyEventLike,
  platform?: string
): Nullable<WorkbenchEditorCommandId> {
  const isApple = isAppleWorkbenchPlatform(platform)
  for (const binding of WorkbenchEditorKeyBindings)
    if (binding.chords(isApple).some((chord) => chordMatches(chord, event))) return binding.command
  return null
}
