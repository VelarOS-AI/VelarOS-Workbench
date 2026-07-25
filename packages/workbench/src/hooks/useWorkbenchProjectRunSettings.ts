import { useCallback, useEffect, useState } from 'react'

import {
  PROJECT_RUN_SETTINGS_STORAGE_KEY,
  readWorkbenchProjectRunSettings,
  saveWorkbenchProjectRunSettings,
  WORKBENCH_PROJECT_RUN_SETTINGS_CHANGED_EVENT,
  type WorkbenchProjectRunSettings,
} from '../models/settings/workbenchPreferences'

export interface WorkbenchProjectRunSettingsController {
  settings: WorkbenchProjectRunSettings
  /** 保存启动命令；传入空串（或纯空白）即清除，回退到自动探测。 */
  setCommand: (command: string) => void
}

export function useWorkbenchProjectRunSettings(
  projectRoot: LooseOptional<string>
): WorkbenchProjectRunSettingsController {
  const [settings, setSettings] = useState<WorkbenchProjectRunSettings>(() =>
    readWorkbenchProjectRunSettings(projectRoot)
  )

  useEffect(() => {
    setSettings(readWorkbenchProjectRunSettings(projectRoot))
  }, [projectRoot])

  useEffect(() => {
    const refresh = (): void => {
      setSettings(readWorkbenchProjectRunSettings(projectRoot))
    }

    const handleStorageChanged = (event: StorageEvent): void => {
      if (event.key === PROJECT_RUN_SETTINGS_STORAGE_KEY) {
        refresh()
      }
    }

    window.addEventListener(WORKBENCH_PROJECT_RUN_SETTINGS_CHANGED_EVENT, refresh)
    window.addEventListener('storage', handleStorageChanged)

    return () => {
      window.removeEventListener(WORKBENCH_PROJECT_RUN_SETTINGS_CHANGED_EVENT, refresh)
      window.removeEventListener('storage', handleStorageChanged)
    }
  }, [projectRoot])

  const setCommand = useCallback(
    (command: string): void => {
      if (!projectRoot) return

      const nextSettings: WorkbenchProjectRunSettings = { command: command.trim() }
      setSettings(nextSettings)
      saveWorkbenchProjectRunSettings(projectRoot, nextSettings)
    },
    [projectRoot]
  )

  return {
    settings,
    setCommand,
  }
}
