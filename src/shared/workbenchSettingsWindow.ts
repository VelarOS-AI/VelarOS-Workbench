import type { WorkbenchFsCallResult } from './workbenchFs'

/** The settings renderer shares the app origin and its preference stores. */
export const WorkbenchSettingsWindowQuery = 'settings'

export const WorkbenchSettingsWindowChannels = {
  open: 'workbench-app:settings-window:open',
  ready: 'workbench-app:settings-window:ready',
  close: 'workbench-app:settings-window:close',
  exitProject: 'workbench-app:settings-window:exit-project',
  tavilyConfigured: 'workbench-app:settings-window:tavily-configured',
  setTavilyApiKey: 'workbench-app:settings-window:set-tavily-api-key',
} as const

export interface WorkbenchSettingsWindowBridge {
  open: () => Promise<void>
  ready: () => Promise<void>
  close: () => Promise<void>
  exitProject: () => Promise<void>
  getTavilyConfigured: () => Promise<boolean>
  setTavilyApiKey: (apiKey: string) => Promise<WorkbenchFsCallResult<boolean>>
}
