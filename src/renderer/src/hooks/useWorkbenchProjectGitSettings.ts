import { useEffect, useState } from 'react'

import {
  readWorkbenchProjectGitSettings,
  saveWorkbenchProjectGitSettings,
  WORKBENCH_PROJECT_GIT_SETTINGS_CHANGED_EVENT,
  type WorkbenchProjectGitSettings,
} from '../models/workbenchPreferences'

export interface WorkbenchProjectGitSettingsController {
  settings: WorkbenchProjectGitSettings
  updateSettings: (patch: Partial<WorkbenchProjectGitSettings>) => void
}

const PROJECT_GIT_SETTINGS_STORAGE_KEY = 'velaros.workbench.projectGitSettings.v1'

export function useWorkbenchProjectGitSettings(
  projectRoot: LooseOptional<string>
): WorkbenchProjectGitSettingsController {
  const [settings, setSettings] = useState<WorkbenchProjectGitSettings>(() =>
    readWorkbenchProjectGitSettings(projectRoot)
  )

  useEffect(() => {
    setSettings(readWorkbenchProjectGitSettings(projectRoot))
  }, [projectRoot])

  useEffect(() => {
    const refresh = (): void => {
      setSettings(readWorkbenchProjectGitSettings(projectRoot))
    }

    const handleStorageChanged = (event: StorageEvent): void => {
      if (event.key === PROJECT_GIT_SETTINGS_STORAGE_KEY) {
        refresh()
      }
    }

    window.addEventListener(WORKBENCH_PROJECT_GIT_SETTINGS_CHANGED_EVENT, refresh)
    window.addEventListener('storage', handleStorageChanged)

    return () => {
      window.removeEventListener(WORKBENCH_PROJECT_GIT_SETTINGS_CHANGED_EVENT, refresh)
      window.removeEventListener('storage', handleStorageChanged)
    }
  }, [projectRoot])

  function updateSettings(patch: Partial<WorkbenchProjectGitSettings>): void {
    if (!projectRoot) return

    const nextSettings = {
      ...settings,
      ...patch,
    }
    setSettings(nextSettings)
    saveWorkbenchProjectGitSettings(projectRoot, nextSettings)
  }

  return {
    settings,
    updateSettings,
  }
}
