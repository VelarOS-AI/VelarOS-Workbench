/**
 * 编辑器命令的键位表：每个有按键的编辑器命令在各键位方案、各平台上是哪几组键，以及一次按键是哪个命令。
 *
 * 这里只有表和查表（不引 CodeMirror）：编辑器按它分发按键（`workbenchCodeMirrorEditorCommands.ts`），命令面板、
 * 右键菜单、设置按它显示提示。方向键、Home / End、回车、退格、全选这些各家都一样的标准键不在表里，仍由
 * CodeMirror 的 `standardKeymap` 管；补全列表、行内建议开着时用的键（↑ ↓、回车、Tab、Esc）也不在表里。
 *
 * 写法与全局快捷键一样：`Mod+Shift+L`，`Mod` 在 macOS 上是 ⌘、别处是 Ctrl，`Ctrl` 是字面的 Control。字符键写
 * 美式键盘上不按 Shift 的那个字符（`Mod+Shift+[`，不写 `{`）。一个命令的第一组键是界面上提示的那一组。
 *
 * 一个方案里同一组键只归一个命令；与全局快捷键同键的只有 `WorkbenchEditorKeymapSharedChords` 列的那几处。
 */
import { formatWorkbenchShortcutHint } from '../layout/workbenchKeyboardShortcuts'
import {
  currentWorkbenchPlatform,
  DEFAULT_WORKBENCH_KEYMAP_PRESET,
  pickWorkbenchPlatformKeys,
  resolveWorkbenchKeymapPlatform,
  resolveWorkbenchKeymapTablePreset,
  type WorkbenchKeymapPlatform,
  type WorkbenchKeymapPresetId,
  type WorkbenchKeymapTablePresetId,
  type WorkbenchPresetKeys,
} from '../layout/workbenchKeymapPresets'

/** 有按键的编辑器命令，按设置里的排列顺序：代码、查找与跳转、编辑、选区与光标、折叠与显示。 */
export const WORKBENCH_EDITOR_KEYMAP_COMMANDS = [
  'go-to-definition',
  'find-references',
  'call-hierarchy',
  'rename-symbol',
  'quick-fix',
  'refactor',
  'organize-imports',
  'format-document',
  'trigger-completion',
  'next-problem',
  'previous-problem',
  'open-lint-panel',
  'find',
  'replace',
  'find-next',
  'find-previous',
  'go-to-line',
  'navigate-back',
  'navigate-forward',
  'save',
  'toggle-line-comment',
  'toggle-block-comment',
  'indent-more',
  'indent-less',
  'reindent-selection',
  'move-line-up',
  'move-line-down',
  'copy-line-up',
  'copy-line-down',
  'delete-line',
  'insert-blank-line',
  'undo',
  'redo',
  'select-next-occurrence',
  'select-all-occurrences',
  'select-line',
  'expand-selection',
  'add-cursor-above',
  'add-cursor-below',
  'undo-selection',
  'redo-selection',
  'jump-to-bracket',
  'cursor-syntax-left',
  'cursor-syntax-right',
  'select-syntax-left',
  'select-syntax-right',
  'fold',
  'unfold',
  'fold-all',
  'unfold-all',
  'toggle-word-wrap',
  'toggle-tab-focus-mode',
  'cancel',
] as const

export type WorkbenchEditorKeymapCommandId = (typeof WORKBENCH_EDITOR_KEYMAP_COMMANDS)[number]

/** 一个命令的几组键；空数组就是这个方案（这个平台）上它没有键。 */
type WorkbenchEditorKeymapTable = Record<
  WorkbenchEditorKeymapCommandId,
  WorkbenchPresetKeys<readonly string[]>
>

/**
 * Workbench 方案：编辑器一直以来的键——VS Code 与 JetBrains 的混合，外加 CodeMirror 自带的那几条。
 * `tests/workbench-editor-keymap-pin.test.ts` 里钉着改成键位方案之前的那张表，这一张要与它逐键一致。
 */
