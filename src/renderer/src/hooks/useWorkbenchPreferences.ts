import { type CSSProperties, useEffect, useLayoutEffect, useMemo, useState } from 'react'

import type { Result } from '@velaros-ai/velaros/core/result'

import { getWorkbenchColorTokens, getWorkbenchNativeAppearance } from '@shared/workbenchAppearance'

import {
  DEFAULT_WORKBENCH_PREFERENCES,
  getWorkbenchEditorMetrics,
  getWorkbenchPreferencesStyle,
  readWorkbenchPreferences,
  saveWorkbenchPreferences,
  updateWorkbenchPreferences,
  WORKBENCH_PREFERENCES_CHANGED_EVENT,
  type WorkbenchDensity,
  type WorkbenchDiffLayout,
  type WorkbenchEditorMetrics,
  type WorkbenchPreferences,
  type WorkbenchThemeId,
} from '../models/workbenchPreferences'
import { useStableWorkbenchMessageTranslate } from '../runtime/useStableWorkbenchMessaging'

export interface WorkbenchPreferencesController {
  preferences: WorkbenchPreferences
  resetPreferences: () => void
  style: CSSProperties
  updatePreferences: (patch: Partial<WorkbenchPreferences>) => void
}

export function useWorkbenchPreferences(): WorkbenchPreferencesController {
  const { messageLatest, tLatest } = useStableWorkbenchMessageTranslate()
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
  useLayoutEffect(() => {
    const root = document.documentElement
    root.dataset.workbenchAccent = preferences.accent
    root.dataset.workbenchTheme = preferences.theme
    root.dataset.theme = getWorkbenchNativeAppearance(preferences.theme).colorScheme
    root.style.colorScheme = getWorkbenchNativeAppearance(preferences.theme).colorScheme
    for (const [name, value] of Object.entries(
      getWorkbenchColorTokens(preferences.theme, preferences.accent)
    )) {
      root.style.setProperty(name, value)
    }
  }, [preferences.accent, preferences.theme])

  useEffect(() => {
    void window.velarosWorkbenchWindowState
      ?.setTheme?.(preferences.theme)
      .catch((error: unknown) => {
        console.warn('[workbench-appearance] Native theme could not be synchronized', error)
      })
  }, [preferences.theme])

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
    refresh()

    return () => {
      window.removeEventListener(WORKBENCH_PREFERENCES_CHANGED_EVENT, refresh)
      window.removeEventListener('storage', handleStorageChanged)
    }
  }, [])

  function handleSave(result: Result<WorkbenchPreferences>): void {
    if (result.ok) return
    messageLatest.current.error({
      title: tLatest.current('workbench.settingsTitle'),
      description: result.error.message,
    })
  }

  function updatePreferences(patch: Partial<WorkbenchPreferences>): void {
    handleSave(updateWorkbenchPreferences(patch))
  }

  function resetPreferences(): void {
    handleSave(saveWorkbenchPreferences(DEFAULT_WORKBENCH_PREFERENCES))
  }

  return {
    preferences,
    resetPreferences,
    style,
    updatePreferences,
  }
}

/**
 * 只订阅偏好里的一项：别的偏好变了、这一项没变时不触发重新渲染。`select` 须是稳定的函数（模块级），
 * `same` 判断两次取到的值是否相同。
 */
function useWorkbenchPreferenceValue<T>(
  select: (preferences: WorkbenchPreferences) => T,
  same: (current: T, next: T) => boolean = Object.is
): T {
  const [value, setValue] = useState<T>(() => select(readWorkbenchPreferences()))

  useEffect(() => {
    const refresh = (): void => {
      const next = select(readWorkbenchPreferences())
      setValue((current) => (same(current, next) ? current : next))
    }

    const handleStorageChanged = (event: StorageEvent): void => {
      if (event.key === 'velaros.workbench.preferences.v1') refresh()
    }

    window.addEventListener(WORKBENCH_PREFERENCES_CHANGED_EVENT, refresh)
    window.addEventListener('storage', handleStorageChanged)
    refresh()

    return () => {
      window.removeEventListener(WORKBENCH_PREFERENCES_CHANGED_EVENT, refresh)
      window.removeEventListener('storage', handleStorageChanged)
    }
  }, [same, select])

  return value
}

const selectTheme = (preferences: WorkbenchPreferences): WorkbenchThemeId => preferences.theme
const selectDensity = (preferences: WorkbenchPreferences): WorkbenchDensity => preferences.density
const selectWordWrap = (preferences: WorkbenchPreferences): boolean => preferences.editorWordWrap
const selectDiffLayout = (preferences: WorkbenchPreferences): WorkbenchDiffLayout =>
  preferences.diffLayout
const sameEditorMetrics = (
  current: WorkbenchEditorMetrics,
  next: WorkbenchEditorMetrics
): boolean => current.key === next.key

/**
 * 只订阅会改变 CodeMirror 几何尺寸的偏好。
 * 外层 CSS 变量负责视觉样式，这个值负责显式触发编辑器的测量缓存刷新。
 */
export function useWorkbenchEditorMetrics(): WorkbenchEditorMetrics {
  return useWorkbenchPreferenceValue(getWorkbenchEditorMetrics, sameEditorMetrics)
}

/** 只订阅主题：编辑器之外的代码片段（搜索结果）按它着色。 */
export function useWorkbenchCodeTheme(): WorkbenchThemeId {
  return useWorkbenchPreferenceValue(selectTheme)
}

/** 只订阅会改变文件树虚拟行高的密度值。 */
export function useWorkbenchDensity(): WorkbenchDensity {
  return useWorkbenchPreferenceValue(selectDensity)
}

/** 只订阅编辑区的自动换行开关。 */
export function useWorkbenchEditorWordWrap(): boolean {
  return useWorkbenchPreferenceValue(selectWordWrap)
}

/** 只订阅差异查看器的排法（上下合在一栏，或者左右并排）。 */
export function useWorkbenchDiffLayout(): WorkbenchDiffLayout {
  return useWorkbenchPreferenceValue(selectDiffLayout)
}
