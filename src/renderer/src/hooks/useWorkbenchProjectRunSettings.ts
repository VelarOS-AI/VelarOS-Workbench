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
  /** 保存启动命令（▶ 不再指着运行配置）；传入空串（或纯空白）即清除，回退到自动探测。 */
  setCommand: (command: string) => void
  /** 把 ▶ 指到用户建的一份运行配置上。 */
  setConfigurationId: (configurationId: string) => void
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

  const save = useCallback(
    (nextSettings: WorkbenchProjectRunSettings): void => {
      if (!projectRoot) return

      setSettings(nextSettings)
      saveWorkbenchProjectRunSettings(projectRoot, nextSettings)
    },
    [projectRoot]
  )

  const setCommand = useCallback(
    (command: string): void => save({ command: command.trim(), configurationId: '' }),
    [save]
  )

  const setConfigurationId = useCallback(
    (configurationId: string): void => save({ command: '', configurationId: configurationId.trim() }),
    [save]
  )

  return {
    settings,
    setCommand,
    setConfigurationId,
  }
}
