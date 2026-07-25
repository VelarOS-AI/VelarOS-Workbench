import type { CSSProperties } from 'react'

import { isFiniteNumber, isObject,isString, Log } from '@velaros/core'

import {
  createLocalStorageJsonStore,
  type StorageLike,
} from '../../persistence/localStorageJsonStore'

const log = Log.tag('workbench-preferences')

export type WorkbenchThemeId = 'light-modern' | 'dark-modern' | 'dark-plus' | 'light-plus'
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
  theme: WorkbenchThemeId
  /**
   * 是否启用 AI Tab 内联补全（Cursor 式 ghost text）。服务商/模型在设置的 AI 补全区配置。
   * 默认关闭：远端补全往返可能偏慢，先让用户显式开启。
   */
  aiCompletionEnabled: boolean
  /**
   * 用户手动编辑的本地历史快照节流窗口（秒）：自动保存时距上一份快照不足该间隔就不新增，
   * 省内存、更轻量。0=每次保存都存快照。AI/工具改动不受此限制，始终每次都存。
   */
  localHistoryThrottleSeconds: number
}

export const DEFAULT_WORKBENCH_PREFERENCES: WorkbenchPreferences = {
  accent: 'blue',
  density: 'balanced',
  editorFontSize: 12.5,
  editorLineHeight: 20.25,
  theme: 'light-modern',
  aiCompletionEnabled: false,
  localHistoryThrottleSeconds: 60,
}

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
  'dark-plus',
  'light-plus',
])
const WorkbenchDarkThemes = new Set<WorkbenchThemeId>(['dark-modern', 'dark-plus'])

export function isWorkbenchDarkTheme(theme: WorkbenchThemeId): boolean {
  return WorkbenchDarkThemes.has(theme)
}
const WorkbenchDensities = new Set<WorkbenchDensity>(['compact', 'balanced', 'comfortable'])
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

function normalizeChoice<T extends string>(value: any, allowed: ReadonlySet<T>, fallback: T): T {
  return isString(value) && allowed.has(value as T) ? (value as T) : fallback
}

function normalizeWorkbenchThemeChoice(value: any): WorkbenchThemeId {
  switch (value) {
    // Legacy tinted/neutral light themes collapse onto the neutral VSCode light preset.
    case 'warm':
    case 'cool':
    case 'light':
    case 'classic':
    case 'graphite':
      return 'light-modern'
    // Legacy dark themes map onto the neutral VSCode dark preset.
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
      11,
      18,
      DEFAULT_WORKBENCH_PREFERENCES.editorFontSize
    ),
    editorLineHeight: clampNumber(
      preferences?.editorLineHeight,
      17,
      28,
      DEFAULT_WORKBENCH_PREFERENCES.editorLineHeight
    ),
    theme: normalizeWorkbenchThemeChoice(preferences?.theme),
    aiCompletionEnabled:
      typeof preferences?.aiCompletionEnabled === 'boolean'
        ? preferences.aiCompletionEnabled
        : DEFAULT_WORKBENCH_PREFERENCES.aiCompletionEnabled,
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
  return {
    '--workbench-editor-font-size': `${preferences.editorFontSize}px`,
    '--workbench-editor-line-height': `${preferences.editorLineHeight}px`,
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
