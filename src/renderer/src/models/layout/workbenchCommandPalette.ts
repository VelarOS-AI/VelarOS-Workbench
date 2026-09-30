/**
 * 命令面板（⇧⌘P，或在快速打开里输入 `>`）列出的工作台命令：叫什么、在哪能按到（右侧的快捷键提示）、
 * 按名字模糊找。只登记工作台里已有、真能跑的动作；哪条此刻能跑、怎么跑由页面给（见页面 model 的
 * `commandPalette`），此刻跑不了的（没打开文件时的保存、格式化……）不列出来。
 */
import { workbenchTerminalSplitShortcut } from '../commands/workbenchTerminalSplits'
import { scoreWorkbenchFuzzy } from '../shared/workbenchFuzzyScore'

import {
  formatWorkbenchShortcutHint,
  isAppleWorkbenchPlatform,
  type WorkbenchKeyboardShortcutAction,
  type WorkbenchKeyboardShortcutMap,
} from './workbenchKeyboardShortcuts'

export type WorkbenchPaletteCommandId =
  | 'close-all-editors'
  | 'close-editor'
  | 'close-project'
  | 'find-in-files'
  | 'find-references'
  | 'focus-left-editor-group'
  | 'focus-right-editor-group'
  | 'format-document'
  | 'go-to-file'
  | 'go-to-line'
  | 'go-to-symbol'
  | 'navigate-back'
  | 'navigate-forward'
  | 'new-terminal'
  | 'open-settings'
  | 'organize-imports'
  | 'quick-fix'
  | 'refactor'
  | 'reopen-closed-tab'
  | 'reveal-active-file'
  | 'run-last-command'
  | 'save-all'
  | 'save-current'
  | 'split-editor-right'
  | 'split-terminal'
  | 'toggle-chat'
  | 'toggle-git'
  | 'toggle-git-blame'
  | 'toggle-problems'
  | 'toggle-project-panel'
  | 'toggle-read-only'
  | 'toggle-terminal'
  | 'toggle-word-wrap'
  | 'zoom-in'
  | 'zoom-out'
  | 'zoom-reset'

/**
 * 快捷键提示从哪来：`action` 是设置里可改的全局快捷键，按当前 keymap 现算；`fixed` 是编辑器或应用菜单里
 * 写死的按键（`Mod` 照样按平台落到 ⌘ / Ctrl）；`platform` 是两类平台上按键不一样的（终端里的那几个）。
 */
type WorkbenchPaletteCommandShortcut =
  | { action: WorkbenchKeyboardShortcutAction }
  | { fixed: string }
  | { platform: (isApple: boolean) => string }

export interface WorkbenchPaletteCommandDefinition {
  id: WorkbenchPaletteCommandId
  labelKey: string
  shortcut?: WorkbenchPaletteCommandShortcut
}

