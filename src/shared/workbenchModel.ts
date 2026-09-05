import type {
  ListProviderModelsRequest,
  ProviderModelCatalog,
} from '@velaros-ai/model/contracts'

export const WorkbenchModelChannels = {
  listProviderModels: 'workbench-app:model:list-provider-models',
  listManagedProviders: 'workbench-app:model:list-managed-providers',
  getApiKey: 'workbench-app:model:get-api-key',
  setApiKey: 'workbench-app:model:set-api-key',
} as const

export type WorkbenchManagedModelProviderId = 'velar' | 'velar-dev'

export interface WorkbenchManagedModelOption {
  readonly id: string
  readonly label: string
  readonly status: 'available' | 'disabled' | 'not-configured'
}

/**
 * Cloud 在线账号快照对 Workbench 的最小投影。
 *
 * 只有 `/v1/account/usage.managedModels` 中真实存在的服务才会进入这个列表；renderer
 * 不从账号角色、本地缓存或 provider manifest 猜测授权。
 */
export interface WorkbenchManagedModelProvider {
  readonly providerId: WorkbenchManagedModelProviderId
  readonly displayName: string
  readonly enabled: boolean
  readonly defaultModel?: string
  readonly models: readonly WorkbenchManagedModelOption[]
}

export interface WorkbenchManagedModelAccessSnapshot {
  readonly managedModels: readonly WorkbenchManagedModelProvider[]
  readonly updatedAt: string
}

export type WorkbenchListProviderModelsRequest = Pick<
  ListProviderModelsRequest,
  'provider' | 'apiKey' | 'baseURL' | 'defaultModel' | 'purpose'
>

export interface WorkbenchModelApiKeyRequest {
  provider: string
}

export interface WorkbenchModelApiKeyUpdate extends WorkbenchModelApiKeyRequest {
  apiKey: string
}

export interface WorkbenchModelBridge {
  listProviderModels: (
    request: WorkbenchListProviderModelsRequest
  ) => Promise<ProviderModelCatalog>
  listManagedProviders: () => Promise<WorkbenchManagedModelAccessSnapshot>
  getApiKey: (request: WorkbenchModelApiKeyRequest) => Promise<string>
  setApiKey: (request: WorkbenchModelApiKeyUpdate) => Promise<void>
}
