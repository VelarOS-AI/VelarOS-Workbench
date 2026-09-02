import type { WorkbenchAgentEngineId } from '../plugins/agent-engines/identity'

export const WorkbenchResourcePluginChannels = {
  list: 'workbench-app:resource-plugins:list',
  install: 'workbench-app:resource-plugins:install',
  setEnabled: 'workbench-app:resource-plugins:set-enabled',
  listAgentEngineModels: 'workbench-app:resource-plugins:list-agent-engine-models',
  changed: 'workbench-app:resource-plugins:changed',
} as const

export type WorkbenchResourcePluginId = 'codegraph' | 'claude-agent' | 'codex-agent'
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

export interface WorkbenchAgentEngineModelOption {
  value: string
  label: string
  description?: string
  isDefault: boolean
}

export interface WorkbenchAgentEngineModelCatalog {
  engineId: WorkbenchAgentEngineId
  available: boolean
  reason?: string
  models: readonly WorkbenchAgentEngineModelOption[]
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
  listAgentEngineModels: (
    engineId: WorkbenchAgentEngineId
  ) => Promise<WorkbenchAgentEngineModelCatalog>
  onChanged: (
    listener: (catalog: WorkbenchResourcePluginCatalog) => void
  ) => () => void
}