const WorkbenchEditorKeys: WorkbenchEditorKeymapTable = {
  'go-to-definition': ['F12'],
  // 查找引用：VS Code 的 ⇧F12，JetBrains 的 ⌥F7 / Alt+F7。
  'find-references': ['Shift+F12', 'Alt+F7'],
  // 调用层次：JetBrains 的 ⌃⌥H / Ctrl+Alt+H。
  'call-hierarchy': ['Ctrl+Alt+H'],
  'rename-symbol': ['Shift+F6'],
  // 快速修复：JetBrains 的 ⌥↩ / Alt+Enter，VS Code 的 ⌘. / Ctrl+.
  'quick-fix': ['Alt+Enter', 'Mod+.'],
  // 重构：JetBrains 的 ⌃T；别的平台上 Ctrl+T 常被占着，用 Ctrl+Alt+Shift+T。
  refactor: { mac: ['Ctrl+T'], other: ['Ctrl+Alt+Shift+T'] },
  // 整理 import：VS Code 的 ⇧⌥O / Shift+Alt+O。
  'organize-imports': ['Shift+Alt+O'],
  'format-document': ['Mod+Alt+L'],
  // ⌘Space 是系统的聚焦搜索，按不到；补全用 ⌘I（VS Code 的另一个键）或 ⌃Space（CodeMirror 自带）。
  'trigger-completion': ['Mod+I', 'Ctrl+Space'],
  'next-problem': ['F8'],
  'previous-problem': [],
  // 编辑器底部的诊断列表（CodeMirror 自带的那个面板）。
  'open-lint-panel': ['Mod+Shift+M'],
  find: ['Mod+F'],
  // 查找并替换：macOS 上 ⌥⌘F（⌘H 是系统的隐藏窗口），其它平台 Ctrl+H，与 VS Code 一致。
  replace: { mac: ['Mod+Alt+F'], other: ['Mod+H'] },
  // 查找下一处：各平台 F3（⇧F3 上一处），macOS 上还有 ⌘G。⇧⌘G 不占：它是打开 Git 面板的全局快捷键。
  'find-next': { mac: ['F3', 'Mod+G'], other: ['F3'] },
  'find-previous': ['Shift+F3'],
  // 跳到行：各平台 Ctrl+G（macOS 上是 ⌃G，⌘G 留给查找下一处），外加 JetBrains 的 ⌘L / Ctrl+L。
  'go-to-line': ['Ctrl+G', 'Mod+L'],
  // Windows / Linux 上的 Alt+← / Alt+→。macOS 上的后退 / 前进是 ⌃- / ⌃⇧-，编辑器不占，交给全局快捷键。
  'navigate-back': { mac: [], other: ['Alt+ArrowLeft'] },
  'navigate-forward': { mac: [], other: ['Alt+ArrowRight'] },
  save: ['Mod+S'],
  'toggle-line-comment': ['Mod+/'],
  'toggle-block-comment': ['Shift+Alt+A'],
  'indent-more': ['Mod+]', 'Tab'],
  'indent-less': ['Mod+[', 'Shift+Tab'],
  'reindent-selection': ['Mod+Alt+\\'],
  'move-line-up': ['Alt+ArrowUp'],
  'move-line-down': ['Alt+ArrowDown'],
  'copy-line-up': ['Shift+Alt+ArrowUp'],
  'copy-line-down': ['Shift+Alt+ArrowDown'],
  'delete-line': ['Mod+Shift+K'],
  'insert-blank-line': ['Mod+Enter'],
  undo: ['Mod+Z'],
  redo: { mac: ['Mod+Shift+Z'], other: ['Mod+Y'], linux: ['Mod+Y', 'Mod+Shift+Z'] },
  'select-next-occurrence': ['Mod+D'],
  // 选中了字：选中全部一样的文字；光标停在一个符号上：选中它在这个文件里的全部出现。
  'select-all-occurrences': ['Mod+Shift+L'],
  'select-line': { mac: ['Ctrl+L'], other: ['Alt+L'] },
  // 没有键：CodeMirror 给它的 Mod-i 一直被触发补全占着。
  'expand-selection': [],
  'add-cursor-above': ['Mod+Alt+ArrowUp'],
  'add-cursor-below': ['Mod+Alt+ArrowDown'],
  'undo-selection': ['Mod+U'],
  'redo-selection': { mac: ['Mod+Shift+U'], other: ['Alt+U'] },
  'jump-to-bracket': ['Mod+Shift+\\'],
  // Windows / Linux 上 CodeMirror 给这两个的 Alt+← / Alt+→ 是后退 / 前进，没有键。
  'cursor-syntax-left': { mac: ['Ctrl+ArrowLeft'], other: [] },
  'cursor-syntax-right': { mac: ['Ctrl+ArrowRight'], other: [] },
  'select-syntax-left': { mac: ['Ctrl+Shift+ArrowLeft'], other: ['Shift+Alt+ArrowLeft'] },
  'select-syntax-right': { mac: ['Ctrl+Shift+ArrowRight'], other: ['Shift+Alt+ArrowRight'] },
  fold: { mac: ['Mod+Alt+['], other: ['Ctrl+Shift+['] },
  unfold: { mac: ['Mod+Alt+]'], other: ['Ctrl+Shift+]'] },
  'fold-all': ['Ctrl+Alt+['],
  'unfold-all': ['Ctrl+Alt+]'],
  'toggle-word-wrap': ['Alt+Z'],
  // Tab 键改成挪焦点（不缩进），再按一次换回来。
  'toggle-tab-focus-mode': { mac: ['Shift+Alt+M'], other: ['Ctrl+M'] },
  // Esc：查找栏开着就关掉它，否则把多个选区收成一个；都没有就不算用掉，交给全局的 Esc。
  cancel: ['Escape'],
}

