import type { CSSProperties } from 'react'

import { isFiniteNumber, isObject,isString, Log } from '@velaros-ai/core'

import {
  createLocalStorageJsonStore,
  type StorageLike,
} from '../../persistence/localStorageJsonStore'

const log = Log.tag('workbench-preferences')

export type WorkbenchThemeId =
  | 'light-modern'
  | 'dark-modern'
  | 'warm-paper'
  | 'midnight-blue'
export type WorkbenchDensity = 'compact' | 'balanced' | 'comfortable'
export type WorkbenchAccent =
  | 'blue'
  | 'teal'
  | 'green'
  | 'amber'
  | 'orange'
  | 'rose'
  | 'violet'
  | 'slate'

export interface WorkbenchPreferences {
  accent: WorkbenchAccent
  density: WorkbenchDensity
  editorFontSize: number
  editorLineHeight: number
  /** 快捷键控制的代码区缩放级别；基础字号和行高仍由设置面板独立维护。 */
  editorZoomLevel: number
  theme: WorkbenchThemeId
  /**
   * 用户手动编辑的本地历史快照节流窗口（秒）：自动保存时距上一份快照不足该间隔就不新增，
   * 省内存、更轻量。0=每次保存都存快照。AI/工具改动不受此限制，始终每次都存。
   */
  localHistoryThrottleSeconds: number
}

export interface WorkbenchEditorMetrics {
  /** CodeMirror 直接消费的最终字号，已包含快捷键缩放。 */
  fontSize: string
  /** CodeMirror 直接消费的最终行高，已包含快捷键缩放。 */
  lineHeight: string
  /** 仅在影响编辑器几何尺寸的偏好变化时改变。 */
  key: string
}

export const DEFAULT_WORKBENCH_PREFERENCES: WorkbenchPreferences = {
  accent: 'blue',
  density: 'balanced',
  editorFontSize: 12.5,
  editorLineHeight: 20.25,
  editorZoomLevel: 0,
  theme: 'light-modern',
  localHistoryThrottleSeconds: 60,
}

export const WORKBENCH_EDITOR_FONT_SIZE_MIN = 11
export const WORKBENCH_EDITOR_FONT_SIZE_MAX = 18
export const WORKBENCH_EDITOR_FONT_SIZE_STEP = 0.5
export const WORKBENCH_EDITOR_ZOOM_LEVEL_MIN = -4
export const WORKBENCH_EDITOR_ZOOM_LEVEL_MAX = 8
export const WORKBENCH_EDITOR_ZOOM_SCALE_STEP = 1.05

export type WorkbenchEditorZoomAction = 'increase' | 'decrease' | 'reset'

/** 本地历史节流窗口上限（秒）：1 小时足够，避免误配成永不记录。 */
export const MAX_LOCAL_HISTORY_THROTTLE_SECONDS = 3600

export const WORKBENCH_PREFERENCES_CHANGED_EVENT = 'velaros:workbench-preferences-changed'
export const WORKBENCH_PROJECT_GIT_SETTINGS_CHANGED_EVENT =
  'velaros:workbench-project-git-settings-changed'
export const WORKBENCH_PROJECT_RUN_SETTINGS_CHANGED_EVENT =
  'velaros:workbench-project-run-settings-changed'

const STORAGE_KEY = 'velaros.workbench.preferences.v1'
const PROJECT_GIT_SETTINGS_STORAGE_KEY = 'velaros.workbench.projectGitSettings.v1'
export const PROJECT_RUN_SETTINGS_STORAGE_KEY = 'velaros.workbench.projectRunSettings.v1'

export interface WorkbenchProjectGitSettings {
  gitSshKeyPath: string
}

export const DEFAULT_WORKBENCH_PROJECT_GIT_SETTINGS: WorkbenchProjectGitSettings = {
  gitSshKeyPath: '',
}

/** 用户为某个项目手动配置的启动/运行命令。为空则回退到包管理器自动探测。 */
export interface WorkbenchProjectRunSettings {
  command: string
}

