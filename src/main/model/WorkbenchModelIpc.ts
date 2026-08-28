import { ipcMain } from 'electron'

import type { ProviderModelCatalogService } from '@velaros-ai/model'
import type { ChatProviderId, ListProviderModelsRequest } from '@velaros-ai/model/contracts'

import {
  type WorkbenchListProviderModelsRequest,
  WorkbenchModelChannels,
} from '../../shared/workbenchModel'

export function registerWorkbenchModelIpc(service: ProviderModelCatalogService): () => void {
  ipcMain.handle(WorkbenchModelChannels.listProviderModels, (_event, request: unknown) =>
    service.listProviderModels(readListProviderModelsRequest(request)))

  return () => {
    ipcMain.removeHandler(WorkbenchModelChannels.listProviderModels)
  }
}

function readListProviderModelsRequest(request: unknown): ListProviderModelsRequest {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw new Error('Model catalog request must be an object.')
  }
  const value = request as Partial<Record<keyof WorkbenchListProviderModelsRequest, unknown>>
  if (
    typeof value.provider !== 'string'
    || typeof value.apiKey !== 'string'
    || typeof value.baseURL !== 'string'
  ) {
    throw new Error('Model catalog request has invalid provider configuration.')
  }
  if (value.defaultModel !== undefined && typeof value.defaultModel !== 'string') {
    throw new Error('Model catalog default model must be a string.')
  }
  if (value.purpose !== undefined && value.purpose !== 'chat' && value.purpose !== 'embedding') {
    throw new Error('Model catalog purpose is invalid.')
  }

  return {
    provider: value.provider as ChatProviderId,
    apiKey: value.apiKey,
    baseURL: value.baseURL,
    ...(typeof value.defaultModel === 'string' ? { defaultModel: value.defaultModel } : {}),
    ...(value.purpose ? { purpose: value.purpose } : {}),
  }
}
