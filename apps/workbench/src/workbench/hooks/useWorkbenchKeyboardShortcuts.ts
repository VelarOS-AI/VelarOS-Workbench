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

    const handleKeydown = (event: KeyboardEvent): void => {
      const current = optionsRef.current
      const action = getWorkbenchKeyboardShortcut(event, current.keymap)
      if (!action) return

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

    window.addEventListener('keydown', handleKeydown)
    return () => window.removeEventListener('keydown', handleKeydown)
  }, [enabled])
}
