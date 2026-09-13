import { ipcMain } from 'electron'

import type { ProviderModelCatalogService } from '@velaros-ai/model'
import type { ChatProviderId, ListProviderModelsRequest } from '@velaros-ai/model/contracts'

import {
  type WorkbenchListProviderModelsRequest,
  type WorkbenchManagedModelProviderId,
  type WorkbenchModelApiKeyRequest,
  type WorkbenchModelApiKeyUpdate,
  WorkbenchModelChannels,
} from '../../shared/workbenchModel'
import type { WorkbenchAccountService } from '../account/WorkbenchAccountService'

import { WorkbenchModelCredentialStore } from './WorkbenchModelCredentialStore'

export function registerWorkbenchModelIpc(
  service: ProviderModelCatalogService,
  dataRootDir: string,
  accountService: WorkbenchAccountService
): () => void {
  const credentialStore = new WorkbenchModelCredentialStore(dataRootDir)
  ipcMain.handle(WorkbenchModelChannels.listProviderModels, (_event, request: unknown) => {
    const parsed = readListProviderModelsRequest(request)
    const providerId = readManagedProviderId(parsed.provider)
    return providerId
      ? accountService.listManagedProviderModels(providerId)
      : service.listProviderModels(parsed)
  })
  ipcMain.handle(WorkbenchModelChannels.listManagedProviders, () =>
    accountService.getManagedModelAccess())
  ipcMain.handle(WorkbenchModelChannels.getApiKey, (_event, request: unknown) =>
    credentialStore.getApiKey(readApiKeyRequest(request).provider))
  ipcMain.handle(WorkbenchModelChannels.setApiKey, (_event, request: unknown) => {
    const update = readApiKeyUpdate(request)
    return credentialStore.setApiKey(update.provider, update.apiKey)
  })

  return () => {
    ipcMain.removeHandler(WorkbenchModelChannels.listProviderModels)
    ipcMain.removeHandler(WorkbenchModelChannels.listManagedProviders)
    ipcMain.removeHandler(WorkbenchModelChannels.getApiKey)
    ipcMain.removeHandler(WorkbenchModelChannels.setApiKey)
  }
}

function readManagedProviderId(provider: string): WorkbenchManagedModelProviderId | null {
  if (provider === 'velar' || provider === 'velar-dev') return provider
  return null
}

function readApiKeyRequest(request: unknown): WorkbenchModelApiKeyRequest {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw new Error('Model credential request must be an object.')
  }
  const provider = (request as Partial<WorkbenchModelApiKeyRequest>).provider
  if (typeof provider !== 'string' || !provider.trim()) {
    throw new Error('Model credential provider is invalid.')
  }
  return { provider }
}

function readApiKeyUpdate(request: unknown): WorkbenchModelApiKeyUpdate {
  const parsed = readApiKeyRequest(request)
  const apiKey = (request as Partial<WorkbenchModelApiKeyUpdate>).apiKey
  if (typeof apiKey !== 'string') throw new Error('Model credential API key is invalid.')
  return { ...parsed, apiKey }
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
    defaultModel: value.defaultModel,
    purpose: value.purpose,
  }
}
