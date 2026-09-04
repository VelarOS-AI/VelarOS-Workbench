/** Workbench bundled Mod IPC 契约。安装来源和运行启用由主进程权威维护。 */
export const WorkbenchModChannels = {
  listCatalog: 'workbench-app:mods:list-catalog',
  setEnabled: 'workbench-app:mods:set-enabled',
  changed: 'workbench-app:mods:changed',
} as const

export type WorkbenchModId = 'velaros.browser'
export type WorkbenchModCapabilityKind = 'browser-surface' | 'chat-tools'

export interface WorkbenchModRecord {
  id: WorkbenchModId
  displayName: string
  description: string
  version: string
  source: 'bundled'
  installed: true
  enabled: boolean
  defaultEnabled: boolean
  capabilities: readonly WorkbenchModCapabilityKind[]
}

export interface WorkbenchModCatalog {
  generation: number
  mods: readonly WorkbenchModRecord[]
}

export interface WorkbenchModSetEnabledRequest {
  id: WorkbenchModId
  enabled: boolean
}

/** 通知不携带状态副本；renderer 按世代号重取权威目录。 */
export interface WorkbenchModChangedEvent {
  generation: number
}

export interface WorkbenchModBridge {
  listCatalog: () => Promise<WorkbenchModCatalog>
  setEnabled: (request: WorkbenchModSetEnabledRequest) => Promise<WorkbenchModCatalog>
  onChanged: (listener: (event: WorkbenchModChangedEvent) => void) => () => void
}
