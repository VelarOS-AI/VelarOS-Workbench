import { useCallback, useEffect, useState } from 'react'

import type { WorkbenchRunCommand } from '../models/commands/workbenchCommandLines'
import {
  PROJECT_RUN_SETTINGS_STORAGE_KEY,
  readWorkbenchProjectRunSettings,
  saveWorkbenchProjectRunSettings,
  WORKBENCH_PROJECT_RUN_SETTINGS_CHANGED_EVENT,
  type WorkbenchProjectRunSettings,
} from '../models/workbenchPreferences'
import { useStableWorkbenchMessageTranslate } from '../runtime/useStableWorkbenchMessaging'

export interface WorkbenchProjectRunSettingsController {
  settings: WorkbenchProjectRunSettings
  /** 保存启动命令（▶ 不再指着运行配置）；传入空串（或纯空白）即清除，回退到自动探测。 */
  setCommand: (command: string) => boolean
  setRunCommand: (command: WorkbenchRunCommand) => boolean
  /** 把 ▶ 指到用户建的一份运行配置上。 */
  setConfigurationId: (configurationId: string) => boolean
}

export function useWorkbenchProjectRunSettings(
  projectRoot: LooseOptional<string>
): WorkbenchProjectRunSettingsController {
  const { messageLatest, tLatest } = useStableWorkbenchMessageTranslate()
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
    (nextSettings: WorkbenchProjectRunSettings): boolean => {
      if (!projectRoot) return false

      const saved = saveWorkbenchProjectRunSettings(projectRoot, nextSettings)
      if (saved.ok) return true

      messageLatest.current.error({
        title: tLatest.current('workbench.runConfigureCommand'),
        description: saved.error.message,
      })
      return false
    },
    [messageLatest, projectRoot, tLatest]
  )

  const setCommand = useCallback(
    (command: string): boolean => save({ command: command.trim(), configurationId: '' }),
    [save]
  )

  const setConfigurationId = useCallback(
    (configurationId: string): boolean => save({ command: '', configurationId: configurationId.trim() }),
    [save]
  )

  const setRunCommand = useCallback(
    (run: WorkbenchRunCommand): boolean => {
      const settings: WorkbenchProjectRunSettings = {
        command: run.command.trim(),
        configurationId: '',
      }
      if (run.launch) settings.launch = structuredClone(run.launch)
      return save(settings)
    },
    [save]
  )

  return {
    settings,
    setCommand,
    setRunCommand,
    setConfigurationId,
  }
}
