import { useEffect, useRef } from 'react'

import {
  getWorkbenchKeyboardShortcut,
  isWorkbenchTextEntryTarget,
  type WorkbenchKeyboardShortcutMap,
} from '../models/layout/workbenchKeyboardShortcuts'
import type {
  WorkbenchBottomTool,
  WorkbenchRightToolWindow,
} from '../models/layout/workbenchSurfaceModel'

export interface UseWorkbenchKeyboardShortcutsOptions {
  activeRightTool: Nullable<WorkbenchRightToolWindow>
  enabled: boolean
  isQuickOpenOpen: boolean
  keymap?: WorkbenchKeyboardShortcutMap
  onCloseRightTool: () => void
  /** 打开侧栏的项目搜索（编辑器里选中了一行以内的文字就拿它当查找词）。 */
  onFindInFiles: () => void
  /** 把键盘焦点放进编辑区的左边（0）或右边（1）那组。 */
  onFocusEditorGroup: (groupIndex: number) => void
  /** 把当前标签挪到右边那组（没有就新开）。 */
  onSplitEditorRight: () => void
  /** 编辑区的后退 / 前进：回到切文件、跳转之前的位置。 */
  onNavigateBack: () => void
  onNavigateForward: () => void
  onOpenQuickOpen: () => void
  /** 打开命令面板（快速打开的 `>` 模式）。 */
  onOpenCommandPalette: () => void
  /** 打开「转到文件中的符号」（快速打开的 `@` 模式）。 */
  onOpenSymbolOutline: () => void
  /** 重新打开最近关掉的文件标签（回到上次的光标位置）。 */
  onReopenClosedTab: () => void
  onRunLastCommand: () => Promise<unknown>
  onSaveAll: () => Promise<unknown>
  onSaveCurrent: () => Promise<unknown>
  /** 底部工具窗开关：同一个工具开着就收起，没开或开着别的就切到它。 */
  onToggleBottomTool: (tool: WorkbenchBottomTool) => void
  onToggleRightTool: (tool: WorkbenchRightToolWindow) => void
  /** 按哪个平台解析 `Mod`；不给用当前宿主平台（测试里指定，结果不随跑测试的系统变）。 */
  platform?: string
}

/** 全局快捷键的 keydown 处理：按当前选项把按键分发成动作（独立出来，不挂 DOM 也能测）。 */
export function createWorkbenchShortcutKeydownHandler(
  readOptions: () => UseWorkbenchKeyboardShortcutsOptions
): (event: KeyboardEvent) => void {
  return (event) => {
    // 焦点里的控件已经用掉了这次按键（编辑器插了空行或存了盘、提交框提交了、行内重命名取消了、
    // 补全收起了）：全局动作一律让路，同一次按键只做一件事。
    if (event.defaultPrevented) return

    const current = readOptions()
    const action = getWorkbenchKeyboardShortcut(event, current.keymap, current.platform)
    if (!action) return
    // 调试的那几个键归 useWorkbenchDebugShortcuts（调试中才生效，抢在编辑器前面）：这里不碰，没在调试时
    // 按键照常归编辑器、菜单和系统。
    if (action.startsWith('debug-')) return
    // 在输入框、文本域、可编辑区里按下的「运行上次命令」是冲着那段文字去的（换行、发送），不去跑命令。
    if (action === 'run-last-command' && isWorkbenchTextEntryTarget(event.target)) return

    event.preventDefault()

    switch (action) {
      case 'close-right-tool': {
        if (!current.isQuickOpenOpen && current.activeRightTool) current.onCloseRightTool()
        return
      }
      case 'quick-open': {
        current.onOpenQuickOpen()
        return
      }
      case 'command-palette': {
        current.onOpenCommandPalette()
        return
      }
      case 'go-to-symbol': {
        current.onOpenSymbolOutline()
        return
      }
      case 'find-in-files': {
        current.onFindInFiles()
        return
      }
      case 'split-editor-right': {
        current.onSplitEditorRight()
        return
      }
      case 'focus-left-editor-group': {
        current.onFocusEditorGroup(0)
        return
      }
      case 'focus-right-editor-group': {
        current.onFocusEditorGroup(1)
        return
      }
      case 'navigate-back': {
        current.onNavigateBack()
        return
      }
      case 'navigate-forward': {
        current.onNavigateForward()
        return
      }
      case 'reopen-closed-tab': {
        current.onReopenClosedTab()
        return
      }
      case 'save-current': {
        void current.onSaveCurrent()
        return
      }
      case 'save-all': {
        void current.onSaveAll()
        return
      }
      case 'toggle-problems': {
        current.onToggleBottomTool('problems')
        return
      }
      case 'toggle-changes': {
        current.onToggleBottomTool('git')
        return
      }
      case 'toggle-actions': {
        current.onToggleRightTool('chat')
        return
      }
      case 'run-last-command': {
        void current.onRunLastCommand()
      }
    }
  }
}

export function useWorkbenchKeyboardShortcuts({
  activeRightTool,
  enabled,
  isQuickOpenOpen,
  keymap,
  onCloseRightTool,
  onFindInFiles,
  onFocusEditorGroup,
  onSplitEditorRight,
  onNavigateBack,
  onNavigateForward,
  onOpenQuickOpen,
  onOpenCommandPalette,
  onOpenSymbolOutline,
  onReopenClosedTab,
  onRunLastCommand,
  onSaveAll,
  onSaveCurrent,
  onToggleBottomTool,
  onToggleRightTool,
}: UseWorkbenchKeyboardShortcutsOptions): void {
  const optionsRef = useRef<UseWorkbenchKeyboardShortcutsOptions>({
    activeRightTool,
    enabled,
    isQuickOpenOpen,
    keymap,
    onCloseRightTool,
    onFindInFiles,
    onFocusEditorGroup,
    onSplitEditorRight,
    onNavigateBack,
    onNavigateForward,
    onOpenQuickOpen,
    onOpenCommandPalette,
    onOpenSymbolOutline,
    onReopenClosedTab,
    onRunLastCommand,
    onSaveAll,
    onSaveCurrent,
    onToggleBottomTool,
    onToggleRightTool,
  })
  optionsRef.current = {
    activeRightTool,
    enabled,
    isQuickOpenOpen,
    keymap,
    onCloseRightTool,
    onFindInFiles,
    onFocusEditorGroup,
    onSplitEditorRight,
    onNavigateBack,
    onNavigateForward,
    onOpenQuickOpen,
    onOpenCommandPalette,
    onOpenSymbolOutline,
    onReopenClosedTab,
    onRunLastCommand,
    onSaveAll,
    onSaveCurrent,
    onToggleBottomTool,
    onToggleRightTool,
  }

  useEffect(() => {
    if (!enabled) return

    const handleKeydown = createWorkbenchShortcutKeydownHandler(() => optionsRef.current)
    window.addEventListener('keydown', handleKeydown)
    return () => window.removeEventListener('keydown', handleKeydown)
  }, [enabled])
}