/**
 * VS Code 方案：照 VS Code 的默认键位（Default Keyboard Shortcuts）。没写的命令与 Workbench 同键——要么
 * VS Code 就是这个键，要么它没有对应的命令（或没有默认键）。
 */
const VsCodeEditorKeys: WorkbenchEditorKeymapTable = {
  ...WorkbenchEditorKeys,
  // 转到引用 ⇧F12（⌥F7 是 JetBrains 的键）。
  'find-references': ['Shift+F12'],
  // 显示调用层次结构 ⇧⌥H / Shift+Alt+H。
  'call-hierarchy': ['Shift+Alt+H'],
  // 重命名符号 F2。
  'rename-symbol': ['F2'],
  // 快速修复 ⌘. / Ctrl+.（⌥↩ 是 JetBrains 的键）。
  'quick-fix': ['Mod+.'],
  // 重构 ⌃⇧R。Windows / Linux 上的 Ctrl+Shift+R 是应用菜单的「强制重新加载」，留 Workbench 的键。
  refactor: { mac: ['Ctrl+Shift+R'], other: ['Ctrl+Alt+Shift+T'] },
  // 格式化文档 ⇧⌥F / Shift+Alt+F。Linux 上是 Ctrl+Shift+I——应用菜单的「开发者工具」占着，留 Workbench 的键。
  'format-document': { mac: ['Shift+Alt+F'], other: ['Shift+Alt+F'], linux: ['Mod+Alt+L'] },
  // 触发建议 ⌃Space / Ctrl+Space，另有 ⌘I / Ctrl+I；macOS 上还有 ⌥Esc。
  'trigger-completion': {
    mac: ['Ctrl+Space', 'Mod+I', 'Alt+Escape'],
    other: ['Ctrl+Space', 'Mod+I'],
  },
  // 转到上一个问题 ⇧F8（下一个是 F8，同 Workbench）。
  'previous-problem': ['Shift+F8'],
  // ⇧⌘M / Ctrl+Shift+M 在 VS Code 里是「问题」面板：这个方案把它给了全局的「切换问题」，编辑器里的诊断列表没有键。
  'open-lint-panel': [],
  // 查找上一处：⇧F3，macOS 上另有 ⇧⌘G（这个方案里 Git 面板是 ⌃⇧G，⇧⌘G 空着）。
  'find-previous': { mac: ['Shift+F3', 'Mod+Shift+G'], other: ['Shift+F3'] },
  // 转到行 ⌃G / Ctrl+G。⌘L / Ctrl+L 在 VS Code 里是选中当前行。
  'go-to-line': ['Ctrl+G'],
  // Linux 上后退 / 前进是 Ctrl+Alt+- / Ctrl+Shift+-（全局快捷键），编辑器不占键；Windows 同 Workbench。
  'navigate-back': { mac: [], other: ['Alt+ArrowLeft'], linux: [] },
  'navigate-forward': { mac: [], other: ['Alt+ArrowRight'], linux: [] },
  // 切换块注释 ⇧⌥A / Shift+Alt+A，Linux 上 Ctrl+Shift+A。
  'toggle-block-comment': {
    mac: ['Shift+Alt+A'],
    other: ['Shift+Alt+A'],
    linux: ['Mod+Shift+A'],
  },
  // 向上 / 向下复制行 ⇧⌥↑ / ⇧⌥↓，Linux 上 Ctrl+Shift+Alt+↑ / ↓。
  'copy-line-up': {
    mac: ['Shift+Alt+ArrowUp'],
    other: ['Shift+Alt+ArrowUp'],
    linux: ['Ctrl+Shift+Alt+ArrowUp'],
  },
  'copy-line-down': {
    mac: ['Shift+Alt+ArrowDown'],
    other: ['Shift+Alt+ArrowDown'],
    linux: ['Ctrl+Shift+Alt+ArrowDown'],
  },
  // 重做：macOS 上 ⇧⌘Z，Windows / Linux 上 Ctrl+Y 与 Ctrl+Shift+Z。
  redo: { mac: ['Mod+Shift+Z'], other: ['Mod+Y', 'Mod+Shift+Z'] },
  // 选择所有匹配项 ⇧⌘L / Ctrl+Shift+L，更改所有匹配项 ⌘F2 / Ctrl+F2（这里是同一个命令）。
  'select-all-occurrences': ['Mod+Shift+L', 'Mod+F2'],
  // 选中当前行 ⌘L / Ctrl+L。
  'select-line': ['Mod+L'],
  // 扩大选区：macOS 上 ⌃⇧⌘→，Windows / Linux 上 Shift+Alt+→。
  'expand-selection': { mac: ['Mod+Ctrl+Shift+ArrowRight'], other: ['Shift+Alt+ArrowRight'] },
  // 在上面 / 下面添加光标：⌥⌘↑ / ⌥⌘↓，Windows 上 Ctrl+Alt+↑ / ↓，Linux 上 Ctrl+Shift+↑ / ↓ 与 Shift+Alt+↑ / ↓。
  'add-cursor-above': {
    mac: ['Mod+Alt+ArrowUp'],
    other: ['Mod+Alt+ArrowUp'],
    linux: ['Ctrl+Shift+ArrowUp', 'Shift+Alt+ArrowUp'],
  },
  'add-cursor-below': {
    mac: ['Mod+Alt+ArrowDown'],
    other: ['Mod+Alt+ArrowDown'],
    linux: ['Ctrl+Shift+ArrowDown', 'Shift+Alt+ArrowDown'],
  },
  // Windows / Linux 上 Shift+Alt+→ 给了「扩大选区」。Shift+Alt+← 在 VS Code 里是「缩小选区」，编辑器没有这个命令，
  // 也不让这个键去做别的事：这一对在 Windows / Linux 上都没有键。macOS 同 Workbench。
  'select-syntax-left': { mac: ['Ctrl+Shift+ArrowLeft'], other: [] },
  'select-syntax-right': { mac: ['Ctrl+Shift+ArrowRight'], other: [] },
  // 折叠 / 展开（⌥⌘[ / ⌥⌘]，Ctrl+Shift+[ / ]）同 Workbench。全部折叠 / 全部展开在 VS Code 里是分两步按的
  // ⌘K ⌘0 / ⌘K ⌘J，这里按不出来，留 Workbench 的键。
  // 切换 Tab 键移动焦点：macOS 上 ⌃⇧M，其它平台 Ctrl+M。
  'toggle-tab-focus-mode': { mac: ['Ctrl+Shift+M'], other: ['Ctrl+M'] },
}

