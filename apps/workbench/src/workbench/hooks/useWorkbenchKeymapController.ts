import { useEffect, useMemo, useState } from 'react'

import {
  buildWorkbenchKeymapConflicts,
  DEFAULT_WORKBENCH_KEYBOARD_SHORTCUT_MAP,
  normalizeWorkbenchKeyboardShortcutMap,
  readWorkbenchKeyboardShortcutMap,
  saveWorkbenchKeyboardShortcutMap,
  WORKBENCH_KEYMAP_CHANGED_EVENT,
  type WorkbenchKeyboardShortcutAction,
  type WorkbenchKeyboardShortcutMap,
  type WorkbenchKeymapConflict,
} from '../models/layout/workbenchKeyboardShortcuts'

export type { WorkbenchKeymapConflict } from '../models/layout/workbenchKeyboardShortcuts'

export interface WorkbenchKeymapController {
  conflicts: WorkbenchKeymapConflict[]
  keymap: WorkbenchKeyboardShortcutMap
  resetAllShortcuts: () => void
  resetShortcut: (action: WorkbenchKeyboardShortcutAction) => void
  setShortcut: (action: WorkbenchKeyboardShortcutAction, shortcut: string) => void
}

export function useWorkbenchKeymapController(): WorkbenchKeymapController {
  const [keymap, setKeymap] = useState<WorkbenchKeyboardShortcutMap>(() =>
    readWorkbenchKeyboardShortcutMap()
  )

  const conflicts = useMemo(() => buildWorkbenchKeymapConflicts(keymap), [keymap])

  useEffect(() => {
    const refresh = (): void => {
      setKeymap(readWorkbenchKeyboardShortcutMap())
    }

    const handleStorageChanged = (event: StorageEvent): void => {
      if (event.key === 'velaros.workbench.keymap.v1') {
        refresh()
      }
    }

    window.addEventListener(WORKBENCH_KEYMAP_CHANGED_EVENT, refresh)
    window.addEventListener('storage', handleStorageChanged)

    return () => {
      window.removeEventListener(WORKBENCH_KEYMAP_CHANGED_EVENT, refresh)
      window.removeEventListener('storage', handleStorageChanged)
    }
  }, [])

  function commit(nextKeymap: WorkbenchKeyboardShortcutMap): void {
    const normalized = normalizeWorkbenchKeyboardShortcutMap(nextKeymap)
    setKeymap(normalized)
    saveWorkbenchKeyboardShortcutMap(normalized)
  }

  function setShortcut(action: WorkbenchKeyboardShortcutAction, shortcut: string): void {
    commit({
      ...keymap,
      [action]: shortcut,
    })
  }

  function resetShortcut(action: WorkbenchKeyboardShortcutAction): void {
    commit({
      ...keymap,
      [action]: DEFAULT_WORKBENCH_KEYBOARD_SHORTCUT_MAP[action],
    })
  }

  function resetAllShortcuts(): void {
    commit(DEFAULT_WORKBENCH_KEYBOARD_SHORTCUT_MAP)
  }

  return {
    conflicts,
    keymap,
    resetAllShortcuts,
    resetShortcut,
    setShortcut,
  }
}