/** 输入为空时按这个顺序列：先打开与跳转，再编辑，再各个面板，最后应用级的。 */
export const WORKBENCH_PALETTE_COMMANDS: readonly WorkbenchPaletteCommandDefinition[] = [
  { id: 'go-to-file', labelKey: 'workbench.commandGoToFile', shortcut: { action: 'quick-open' } },
  // 编辑器里的跳到行（⌃G / Ctrl+G）；面板里是快速打开的 `:` 模式。
  { id: 'go-to-line', labelKey: 'workbench.commandGoToLine', shortcut: { fixed: 'Ctrl+G' } },
  // 当前文件里的符号（大纲）；面板里是快速打开的 `@` 模式。
  { id: 'go-to-symbol', labelKey: 'workbench.commandGoToSymbol', shortcut: { action: 'go-to-symbol' } },
  // 侧栏的项目搜索与替换；编辑器里选中了一行以内的文字就拿它当查找词。
  { id: 'find-in-files', labelKey: 'workbench.commandFindInFiles', shortcut: { action: 'find-in-files' } },
  { id: 'navigate-back', labelKey: 'workbench.commandNavigateBack', shortcut: { action: 'navigate-back' } },
  {
    id: 'navigate-forward',
    labelKey: 'workbench.commandNavigateForward',
    shortcut: { action: 'navigate-forward' },
  },
  { id: 'save-current', labelKey: 'workbench.commandSave', shortcut: { action: 'save-current' } },
  { id: 'save-all', labelKey: 'workbench.commandSaveAll', shortcut: { action: 'save-all' } },
  // 应用菜单「关闭编辑器」的 CmdOrCtrl+W。
  { id: 'close-editor', labelKey: 'workbench.commandCloseEditor', shortcut: { fixed: 'Mod+W' } },
  { id: 'close-all-editors', labelKey: 'workbench.commandCloseAllEditors' },
  {
    id: 'reopen-closed-tab',
    labelKey: 'workbench.commandReopenClosedEditor',
    shortcut: { action: 'reopen-closed-tab' },
  },
  // 把当前标签挪到右边那组（没有就新开）；并排两组时把焦点放到左边 / 右边那组。
  {
    id: 'split-editor-right',
    labelKey: 'workbench.commandSplitEditorRight',
    shortcut: { action: 'split-editor-right' },
  },
  {
    id: 'focus-left-editor-group',
    labelKey: 'workbench.commandFocusLeftEditorGroup',
    shortcut: { action: 'focus-left-editor-group' },
  },
  {
    id: 'focus-right-editor-group',
    labelKey: 'workbench.commandFocusRightEditorGroup',
    shortcut: { action: 'focus-right-editor-group' },
  },
  // 编辑器里的 ⌥⌘L / Ctrl+Alt+L。
  { id: 'format-document', labelKey: 'workbench.commandFormatDocument', shortcut: { fixed: 'Mod+Alt+L' } },
  // 光标处符号的全部引用，列在编辑器里的面板上：⇧F12（另有 ⌥F7 / Alt+F7）。
  {
    id: 'find-references',
    labelKey: 'workbench.commandFindReferences',
    shortcut: { fixed: 'Shift+F12' },
  },
  // 编辑器里光标处的动作菜单：⌥↩ / Alt+Enter（另有 ⌘. / Ctrl+.）。
  { id: 'quick-fix', labelKey: 'workbench.commandQuickFix', shortcut: { fixed: 'Alt+Enter' } },
  // 选中的代码（或光标处）能做的重构：macOS 上 ⌃T，其它平台 Ctrl+Alt+Shift+T。
  {
    id: 'refactor',
    labelKey: 'workbench.commandRefactor',
    shortcut: { platform: (isApple) => (isApple ? 'Ctrl+T' : 'Ctrl+Alt+Shift+T') },
  },
  // 编辑器里的 ⇧⌥O / Shift+Alt+O：排序、合并、去掉没用到的 import。
  {
    id: 'organize-imports',
    labelKey: 'workbench.commandOrganizeImports',
    shortcut: { fixed: 'Alt+Shift+O' },
  },
  // 编辑器里的 ⌥Z / Alt+Z。
  { id: 'toggle-word-wrap', labelKey: 'workbench.commandToggleWordWrap', shortcut: { fixed: 'Alt+Z' } },
  { id: 'toggle-read-only', labelKey: 'workbench.commandToggleReadOnly' },
  // 行号左边的追溯栏；编辑器右键菜单里也有。
  { id: 'toggle-git-blame', labelKey: 'workbench.commandToggleGitBlame' },
  { id: 'reveal-active-file', labelKey: 'workbench.commandRevealActiveFile' },
  { id: 'toggle-project-panel', labelKey: 'workbench.commandToggleProjectPanel' },
  { id: 'toggle-problems', labelKey: 'workbench.commandToggleProblems', shortcut: { action: 'toggle-problems' } },
  { id: 'toggle-git', labelKey: 'workbench.commandToggleGit', shortcut: { action: 'toggle-changes' } },
  { id: 'toggle-terminal', labelKey: 'workbench.commandToggleTerminal' },
  { id: 'new-terminal', labelKey: 'workbench.commandNewTerminal' },
  // 在当前终端右边并排再开一个；焦点在终端里时的 ⌘D / Ctrl+Shift+5。
  {
    id: 'split-terminal',
    labelKey: 'workbench.commandSplitTerminal',
    shortcut: { platform: workbenchTerminalSplitShortcut },
  },
  { id: 'toggle-chat', labelKey: 'workbench.commandToggleChat', shortcut: { action: 'toggle-actions' } },
  {
    id: 'run-last-command',
    labelKey: 'workbench.commandRunLastCommand',
    shortcut: { action: 'run-last-command' },
  },
  // 应用菜单「视图」里的放大、缩小、重置编辑器。
  { id: 'zoom-in', labelKey: 'workbench.commandZoomIn', shortcut: { fixed: 'Mod++' } },
  { id: 'zoom-out', labelKey: 'workbench.commandZoomOut', shortcut: { fixed: 'Mod+-' } },
  { id: 'zoom-reset', labelKey: 'workbench.commandZoomReset', shortcut: { fixed: 'Mod+0' } },
  { id: 'open-settings', labelKey: 'workbench.commandOpenSettings' },
  { id: 'close-project', labelKey: 'workbench.commandCloseProject' },
]