/**
 * JetBrains 方案：照 IntelliJ 平台的默认键位（macOS 键位表；Windows / Linux 是 `$default`）。没写的命令与
 * Workbench 同键——要么 JetBrains 就是这个键（重命名 ⇧F6、格式化 ⌥⌘L、调用层次 ⌃⌥H、重构 ⌃T……），要么它
 * 没有对应的命令、没有默认键，或者它的键在这里按不到：
 *  - 替换 ⌘R / Ctrl+R：应用菜单的「重新加载」占着；
 *  - 折叠 / 展开 ⌘- / ⌘+（Ctrl+- / Ctrl+=）与带 Shift 的全部折叠 / 展开：应用菜单的编辑区缩放占着；
 *  - 在上面 / 下面克隆光标：要连按两下修饰键再按方向键。
 */
const JetBrainsEditorKeys: WorkbenchEditorKeymapTable = {
  ...WorkbenchEditorKeys,
  // 转到声明 ⌘B / Ctrl+B。
  'go-to-definition': ['Mod+B'],
  // 查找用法 ⌥F7 / Alt+F7，显示用法 ⌥⌘F7 / Ctrl+Alt+F7（这里是同一个面板）。
  'find-references': ['Alt+F7', 'Mod+Alt+F7'],
  // 显示上下文操作 ⌥↩ / Alt+Enter（⌘. 是 VS Code 的键）。
  'quick-fix': ['Alt+Enter'],
  // 优化 import ⌃⌥O / Ctrl+Alt+O。
  'organize-imports': ['Ctrl+Alt+O'],
  // 基本补全 ⌃Space / Ctrl+Space。这个键常被系统拿去切输入法（macOS 的输入源、Windows 的中英文），所以
  // Workbench 的 ⌘I / Ctrl+I 也留着。
  'trigger-completion': ['Ctrl+Space', 'Mod+I'],
  // 下一个 / 上一个高亮的错误 F2 / ⇧F2。
  'next-problem': ['F2'],
  'previous-problem': ['Shift+F2'],
  // Windows / Linux 上 Ctrl+Shift+M 是「移动到匹配的括号」，诊断列表让出这个键；macOS 上不冲突，留着。
  'open-lint-panel': { mac: ['Mod+Shift+M'], other: [] },
  // 查找下一处 / 上一处：macOS 上 ⌘G / ⇧⌘G，Windows / Linux 上 F3 / ⇧F3，另有 Ctrl+L / Ctrl+Shift+L。
  'find-next': { mac: ['Mod+G', 'F3'], other: ['F3', 'Mod+L'] },
  'find-previous': { mac: ['Mod+Shift+G', 'Shift+F3'], other: ['Shift+F3', 'Mod+Shift+L'] },
  // 转到行：macOS 上 ⌘L，Windows / Linux 上 Ctrl+G。
  'go-to-line': { mac: ['Mod+L'], other: ['Ctrl+G'] },
  // 后退 / 前进是全局快捷键（⌘[ / ⌘]，Ctrl+Alt+← / →），编辑器不占键。
  'navigate-back': [],
  'navigate-forward': [],
  // 块注释：macOS 上 ⌥⌘/，Windows / Linux 上 Ctrl+Shift+/。
  'toggle-block-comment': { mac: ['Mod+Alt+/'], other: ['Mod+Shift+/'] },
  // 缩进 / 取消缩进只有 Tab / ⇧Tab：⌘] / ⌘[ 在 macOS 上是前进 / 后退。
  'indent-more': ['Tab'],
  'indent-less': ['Shift+Tab'],
  // 自动缩进行 ⌃⌥I / Ctrl+Alt+I。
  'reindent-selection': ['Ctrl+Alt+I'],
  // 上移 / 下移行 ⇧⌥↑ / ⇧⌥↓（Alt+Shift+↑ / ↓）。
  'move-line-up': ['Shift+Alt+ArrowUp'],
  'move-line-down': ['Shift+Alt+ArrowDown'],
  // 重复行 ⌘D / Ctrl+D 是往下复制。往上复制没有对应的动作，它在 Workbench 里的键给了上移行：没有键。
  'copy-line-up': [],
  'copy-line-down': ['Mod+D'],
  // 删除行：macOS 上 ⌘⌫，Linux 上 Ctrl+Y。Windows 上 Ctrl+Y 是应用菜单的「重做」，留 Workbench 的键。
  'delete-line': { mac: ['Mod+Backspace'], other: ['Mod+Shift+K'], linux: ['Mod+Y'] },
  // 开始新行 ⇧↩ / Shift+Enter。
  'insert-blank-line': ['Shift+Enter'],
  // 重做 ⇧⌘Z / Ctrl+Shift+Z（Ctrl+Y 在 JetBrains 里是删除行）。
  redo: ['Mod+Shift+Z'],
  // 添加下一个匹配项的选区：macOS 上 ⌃G，Windows / Linux 上 Alt+J。
  'select-next-occurrence': { mac: ['Ctrl+G'], other: ['Alt+J'] },
  // 选择所有匹配项：macOS 上 ⌃⌘G，Windows / Linux 上 Ctrl+Alt+Shift+J。
  'select-all-occurrences': { mac: ['Mod+Ctrl+G'], other: ['Ctrl+Alt+Shift+J'] },
  // 扩展选区：macOS 上 ⌥↑。Windows / Linux 上是 Ctrl+W——应用菜单的「关闭编辑器」占着，留 Workbench 的（没有键）。
  'expand-selection': { mac: ['Alt+ArrowUp'], other: [] },
  // 移动到匹配的括号：macOS 上 ⌃M，Windows / Linux 上 Ctrl+Shift+M。
  'jump-to-bracket': { mac: ['Ctrl+M'], other: ['Mod+Shift+M'] },
}

