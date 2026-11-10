import { useEffect, useState } from 'react'

import {
  readWorkbenchProjectGitSettings,
  type WorkbenchProjectGitSettings,
} from '../models/workbenchPreferences'

export interface WorkbenchProjectGitSettingsController {
  settings: WorkbenchProjectGitSettings
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

    window.addEventListener('storage', handleStorageChanged)

    return () => {
      window.removeEventListener('storage', handleStorageChanged)
    }
  }, [projectRoot])

  return {
    settings,
  }
}
