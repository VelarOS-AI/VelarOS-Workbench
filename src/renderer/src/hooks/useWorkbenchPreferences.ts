import { type CSSProperties, useEffect, useMemo, useState } from 'react'

import {
  DEFAULT_WORKBENCH_PREFERENCES,
  getWorkbenchPreferencesStyle,
  normalizeWorkbenchPreferences,
  readWorkbenchPreferences,
  saveWorkbenchPreferences,
  WORKBENCH_PREFERENCES_CHANGED_EVENT,
  type WorkbenchPreferences,
} from '../models/settings/workbenchPreferences'

export interface WorkbenchPreferencesController {
  preferences: WorkbenchPreferences
  resetPreferences: () => void
  style: CSSProperties
  updatePreferences: (patch: Partial<WorkbenchPreferences>) => void
}

export function useWorkbenchPreferences(): WorkbenchPreferencesController {
  const [preferences, setPreferences] = useState<WorkbenchPreferences>(() =>
    readWorkbenchPreferences()
  )

  const style = useMemo(() => getWorkbenchPreferencesStyle(preferences), [preferences])

  useEffect(() => {
    const refresh = (): void => {
      setPreferences(readWorkbenchPreferences())
    }

    const handleStorageChanged = (event: StorageEvent): void => {
      if (event.key === 'velaros.workbench.preferences.v1') {
        refresh()
      }
    }

    window.addEventListener(WORKBENCH_PREFERENCES_CHANGED_EVENT, refresh)
    window.addEventListener('storage', handleStorageChanged)

    return () => {
      window.removeEventListener(WORKBENCH_PREFERENCES_CHANGED_EVENT, refresh)
      window.removeEventListener('storage', handleStorageChanged)
    }
  }, [])

  function commit(nextPreferences: WorkbenchPreferences): void {
    const normalized = normalizeWorkbenchPreferences(nextPreferences)
    setPreferences(normalized)
    saveWorkbenchPreferences(normalized)
  }

  function updatePreferences(patch: Partial<WorkbenchPreferences>): void {
    commit({
      ...preferences,
      ...patch,
    })
  }

  function resetPreferences(): void {
    commit(DEFAULT_WORKBENCH_PREFERENCES)
  }

  return {
    preferences,
    resetPreferences,
    style,
    updatePreferences,
  }
}

/**
 * 只订阅“AI 内联补全是否启用”这一个偏好。
 *
 * 编辑器组件用它来实时开关 Tab 补全，避免为了一个布尔值订阅整份偏好（含主题/字号等）。
 */
export function useWorkbenchAiCompletionEnabled(): boolean {
  const [enabled, setEnabled] = useState<boolean>(
    () => readWorkbenchPreferences().aiCompletionEnabled
  )

  useEffect(() => {
    const refresh = (): void => {
      setEnabled(readWorkbenchPreferences().aiCompletionEnabled)
    }

    const handleStorageChanged = (event: StorageEvent): void => {
      if (event.key === 'velaros.workbench.preferences.v1') {
        refresh()
      }
    }

    window.addEventListener(WORKBENCH_PREFERENCES_CHANGED_EVENT, refresh)
    window.addEventListener('storage', handleStorageChanged)

    return () => {
      window.removeEventListener(WORKBENCH_PREFERENCES_CHANGED_EVENT, refresh)
      window.removeEventListener('storage', handleStorageChanged)
    }
  }, [])

  return enabled
}
