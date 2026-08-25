export const WorkbenchResourcePluginChannels = {
  list: 'workbench-app:resource-plugins:list',
  install: 'workbench-app:resource-plugins:install',
  setEnabled: 'workbench-app:resource-plugins:set-enabled',
  changed: 'workbench-app:resource-plugins:changed',
} as const

export type WorkbenchResourcePluginId = 'codegraph'
export type WorkbenchResourcePluginStatus =
  | 'available'
  | 'disabled'
  | 'missing'
  | 'installing'
  | 'failed'

export interface WorkbenchResourcePluginRecord {
  id: WorkbenchResourcePluginId
  status: WorkbenchResourcePluginStatus
  installed: boolean
  enabled: boolean
  canInstall: boolean
  version: string | null
  packageRoot: string | null
  progress: number | null
  error: string | null
}

export interface WorkbenchResourcePluginCatalog {
  generatedAt: number
  plugins: readonly WorkbenchResourcePluginRecord[]
}

export interface WorkbenchResourcePluginSetEnabledRequest {
  id: WorkbenchResourcePluginId
  enabled: boolean
}

export interface WorkbenchResourcePluginInstallRequest {
  id: WorkbenchResourcePluginId
}

export interface WorkbenchResourcePluginBridge {
  list: () => Promise<WorkbenchResourcePluginCatalog>
  install: (
    request: WorkbenchResourcePluginInstallRequest
  ) => Promise<WorkbenchResourcePluginCatalog>
  setEnabled: (
    request: WorkbenchResourcePluginSetEnabledRequest
  ) => Promise<WorkbenchResourcePluginCatalog>
  onChanged: (
    listener: (catalog: WorkbenchResourcePluginCatalog) => void
  ) => () => void
}
