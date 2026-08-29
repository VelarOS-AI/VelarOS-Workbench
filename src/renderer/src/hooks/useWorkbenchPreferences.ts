import { type CSSProperties, useEffect, useMemo, useState } from 'react'

import {
  DEFAULT_WORKBENCH_PREFERENCES,
  getWorkbenchEditorMetrics,
  getWorkbenchPreferencesStyle,
  normalizeWorkbenchPreferences,
  readWorkbenchPreferences,
  saveWorkbenchPreferences,
  WORKBENCH_PREFERENCES_CHANGED_EVENT,
  type WorkbenchDensity,
  type WorkbenchEditorMetrics,
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
 * 只订阅会改变 CodeMirror 几何尺寸的偏好。
 * 外层 CSS 变量负责视觉样式，这个值负责显式触发编辑器的测量缓存刷新。
 */
export function useWorkbenchEditorMetrics(): WorkbenchEditorMetrics {
  const [metrics, setMetrics] = useState<WorkbenchEditorMetrics>(() =>
    getWorkbenchEditorMetrics(readWorkbenchPreferences())
  )

  useEffect(() => {
    const refresh = (): void => {
      const next = getWorkbenchEditorMetrics(readWorkbenchPreferences())
      setMetrics((current) => (current.key === next.key ? current : next))
    }

    const handleStorageChanged = (event: StorageEvent): void => {
      if (event.key === 'velaros.workbench.preferences.v1') refresh()
    }

    window.addEventListener(WORKBENCH_PREFERENCES_CHANGED_EVENT, refresh)
    window.addEventListener('storage', handleStorageChanged)

    return () => {
      window.removeEventListener(WORKBENCH_PREFERENCES_CHANGED_EVENT, refresh)
      window.removeEventListener('storage', handleStorageChanged)
    }
  }, [])

  return metrics
}

/** 只订阅会改变文件树虚拟行高的密度值。 */
export function useWorkbenchDensity(): WorkbenchDensity {
  const [density, setDensity] = useState<WorkbenchDensity>(() => readWorkbenchPreferences().density)

  useEffect(() => {
    const refresh = (): void => {
      setDensity(readWorkbenchPreferences().density)
    }

    const handleStorageChanged = (event: StorageEvent): void => {
      if (event.key === 'velaros.workbench.preferences.v1') refresh()
    }

    window.addEventListener(WORKBENCH_PREFERENCES_CHANGED_EVENT, refresh)
    window.addEventListener('storage', handleStorageChanged)

    return () => {
      window.removeEventListener(WORKBENCH_PREFERENCES_CHANGED_EVENT, refresh)
      window.removeEventListener('storage', handleStorageChanged)
    }
  }, [])

  return density
}
