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
  onOpenQuickOpen: () => void
  onRunLastCommand: () => Promise<unknown>
  onSaveAll: () => Promise<unknown>
  onSaveCurrent: () => Promise<unknown>
  /** 底部工具窗开关：同一个工具开着就收起，没开或开着别的就切到它。 */
  onToggleBottomTool: (tool: WorkbenchBottomTool) => void
  onToggleRightTool: (tool: WorkbenchRightToolWindow) => void
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
    const action = getWorkbenchKeyboardShortcut(event, current.keymap)
    if (!action) return
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
  onOpenQuickOpen,
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
    onOpenQuickOpen,
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
    onOpenQuickOpen,
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
