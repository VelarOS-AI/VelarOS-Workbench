import type { WorkbenchFsCallResult } from './workbenchFs'

/** The settings renderer shares the app origin and its preference stores. */
export const WorkbenchSettingsWindowQuery = 'settings'

export const WorkbenchSettingsWindowChannels = {
  open: 'workbench-app:settings-window:open',
  ready: 'workbench-app:settings-window:ready',
  close: 'workbench-app:settings-window:close',
  exitProject: 'workbench-app:settings-window:exit-project',
  getWebSearch: 'workbench-app:settings-window:get-web-search',
  updateWebSearch: 'workbench-app:settings-window:update-web-search',
} as const

export type WorkbenchWebSearchProvider = 'browser' | 'tavily' | 'custom'

export interface WorkbenchWebSearchSettings {
  provider: WorkbenchWebSearchProvider
  tavilyConfigured: boolean
  custom: { endpoint: string } | null
}

export type WorkbenchWebSearchUpdate =
  | { action: 'select'; provider: WorkbenchWebSearchProvider }
  | { action: 'remove'; provider: 'tavily' | 'custom' }
  | { action: 'save'; provider: 'tavily'; apiKey: string }
  | { action: 'save'; provider: 'custom'; endpoint: string; apiKey: string }

export interface WorkbenchSettingsWindowBridge {
  open: () => Promise<void>
  ready: () => Promise<void>
  close: () => Promise<void>
  exitProject: () => Promise<void>
  getWebSearch: () => Promise<WorkbenchWebSearchSettings>
  updateWebSearch: (
    update: WorkbenchWebSearchUpdate
  ) => Promise<WorkbenchFsCallResult<WorkbenchWebSearchSettings>>
}