/** 判断命令此刻能不能跑要看的页面状态。 */
export interface WorkbenchPaletteCommandContext {
  /** 编辑器里有当前文件。 */
  hasActiveFile: boolean
  /** 当前文件是文本（不是图片预览）。 */
  activeFileIsText: boolean
  /** 当前文件此刻能编辑：文本完整，处在编辑模式。 */
  canEditActiveFile: boolean
  /** 当前文件能在只读与编辑之间切换：文本完整（截断的大文件、写不回原样的不能切）。 */
  canToggleReadOnly: boolean
  /** 编辑区前面盖着别的（对比、只读预览、调试页、结构图、AI 改动），不是当前文件的编辑器。 */
  editorCovered: boolean
  openTabCount: number
  /** 当前标签能挪到右边那组：它不在右边那组里，挪过去也不是白挪（唯一一组里只有它一个）。 */
  canSplitEditorRight: boolean
  /** 编辑区里有几组（1 或 2）。 */
  editorGroupCount: number
  /** 当前文件归哪种语言服务照看（决定有没有快速修复这类代码动作）；没有语言服务为 null。 */
  activeFileLanguageService: Nullable<WorkbenchPaletteLanguageService>
}

/** 内置的 TypeScript / JavaScript 服务，或项目自己的外部语言服务器。 */
export type WorkbenchPaletteLanguageService = 'typescript' | 'external'

/**
 * 命令此刻能不能跑。作用在眼前编辑器上的（格式化、切只读、快速修复）要当前文件的编辑器在前面；跳行、转到
 * 符号会先把当前文件带到前面，有文本文件就行；关编辑器关的是前面那个，标签或盖在前面的都算。其余随时能跑。
 */
export function isWorkbenchPaletteCommandAvailable(
  id: WorkbenchPaletteCommandId,
  context: WorkbenchPaletteCommandContext
): boolean {
  const textEditorInFront =
    context.hasActiveFile && context.activeFileIsText && !context.editorCovered
  switch (id) {
    case 'go-to-line':
    case 'go-to-symbol':
      return context.hasActiveFile && context.activeFileIsText
    case 'save-current':
    case 'reveal-active-file':
      return context.hasActiveFile
    case 'save-all':
    case 'close-all-editors':
      return context.openTabCount > 0
    case 'close-editor':
      return context.openTabCount > 0 || context.editorCovered
    case 'format-document':
      return textEditorInFront && context.canEditActiveFile
    // 修复要改代码：只读的文件不给；没有语言服务的文件没有修复可给。
    case 'quick-fix':
      return textEditorInFront && context.canEditActiveFile && !!context.activeFileLanguageService
    // 重构、整理 import 是内置 TypeScript 服务给的。
    case 'refactor':
    case 'organize-imports':
      return (
        textEditorInFront
        && context.canEditActiveFile
        && context.activeFileLanguageService === 'typescript'
      )
    // 引用是语言服务给的；只读的文件照样能查。
    case 'find-references':
      return textEditorInFront && !!context.activeFileLanguageService
    case 'toggle-read-only':
      return textEditorInFront && context.canToggleReadOnly
    case 'toggle-git-blame':
      return textEditorInFront
    case 'split-editor-right':
      return context.hasActiveFile && !context.editorCovered && context.canSplitEditorRight
    case 'focus-left-editor-group':
    case 'focus-right-editor-group':
      return context.editorGroupCount > 1
    default:
      return true
  }
}