const WorkbenchEditorKeymapTables: Record<WorkbenchKeymapTablePresetId, WorkbenchEditorKeymapTable> = {
  workbench: WorkbenchEditorKeys,
  vscode: VsCodeEditorKeys,
  jetbrains: JetBrainsEditorKeys,
}

/**
 * 编辑器命令与全局快捷键同键、而且是有意的几处（别处同键就是表写错了）。焦点在编辑器里时编辑器先拿到按键，
 * 谁赢写在 `note` 里。
 */
export const WorkbenchEditorKeymapSharedChords: ReadonlyArray<{
  command: WorkbenchEditorKeymapCommandId
  /** 全局快捷键的动作名（`workbenchKeyboardShortcuts.ts`）。 */
  action: string
  note: string
}> = [
  { command: 'save', action: 'save-current', note: '同一件事：编辑器里的保存带着「保存时格式化」' },
  { command: 'navigate-back', action: 'navigate-back', note: '同一件事：编辑器把键接下来交给同一个后退' },
  { command: 'navigate-forward', action: 'navigate-forward', note: '同一件事：同上' },
  {
    command: 'insert-blank-line',
    action: 'run-last-command',
    note: '编辑器赢：在下面插入空行。「运行上次命令」在输入框、编辑器这些打字的地方本来就不触发',
  },
  {
    command: 'cancel',
    action: 'close-right-tool',
    note: '编辑器有事可做（关查找栏、收起多个选区）才用掉 Esc，否则放给全局去收右侧面板',
  },
  {
    command: 'next-problem',
    action: 'debug-continue',
    note: '调试停着时调试器先拿（捕获阶段），没在调试时是编辑器的「下一个问题」',
  },
]

