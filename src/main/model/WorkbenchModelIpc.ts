import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { ipcMain, safeStorage } from 'electron'

import type { ProviderModelCatalogService } from '@velaros-ai/model'
import type { ChatProviderId, ListProviderModelsRequest } from '@velaros-ai/model/contracts'

import {
  type WorkbenchListProviderModelsRequest,
  type WorkbenchModelApiKeyRequest,
  type WorkbenchModelApiKeyUpdate,
  WorkbenchModelChannels,
} from '../../shared/workbenchModel'

const ModelCredentialsFileName = 'model-credentials.json'

interface StoredModelCredentials {
  version: 1
  apiKeys: Record<string, string>
}

class WorkbenchModelCredentialStore {
  private credentials: StoredModelCredentials | null = null
  private writeQueue: Promise<void> = Promise.resolve()

  public constructor(private readonly path: string) {}

  public async getApiKey(provider: string): Promise<string> {
    if (!safeStorage.isEncryptionAvailable()) return ''
    const encrypted = (await this.read()).apiKeys[provider]
    if (!encrypted) return ''

    try {
      return safeStorage.decryptString(Buffer.from(encrypted, 'base64'))
    } catch {
      return ''
    }
  }

  public async setApiKey(provider: string, apiKey: string): Promise<void> {
    this.writeQueue = this.writeQueue.catch(() => undefined).then(async () => {
      if (!safeStorage.isEncryptionAvailable()) {
        throw new Error('Secure credential storage is unavailable.')
      }

      const credentials = await this.read()
      if (apiKey) {
        credentials.apiKeys[provider] = safeStorage.encryptString(apiKey).toString('base64')
      } else {
        delete credentials.apiKeys[provider]
      }
      await mkdir(dirname(this.path), { recursive: true })
      const temporaryPath = `${this.path}.tmp`
      await writeFile(temporaryPath, JSON.stringify(credentials), { mode: 0o600 })
      await rename(temporaryPath, this.path)
    })
    return this.writeQueue
  }

  private async read(): Promise<StoredModelCredentials> {
    if (this.credentials) return this.credentials
    try {
      const parsed = JSON.parse(await readFile(this.path, 'utf8')) as Partial<StoredModelCredentials>
      this.credentials = {
        version: 1,
        apiKeys:
          parsed.apiKeys && typeof parsed.apiKeys === 'object' && !Array.isArray(parsed.apiKeys)
            ? parsed.apiKeys
            : {},
      }
    } catch {
      this.credentials = { version: 1, apiKeys: {} }
    }
    return this.credentials
  }
}

export function registerWorkbenchModelIpc(
  service: ProviderModelCatalogService,
  dataRootDir: string
): () => void {
  const credentialStore = new WorkbenchModelCredentialStore(
    join(dataRootDir, ModelCredentialsFileName)
  )
  ipcMain.handle(WorkbenchModelChannels.listProviderModels, (_event, request: unknown) =>
    service.listProviderModels(readListProviderModelsRequest(request)))
  ipcMain.handle(WorkbenchModelChannels.getApiKey, (_event, request: unknown) =>
    credentialStore.getApiKey(readApiKeyRequest(request).provider))
  ipcMain.handle(WorkbenchModelChannels.setApiKey, (_event, request: unknown) => {
    const update = readApiKeyUpdate(request)
    return credentialStore.setApiKey(update.provider, update.apiKey)
  })

  return () => {
    ipcMain.removeHandler(WorkbenchModelChannels.listProviderModels)
    ipcMain.removeHandler(WorkbenchModelChannels.getApiKey)
    ipcMain.removeHandler(WorkbenchModelChannels.setApiKey)
  }
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
    ...(typeof value.defaultModel === 'string' ? { defaultModel: value.defaultModel } : {}),
    ...(value.purpose ? { purpose: value.purpose } : {}),
  }
}