export interface WorkbenchPaletteCommandItem {
  id: WorkbenchPaletteCommandId
  label: string
  /**
   * 英文名：界面是中文时也能敲英文找到（同 VS Code 的命令别名）；界面本来就是英文、两个名字一样时为 null。
   */
  alias: Nullable<string>
  /** 右侧的快捷键提示；没有快捷键为 null。 */
  shortcut: Nullable<string>
}

export interface WorkbenchPaletteCommandMatch {
  command: WorkbenchPaletteCommandItem
  /** 名字里命中的字符下标。 */
  labelMatches: readonly number[]
  /** 按英文名命中时，英文名里命中的字符；按名字命中为 null（界面上只在按英文名命中时显示英文名）。 */
  aliasMatches: Nullable<readonly number[]>
}

function formatCommandShortcut(
  shortcut: LooseOptional<WorkbenchPaletteCommandShortcut>,
  keymap: WorkbenchKeyboardShortcutMap,
  platform: string | undefined
): Nullable<string> {
  if (!shortcut) return null

  const keys =
    'action' in shortcut
      ? keymap[shortcut.action]
      : 'fixed' in shortcut
        ? shortcut.fixed
        : shortcut.platform(isAppleWorkbenchPlatform(platform))
  return formatWorkbenchShortcutHint(keys, platform)
}

/** 此刻能跑的命令，按登记顺序，名字与快捷键提示按当前语言、keymap 与平台现算。 */
export function buildWorkbenchPaletteCommands({
  isAvailable,
  keymap,
  translate,
  translateAlias,
  platform,
}: {
  isAvailable: (id: WorkbenchPaletteCommandId) => boolean
  keymap: WorkbenchKeyboardShortcutMap
  /** 当前界面语言的文案。 */
  translate: (key: string) => string
  /** 英文文案（给别名用）。 */
  translateAlias: (key: string) => string
  /** 按哪个平台格式化快捷键；不给用当前宿主平台。 */
  platform?: string
}): WorkbenchPaletteCommandItem[] {
  return WORKBENCH_PALETTE_COMMANDS.filter((definition) => isAvailable(definition.id)).map(
    (definition) => {
      const label = translate(definition.labelKey)
      const alias = translateAlias(definition.labelKey)
      return {
        id: definition.id,
        label,
        alias: alias === label ? null : alias,
        shortcut: formatCommandShortcut(definition.shortcut, keymap, platform),
      }
    }
  )
}

interface PieceMatch {
  score: number
  positions: number[]
}

/** 空格隔开的几段都要在同一段文字里命中；分数相加，命中位置合起来。 */
function matchPieces(text: string, pieces: readonly string[]): Nullable<PieceMatch> {
  let score = 0
  const positions = new Set<number>()
  for (const piece of pieces) {
    const match = scoreWorkbenchFuzzy(text, piece)
    if (!match) return null

    score += match.score
    match.positions.forEach((position) => positions.add(position))
  }
  return { score, positions: [...positions].sort((left, right) => left - right) }
}

/**
 * 按输入找命令：名字或英文名模糊命中都算，取分高的那个；分数相同按登记顺序。输入为空时按登记顺序全列。
 */
export function filterWorkbenchPaletteCommands(
  commands: readonly WorkbenchPaletteCommandItem[],
  query: string
): WorkbenchPaletteCommandMatch[] {
  const pieces = query.trim().split(/\s+/).filter(Boolean)
  if (pieces.length === 0)
    return commands.map((command) => ({ command, labelMatches: [], aliasMatches: null }))

  const scored: Array<{ match: WorkbenchPaletteCommandMatch; score: number; order: number }> = []
  commands.forEach((command, order) => {
    const labelMatch = matchPieces(command.label, pieces)
    const aliasMatch = command.alias ? matchPieces(command.alias, pieces) : null
    if (labelMatch && (!aliasMatch || labelMatch.score >= aliasMatch.score)) {
      scored.push({
        match: { command, labelMatches: labelMatch.positions, aliasMatches: null },
        score: labelMatch.score,
        order,
      })
    } else if (aliasMatch) {
      scored.push({
        match: { command, labelMatches: [], aliasMatches: aliasMatch.positions },
        score: aliasMatch.score,
        order,
      })
    }
  })

  return scored
    .sort((left, right) => right.score - left.score || left.order - right.order)
    .map(({ match }) => match)
}