/** 解析好的一组键：四个修饰键，加上具名键的名字（`Enter`、`ArrowLeft`、`F12`、`Space`）或小写的字符。 */
interface WorkbenchEditorChord {
  alt: boolean
  ctrl: boolean
  meta: boolean
  shift: boolean
  key: string
}

function parseWorkbenchEditorChord(chord: string, platform: WorkbenchKeymapPlatform): WorkbenchEditorChord {
  const parts = chord.split(/\b\+/u)
  const key = parts.pop() ?? ''
  const modifiers = new Set(parts)
  const mod = modifiers.has('Mod')
  return {
    alt: modifiers.has('Alt'),
    ctrl: modifiers.has('Ctrl') || (mod && platform !== 'mac'),
    meta: mod && platform === 'mac',
    shift: modifiers.has('Shift'),
    key: key.length === 1 ? key.toLowerCase() : key,
  }
}

function chordSignature(chord: WorkbenchEditorChord): string {
  return `${chord.alt ? 'A' : ''}${chord.ctrl ? 'C' : ''}${chord.meta ? 'M' : ''}${chord.shift ? 'S' : ''}:${chord.key}`
}

/** 这个命令在这个方案、这个平台上的几组键（没有键是空数组）。 */
export function getWorkbenchEditorCommandChords(
  command: WorkbenchEditorKeymapCommandId,
  preset: WorkbenchKeymapPresetId = DEFAULT_WORKBENCH_KEYMAP_PRESET,
  platform: string = currentWorkbenchPlatform()
): readonly string[] {
  return pickWorkbenchPlatformKeys(
    WorkbenchEditorKeymapTables[resolveWorkbenchKeymapTablePreset(preset)][command],
    resolveWorkbenchKeymapPlatform(platform)
  )
}