export const DEFAULT_WORKBENCH_PROJECT_RUN_SETTINGS: WorkbenchProjectRunSettings = {
  command: '',
}

const WorkbenchThemes = new Set<WorkbenchThemeId>([
  'light-modern',
  'dark-modern',
  'warm-paper',
  'midnight-blue',
])
const WorkbenchDarkThemes = new Set<WorkbenchThemeId>(['dark-modern', 'midnight-blue'])

export function isWorkbenchDarkTheme(theme: WorkbenchThemeId): boolean {
  return WorkbenchDarkThemes.has(theme)
}
const WorkbenchDensities = new Set<WorkbenchDensity>(['compact', 'balanced', 'comfortable'])

export function getWorkbenchFileTreeRowHeight(density: WorkbenchDensity): number {
  switch (density) {
    case 'compact':
      return 20
    case 'comfortable':
      return 27
    default:
      return 23
  }
}
const WorkbenchAccents = new Set<WorkbenchAccent>([
  'blue',
  'teal',
  'green',
  'amber',
  'orange',
  'rose',
  'violet',
  'slate',
])

function clampNumber(value: any, min: number, max: number, fallback: number): number {
  if (!isFiniteNumber(value)) return fallback

  return Math.min(max, Math.max(min, value))
}

/** 快捷键只改变代码区缩放级别，不改写用户配置的基础字号或行高。 */
export function getZoomedWorkbenchEditorZoomLevel(
  currentLevel: number,
  action: WorkbenchEditorZoomAction
): number {
  if (action === 'reset') return 0

  const normalizedLevel = Math.round(
    clampNumber(currentLevel, WORKBENCH_EDITOR_ZOOM_LEVEL_MIN, WORKBENCH_EDITOR_ZOOM_LEVEL_MAX, 0)
  )
  return clampNumber(
    normalizedLevel + (action === 'increase' ? 1 : -1),
    WORKBENCH_EDITOR_ZOOM_LEVEL_MIN,
    WORKBENCH_EDITOR_ZOOM_LEVEL_MAX,
    0
  )
}

export function getWorkbenchEditorZoomScale(level: number): number {
  const normalizedLevel = Math.round(
    clampNumber(level, WORKBENCH_EDITOR_ZOOM_LEVEL_MIN, WORKBENCH_EDITOR_ZOOM_LEVEL_MAX, 0)
  )
  return WORKBENCH_EDITOR_ZOOM_SCALE_STEP ** normalizedLevel
}

function roundWorkbenchEditorMetric(value: number): number {
  return Math.round(value * 100) / 100
}

/**
 * 把设置面板的基础尺寸和快捷键缩放收敛成 CodeMirror 唯一的几何输入。
 * 光标、选区、行号和挂载浮层都用同一个 key 刷新，避免各自监听 CSS 变化。
 */
export function getWorkbenchEditorMetrics(
  preferences: WorkbenchPreferences
): WorkbenchEditorMetrics {
  const scale = getWorkbenchEditorZoomScale(preferences.editorZoomLevel)
  const fontSize = `${roundWorkbenchEditorMetric(preferences.editorFontSize * scale)}px`
  const lineHeight = `${roundWorkbenchEditorMetric(preferences.editorLineHeight * scale)}px`

  return {
    fontSize,
    lineHeight,
    key: `${fontSize}:${lineHeight}`,
  }
}

function normalizeChoice<T extends string>(value: any, allowed: ReadonlySet<T>, fallback: T): T {
  return isString(value) && allowed.has(value as T) ? (value as T) : fallback
}

function normalizeWorkbenchThemeChoice(value: any): WorkbenchThemeId {
  switch (value) {
    // Legacy tinted/neutral light themes collapse onto the neutral VSCode light preset.
    case 'light-plus':
    case 'warm':
    case 'cool':
    case 'light':
    case 'classic':
    case 'graphite':
      return 'light-modern'
    // Legacy dark themes map onto the neutral VSCode dark preset.
    case 'dark-plus':
    case 'dark':
    case 'darcula':
      return 'dark-modern'
  }

  return normalizeChoice(value, WorkbenchThemes, DEFAULT_WORKBENCH_PREFERENCES.theme)
}

