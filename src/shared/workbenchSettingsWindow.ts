/** The settings renderer shares the app origin and its preference stores. */
export const WorkbenchSettingsWindowQuery = 'settings'

export const WorkbenchSettingsWindowChannels = {
  open: 'workbench-app:settings-window:open',
  close: 'workbench-app:settings-window:close',
  exitProject: 'workbench-app:settings-window:exit-project',
} as const

export interface WorkbenchSettingsWindowBridge {
  open: () => Promise<void>
  close: () => Promise<void>
  exitProject: () => Promise<void>
}