/** 界面上提示的那一组键（第一组）；这个命令没有键是 null。 */
export function getWorkbenchEditorCommandShortcut(
  command: WorkbenchEditorKeymapCommandId,
  preset: WorkbenchKeymapPresetId = DEFAULT_WORKBENCH_KEYMAP_PRESET,
  platform: string = currentWorkbenchPlatform()
): Nullable<string> {
  return getWorkbenchEditorCommandChords(command, preset, platform)[0] ?? null
}

/**
 * 界面上提示这个命令的键（命令面板、右键菜单、设置里的说明）：Apple 平台用菜单符号（`⌥⌘L`），别处
 * `Ctrl+Alt+L`。这个方案、这个平台上它没有键是空串。
 */
export function formatWorkbenchEditorCommandHint(
  command: WorkbenchEditorKeymapCommandId,
  preset: WorkbenchKeymapPresetId = DEFAULT_WORKBENCH_KEYMAP_PRESET,
  platform: string = currentWorkbenchPlatform()
): string {
  const shortcut = getWorkbenchEditorCommandShortcut(command, preset, platform)
  return shortcut ? formatWorkbenchShortcutHint(shortcut, platform) : ''
}

export interface WorkbenchEditorKeymapBinding {
  command: WorkbenchEditorKeymapCommandId
  /** 表里的写法（`Mod+Shift+L`）。 */
  chord: string
  /** 修饰键按这个平台落实之后的样子：同一个平台上两组键相同就是它相同。 */
  signature: string
}

/** 这个方案在这个平台上的全部按键，按命令的排列顺序。 */
export function listWorkbenchEditorKeymapBindings(
  preset: WorkbenchKeymapPresetId,
  platform: string = currentWorkbenchPlatform()
): WorkbenchEditorKeymapBinding[] {
  const keymapPlatform = resolveWorkbenchKeymapPlatform(platform)
  return WORKBENCH_EDITOR_KEYMAP_COMMANDS.flatMap((command) =>
    getWorkbenchEditorCommandChords(command, preset, platform).map((chord) => ({
      command,
      chord,
      signature: chordSignature(parseWorkbenchEditorChord(chord, keymapPlatform)),
    }))
  )
}

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
  if (key === ' ') return [chordSignature({ ...modifiers, key: 'Space' })]
  if (NamedKeys.has(key) || /^F\d{1,2}$/u.test(key)) return [chordSignature({ ...modifiers, key })]

  const base = baseKeyCharacter(event)

  if (platform === 'mac' ? event.altKey : event.ctrlKey && event.altKey) {
    const typesAnotherCharacter =
      key.length === 1 && (UsShiftedCharacters[key] ?? key.toLowerCase()) !== base
    if (platform === 'windows' && typesAnotherCharacter) return []
    return base ? [chordSignature({ ...modifiers, key: base })] : []
  }

  const typed = key.length === 1 && key > ' ' && key <= '~' ? key : null
  const signatures: string[] = []
  if (typed !== null) {
    signatures.push(chordSignature({ ...modifiers, key: typed.toLowerCase() }))
    // 这个布局上要按着 Shift 才打得出来的符号（AZERTY、德语键盘上的 /）：Shift 不算在这组键里。
    if (event.shiftKey && !/[a-z]/iu.test(typed))
      signatures.push(chordSignature({ ...modifiers, shift: false, key: typed }))
  }
  if (base && base !== typed?.toLowerCase() && (event.altKey || event.ctrlKey || event.metaKey))
    signatures.push(chordSignature({ ...modifiers, key: base }))
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
