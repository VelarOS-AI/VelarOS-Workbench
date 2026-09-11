import { useEffect, useRef } from 'react'

import {
  getWorkbenchKeyboardShortcut,
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
  onOpenBottomTool: (tool: WorkbenchBottomTool) => void
  onOpenQuickOpen: () => void
  onRunLastCommand: () => Promise<unknown>
  onSaveAll: () => Promise<unknown>
  onSaveCurrent: () => Promise<unknown>
  onToggleRightTool: (tool: WorkbenchRightToolWindow) => void
}

/** 全局快捷键的 keydown 处理：按当前选项把按键分发成动作（独立出来，不挂 DOM 也能测）。 */
export function createWorkbenchShortcutKeydownHandler(
  readOptions: () => UseWorkbenchKeyboardShortcutsOptions
): (event: KeyboardEvent) => void {
  return (event) => {
    const current = readOptions()
    const action = getWorkbenchKeyboardShortcut(event, current.keymap)
    if (!action) return
    // 焦点里的控件已经用掉了这次关闭键（取消行内重命名、收起搜索框、关掉补全）：只做那件事，
    // 不连带收起右侧面板。
    if (action === 'close-right-tool' && event.defaultPrevented) return

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
        current.onOpenBottomTool('problems')
        return
      }
      case 'toggle-changes': {
        current.onOpenBottomTool('git')
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
  onOpenBottomTool,
  onOpenQuickOpen,
  onRunLastCommand,
  onSaveAll,
  onSaveCurrent,
  onToggleRightTool,
}: UseWorkbenchKeyboardShortcutsOptions): void {
  const optionsRef = useRef<UseWorkbenchKeyboardShortcutsOptions>({
    activeRightTool,
    enabled,
    isQuickOpenOpen,
    keymap,
    onCloseRightTool,
    onOpenBottomTool,
    onOpenQuickOpen,
    onRunLastCommand,
    onSaveAll,
    onSaveCurrent,
    onToggleRightTool,
  })
  optionsRef.current = {
    activeRightTool,
    enabled,
    isQuickOpenOpen,
    keymap,
    onCloseRightTool,
    onOpenBottomTool,
    onOpenQuickOpen,
    onRunLastCommand,
    onSaveAll,
    onSaveCurrent,
    onToggleRightTool,
  }

  useEffect(() => {
    if (!enabled) return

    const handleKeydown = createWorkbenchShortcutKeydownHandler(() => optionsRef.current)
    window.addEventListener('keydown', handleKeydown)
    return () => window.removeEventListener('keydown', handleKeydown)
  }, [enabled])
}
