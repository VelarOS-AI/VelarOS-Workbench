import type {
  ListProviderModelsRequest,
  ProviderModelCatalog,
} from '@velaros-ai/model/contracts'

export const WorkbenchModelChannels = {
  listProviderModels: 'workbench-app:model:list-provider-models',
  getApiKey: 'workbench-app:model:get-api-key',
  setApiKey: 'workbench-app:model:set-api-key',
} as const

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
  getApiKey: (request: WorkbenchModelApiKeyRequest) => Promise<string>
  setApiKey: (request: WorkbenchModelApiKeyUpdate) => Promise<void>
}