export function normalizeWorkbenchPreferences(
  preferences: Partial<WorkbenchPreferences> | undefined
): WorkbenchPreferences {
  return {
    accent: normalizeChoice(
      preferences?.accent,
      WorkbenchAccents,
      DEFAULT_WORKBENCH_PREFERENCES.accent
    ),
    density: normalizeChoice(
      preferences?.density,
      WorkbenchDensities,
      DEFAULT_WORKBENCH_PREFERENCES.density
    ),
    editorFontSize: clampNumber(
      preferences?.editorFontSize,
      WORKBENCH_EDITOR_FONT_SIZE_MIN,
      WORKBENCH_EDITOR_FONT_SIZE_MAX,
      DEFAULT_WORKBENCH_PREFERENCES.editorFontSize
    ),
    editorLineHeight: clampNumber(
      preferences?.editorLineHeight,
      17,
      28,
      DEFAULT_WORKBENCH_PREFERENCES.editorLineHeight
    ),
    editorZoomLevel: Math.round(
      clampNumber(
        preferences?.editorZoomLevel,
        WORKBENCH_EDITOR_ZOOM_LEVEL_MIN,
        WORKBENCH_EDITOR_ZOOM_LEVEL_MAX,
        DEFAULT_WORKBENCH_PREFERENCES.editorZoomLevel
      )
    ),
    theme: normalizeWorkbenchThemeChoice(preferences?.theme),
    localHistoryThrottleSeconds: clampNumber(
      preferences?.localHistoryThrottleSeconds,
      0,
      MAX_LOCAL_HISTORY_THROTTLE_SECONDS,
      DEFAULT_WORKBENCH_PREFERENCES.localHistoryThrottleSeconds
    ),
  }
}

/** 用户手动保存时应用的本地历史节流窗口（毫秒）。 */
export function readWorkbenchLocalHistoryThrottleMs(): number {
  return Math.max(0, Math.round(readWorkbenchPreferences().localHistoryThrottleSeconds * 1000))
}

const workbenchPreferencesStore = createLocalStorageJsonStore<WorkbenchPreferences>({
  key: STORAGE_KEY,
  fallback: DEFAULT_WORKBENCH_PREFERENCES,
  normalize: (value) => normalizeWorkbenchPreferences(value as Partial<WorkbenchPreferences>),
  log,
  readErrorLevel: 'warn',
  readErrorMessage: '工作台偏好读取失败',
  writeErrorMessage: '工作台偏好写入失败',
})

export function readWorkbenchPreferences(storage?: StorageLike): WorkbenchPreferences {
  return workbenchPreferencesStore.read(storage)
}

export function saveWorkbenchPreferences(
  preferences: WorkbenchPreferences,
  storage: StorageLike | undefined = undefined,
  target: Window = window
): void {
  const normalized = normalizeWorkbenchPreferences(preferences)
  workbenchPreferencesStore.write(normalized, storage)
  target.dispatchEvent(
    new CustomEvent(WORKBENCH_PREFERENCES_CHANGED_EVENT, {
      detail: normalized,
    })
  )
}

export function getWorkbenchPreferencesStyle(preferences: WorkbenchPreferences): CSSProperties {
  const editorMetrics = getWorkbenchEditorMetrics(preferences)
  return {
    '--workbench-editor-font-size': editorMetrics.fontSize,
    '--workbench-editor-line-height': editorMetrics.lineHeight,
  } as CSSProperties
}

export function normalizeWorkbenchProjectGitSettings(
  settings: Partial<WorkbenchProjectGitSettings> | undefined
): WorkbenchProjectGitSettings {
  return {
    gitSshKeyPath: settings?.gitSshKeyPath?.trim() ?? '',
  }
}

