import type {
  ListProviderModelsRequest,
  ProviderModelCatalog,
} from '@velaros-ai/model/contracts'

export const WorkbenchModelChannels = {
  listProviderModels: 'workbench-app:model:list-provider-models',
} as const

export type WorkbenchListProviderModelsRequest = Pick<
  ListProviderModelsRequest,
  'provider' | 'apiKey' | 'baseURL' | 'defaultModel' | 'purpose'
>

export interface WorkbenchModelBridge {
  listProviderModels: (
    request: WorkbenchListProviderModelsRequest
  ) => Promise<ProviderModelCatalog>
}
