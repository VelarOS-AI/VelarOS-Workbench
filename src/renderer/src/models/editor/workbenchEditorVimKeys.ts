/**
 * Vim 键位方案下，一次按键归 Vim 还是归工作台（全局快捷键、编辑器命令、应用菜单）。
 *
 * Vim 那一层排在编辑器所有按键处理的最前面，它拿走的键别人就收不到了，所以归属在这里定，是有意的选择：
 *
 *  1. 不带 Ctrl / Alt / ⌘ 的键（字母、数字、Esc、回车、方向键、F 键……）都先给 Vim——模式编辑靠的就是它们。
 *  2. 设置里那张全局快捷键表上的键（带修饰键的）任何模式下都归工作台：那张表用户看得见、改得了，录了什么就是
 *     什么。默认键里与 Vim 撞的只有 Windows / Linux 上的 Ctrl+P（快速打开；Vim 里它是「上移」，`k` 一样）。
 *  3. 其余的，Vim 在当前模式下有命令的键归 Vim（`WorkbenchVimNormalModeKeys` / `WorkbenchVimInsertModeKeys`）。
 *     Windows / Linux 上这些正是工作台的 Ctrl 键，所以在普通模式、可视模式里：Ctrl+A（全选）、Ctrl+F（查找）、
 *     Ctrl+D（选中下一处相同的文字）、Ctrl+I 与 Ctrl+Space（触发补全）、Ctrl+U（撤销选区变化）、Ctrl+Y（重做）、
 *     Ctrl+[（减少缩进）、Ctrl+C / Ctrl+X / Ctrl+V（复制、剪切、粘贴），以及应用菜单的 Ctrl+O（打开项目）、
 *     Ctrl+R（重新加载）都做的是 Vim 的事。插入模式里只有 Vim 的那几个插入键归它，别的照常。Ctrl+D、Ctrl+U
 *     两种模式里都是 Vim 的，所以「选中下一处相同的文字」「撤销选区变化」在 Windows / Linux 的 Vim 方案下没有
 *     键可按（测试里列着）。
 *  4. 再其余的，是编辑器命令的键就归编辑器命令。要专门放行是因为 macOS 上普通模式会把没用到的 ⌥+字符吞掉
 *     （它们本来会打出一个字符）——⌥Z 切换自动换行、⇧⌥A 块注释这些就按不到了。
 *  5. Ctrl+W：这个 Vim 的普通模式拿它当窗口命令的前缀，但这里没有窗口命令，按了什么也不做。Windows / Linux 上
 *     它是应用菜单的「关闭编辑器」，所以普通模式、可视模式里放给菜单（和别处一样关标签）；插入模式里它是 Vim 的
 *     「删除前一个词」，归 Vim。macOS 上 ⌃W 不是菜单的键，留给 Vim（什么也不做）。
 *
 * macOS 上工作台的键用 ⌘，与 Vim 的 Ctrl 键不撞，受影响的只有第 4 条那些键和插入模式里的 ⌃T（重构，Vim 是缩进）。
 */
import {
  getWorkbenchKeyboardShortcut,
  type WorkbenchKeyboardShortcutMap,
} from '../layout/workbenchKeyboardShortcuts'
import { isAppleWorkbenchPlatform } from '../layout/workbenchKeymapPresets'

import {
  resolveWorkbenchEditorKeymapCommand,
  type WorkbenchEditorKeyEventLike,
} from './workbenchEditorKeymapResolver'

/** 按键处理分的三种情形：替换模式算插入模式。 */
export type WorkbenchVimKeyContext = 'normal' | 'visual' | 'insert'

/**
 * Vim（`@replit/codemirror-vim-core` 的默认键位表）在普通模式、可视模式里有命令的带 Ctrl 的键，Vim 的写法。
 * 测试把这张表与包里的键位表对着钉：升级包之后对不上就是这里要跟着改。
 */
export const WorkbenchVimNormalModeKeys: readonly string[] = [
  '<C-a>', // 数字加一
  '<C-b>', // 上翻一页
  '<C-c>', // 回到普通模式（Windows / Linux 上选中了文字时是复制）
  '<C-d>', // 下翻半页
  '<C-e>', // 向下滚一行
  '<C-f>', // 下翻一页
  '<C-i>', // 跳转表：前进
  '<C-n>', // 下移
  '<C-o>', // 跳转表：后退
  '<C-p>', // 上移
  '<C-q>', // 按块选择
  '<C-r>', // 重做
  '<C-u>', // 上翻半页
  '<C-v>', // 按块选择
  '<C-x>', // 数字减一
  '<C-y>', // 向上滚一行
  '<C-[>', // 同 Esc
  '<C-Esc>', // 同 Esc
  '<C-Space>', // 下一个词（同 W）
  '<C-BS>', // 上一个词（同 B）
]

/** 普通模式里 Vim 吞掉、但什么也不做的键（窗口命令的前缀）。 */
export const WorkbenchVimNormalModeIdleKey = '<C-w>'

/** Vim 在插入模式里有命令的带 Ctrl 的键。 */
export const WorkbenchVimInsertModeKeys: readonly string[] = [
  '<C-c>', // 回到普通模式（Windows / Linux 上选中了文字时是复制）
  '<C-d>', // 减少缩进
  '<C-o>', // 执行一条普通模式命令
  '<C-r>', // 插入寄存器里的内容
  '<C-t>', // 增加缩进
  '<C-u>', // 删到行首
  '<C-w>', // 删除前一个词
  '<C-[>', // 同 Esc
  '<C-Esc>', // 同 Esc
]

const NormalModeKeys = new Set(WorkbenchVimNormalModeKeys)
const InsertModeKeys = new Set(WorkbenchVimInsertModeKeys)

export interface WorkbenchVimKeyOwnerInput {
  /** Vim 给这次按键起的名字（`<C-d>`、`<A-z>`、`j`）。 */
  vimKey: string
  event: WorkbenchEditorKeyEventLike
  context: WorkbenchVimKeyContext
  /** 此刻生效的全局快捷键（Vim 方案的默认键叠上用户改过的）。 */
  keymap: WorkbenchKeyboardShortcutMap
  /** 平台串（`navigator.platform`）。 */
  platform: string
}

/** 这次按键给不给 Vim；不给的话 Vim 当它没按过，由编辑器命令、全局快捷键、应用菜单去接。 */
export function shouldWorkbenchVimHandleKey({
  vimKey,
  event,
  context,
  keymap,
  platform,
}: WorkbenchVimKeyOwnerInput): boolean {
  if (!event.ctrlKey && !event.altKey && !event.metaKey) return true
  if (getWorkbenchKeyboardShortcut(event, keymap, platform)) return false
  if ((context === 'insert' ? InsertModeKeys : NormalModeKeys).has(vimKey)) return true
  if (resolveWorkbenchEditorKeymapCommand(event, platform, 'vim')) return false
  if (vimKey === WorkbenchVimNormalModeIdleKey && context !== 'insert')
    return isAppleWorkbenchPlatform(platform)
  return true
}
