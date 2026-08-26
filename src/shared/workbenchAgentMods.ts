import type { WorkbenchAgentEngineId } from '../plugins/agent-engines/identity'

export const WorkbenchAgentModChannels = {
  list: 'workbench-app:mods:list',
  setEnabled: 'workbench-app:mods:set-enabled',
  listAgentEngineModels: 'workbench-app:mods:list-agent-engine-models',
  changed: 'workbench-app:mods:changed',
} as const

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

export interface WorkbenchModRecord {
  id: 'velaros.agent-engines'
  displayName: string
  description: string
  version: string
  enabled: boolean
}

export interface WorkbenchModCatalog {
  generatedAt: number
  mods: readonly WorkbenchModRecord[]
}

export interface WorkbenchModSetEnabledRequest {
  id: WorkbenchModRecord['id']
  enabled: boolean
}

export interface WorkbenchAgentModBridge {
  list: () => Promise<WorkbenchModCatalog>
  setEnabled: (request: WorkbenchModSetEnabledRequest) => Promise<WorkbenchModCatalog>
  listAgentEngineModels: (
    engineId: WorkbenchAgentEngineId
  ) => Promise<WorkbenchAgentEngineModelCatalog>
  onChanged: (listener: (catalog: WorkbenchModCatalog) => void) => () => void
}