const workbenchProjectGitSettingsStore = createLocalStorageJsonStore<
  Record<string, Partial<WorkbenchProjectGitSettings>>
>({
  key: PROJECT_GIT_SETTINGS_STORAGE_KEY,
  fallback: () => ({}),
  normalize: (value) =>
    isObject(value) ? (value as Record<string, Partial<WorkbenchProjectGitSettings>>) : {},
  log,
  readErrorLevel: 'warn',
  readErrorMessage: '工作台项目 Git 设置读取失败',
  writeErrorMessage: '工作台项目 Git 设置写入失败',
})

function readProjectGitSettingsStore(
  storage?: StorageLike
): Record<string, Partial<WorkbenchProjectGitSettings>> {
  return workbenchProjectGitSettingsStore.read(storage)
}

export function readWorkbenchProjectGitSettings(
  projectRoot: LooseOptional<string>,
  storage?: StorageLike
): WorkbenchProjectGitSettings {
  if (!projectRoot) return DEFAULT_WORKBENCH_PROJECT_GIT_SETTINGS

  return normalizeWorkbenchProjectGitSettings(readProjectGitSettingsStore(storage)[projectRoot])
}

export function saveWorkbenchProjectGitSettings(
  projectRoot: string,
  settings: WorkbenchProjectGitSettings,
  storage: StorageLike | undefined = undefined,
  target: Window = window
): void {
  const normalized = normalizeWorkbenchProjectGitSettings(settings)
  const store = readProjectGitSettingsStore(storage)

  workbenchProjectGitSettingsStore.write(
    {
      ...store,
      [projectRoot]: normalized,
    },
    storage
  )
  target.dispatchEvent(
    new CustomEvent(WORKBENCH_PROJECT_GIT_SETTINGS_CHANGED_EVENT, {
      detail: {
        projectRoot,
        settings: normalized,
      },
    })
  )
}

export function normalizeWorkbenchProjectRunSettings(
  settings: Partial<WorkbenchProjectRunSettings> | undefined
): WorkbenchProjectRunSettings {
  return {
    command: settings?.command?.trim() ?? '',
  }
}

const workbenchProjectRunSettingsStore = createLocalStorageJsonStore<
  Record<string, Partial<WorkbenchProjectRunSettings>>
>({
  key: PROJECT_RUN_SETTINGS_STORAGE_KEY,
  fallback: () => ({}),
  normalize: (value) =>
    isObject(value) ? (value as Record<string, Partial<WorkbenchProjectRunSettings>>) : {},
  log,
  readErrorLevel: 'warn',
  readErrorMessage: '工作台项目运行命令读取失败',
  writeErrorMessage: '工作台项目运行命令写入失败',
})

function readProjectRunSettingsStore(
  storage?: StorageLike
): Record<string, Partial<WorkbenchProjectRunSettings>> {
  return workbenchProjectRunSettingsStore.read(storage)
}

export function readWorkbenchProjectRunSettings(
  projectRoot: LooseOptional<string>,
  storage?: StorageLike
): WorkbenchProjectRunSettings {
  if (!projectRoot) return DEFAULT_WORKBENCH_PROJECT_RUN_SETTINGS

  return normalizeWorkbenchProjectRunSettings(readProjectRunSettingsStore(storage)[projectRoot])
}

export function saveWorkbenchProjectRunSettings(
  projectRoot: string,
  settings: WorkbenchProjectRunSettings,
  storage: StorageLike | undefined = undefined,
  target: Window = window
): void {
  const normalized = normalizeWorkbenchProjectRunSettings(settings)
  const store = readProjectRunSettingsStore(storage)

  workbenchProjectRunSettingsStore.write(
    {
      ...store,
      [projectRoot]: normalized,
    },
    storage
  )
  target.dispatchEvent(
    new CustomEvent(WORKBENCH_PROJECT_RUN_SETTINGS_CHANGED_EVENT, {
      detail: {
        projectRoot,
        settings: normalized,
      },
    })
  )
}
