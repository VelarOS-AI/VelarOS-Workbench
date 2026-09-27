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
  type WorkbenchThemeId,
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

  /*
   * 主题色写在**文档根**上，而不是只写在 shell 上。
   *
   * accent 是全局单值：一个窗口不存在两半用不同主题色。以前它只挂在 `.workbenchShell` 上，
   * 于是渲染到 <body> 的门户弹层（Popover 只往外复制 `data-velar-theme-scope`）落不进那条
   * 覆盖，只能吃到基础块里写死的那支蓝 `#2563eb`——同一个界面里两种主题色，改哪一处都修不全。
   * 挂到 :root 之后，shell、welcome 页与所有门户共用同一份定义，不再需要谁向谁复制。
   */
  useEffect(() => {
    const root = document.documentElement
    root.dataset.workbenchAccent = preferences.accent
    root.dataset.workbenchTheme = preferences.theme
  }, [preferences.accent, preferences.theme])

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

/** 只订阅主题：编辑器之外的代码片段（搜索结果）按它着色。 */
export function useWorkbenchCodeTheme(): WorkbenchThemeId {
  const [theme, setTheme] = useState<WorkbenchThemeId>(() => readWorkbenchPreferences().theme)

  useEffect(() => {
    const refresh = (): void => {
      setTheme(readWorkbenchPreferences().theme)
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

  return theme
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
