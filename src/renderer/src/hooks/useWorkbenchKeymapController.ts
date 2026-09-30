import { useEffect, useMemo, useState } from 'react'

import {
  buildWorkbenchKeymapConflicts,
  getWorkbenchKeymapPresetShortcuts,
  readWorkbenchKeymapSettings,
  resetWorkbenchKeymapShortcut,
  resolveWorkbenchKeyboardShortcutMap,
  saveWorkbenchKeymapSettings,
  setWorkbenchKeymapShortcut,
  subscribeWorkbenchKeymapSettings,
  type WorkbenchKeyboardShortcutAction,
  type WorkbenchKeyboardShortcutMap,
  type WorkbenchKeymapConflict,
  type WorkbenchKeymapSettings,
} from '../models/layout/workbenchKeyboardShortcuts'
import type { WorkbenchKeymapPresetId } from '../models/layout/workbenchKeymapPresets'

export type { WorkbenchKeymapConflict } from '../models/layout/workbenchKeyboardShortcuts'

export interface WorkbenchKeymapController {
  conflicts: WorkbenchKeymapConflict[]
  /** 此刻生效的键位：所选方案的默认键，叠上用户自己改过的。 */
  keymap: WorkbenchKeyboardShortcutMap
  /** 选的键位方案。 */
  preset: WorkbenchKeymapPresetId
  /** 所选方案的默认键：设置里据此看哪一项改过，「重置」回到的也是它。 */
  presetShortcuts: WorkbenchKeyboardShortcutMap
  resetAllShortcuts: () => void
  resetShortcut: (action: WorkbenchKeyboardShortcutAction) => void
  setPreset: (preset: WorkbenchKeymapPresetId) => void
  setShortcut: (action: WorkbenchKeyboardShortcutAction, shortcut: string) => void
}

/** 订阅存着的键位设置：本窗口里改了、别的窗口改了都跟上；`select` 取出关心的那一部分。 */
function useStoredWorkbenchKeymap<T>(select: (settings: WorkbenchKeymapSettings) => T): T {
  const [value, setValue] = useState<T>(() => select(readWorkbenchKeymapSettings()))

  useEffect(
    () => subscribeWorkbenchKeymapSettings((settings) => setValue(select(settings))),
    [select]
  )

  return value
}

const selectSettings = (settings: WorkbenchKeymapSettings): WorkbenchKeymapSettings => settings
const selectPreset = (settings: WorkbenchKeymapSettings): WorkbenchKeymapPresetId => settings.preset

/** 只订阅选的键位方案（编辑器按它认按键、显示提示）：改某个动作的键不触发重新渲染。 */
export function useWorkbenchKeymapPreset(): WorkbenchKeymapPresetId {
  return useStoredWorkbenchKeymap(selectPreset)
}

export function useWorkbenchKeymapController(): WorkbenchKeymapController {
  const settings = useStoredWorkbenchKeymap(selectSettings)

  const keymap = useMemo(() => resolveWorkbenchKeyboardShortcutMap(settings), [settings])
  const conflicts = useMemo(() => buildWorkbenchKeymapConflicts(keymap), [keymap])

  return {
    conflicts,
    keymap,
    preset: settings.preset,
    presetShortcuts: getWorkbenchKeymapPresetShortcuts(settings.preset),
    // 存盘会发出变更事件，上面的订阅随即读回新的设置。
    resetAllShortcuts: () => saveWorkbenchKeymapSettings({ preset: settings.preset, overrides: {} }),
    resetShortcut: (action) =>
      saveWorkbenchKeymapSettings(resetWorkbenchKeymapShortcut(settings, action)),
    setPreset: (preset) => saveWorkbenchKeymapSettings({ ...settings, preset }),
    setShortcut: (action, shortcut) =>
      saveWorkbenchKeymapSettings(setWorkbenchKeymapShortcut(settings, action, shortcut)),
  }
}
