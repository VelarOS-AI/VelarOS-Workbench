import { useEffect, useSyncExternalStore } from 'react'

import type { ChatProviderId } from '@velaros-ai/velaros/model/contracts'

import { isStandaloneWorkbenchModelProviderSelectable } from './standaloneWorkbenchManagedModels'
import {
  getStandaloneWorkbenchModelProviderPreset,
  resolveStandaloneWorkbenchProviderModel,
} from './standaloneWorkbenchModelCatalog'

export interface StandaloneWorkbenchModelConfig {
  provider: ChatProviderId
  model: string
  completionModel: string
  baseURL: string
  /** 密钥由 main 进程在应用数据目录内加密持久化，不写 localStorage。 */
  apiKey: string
}

const ModelConfigStorageKey = 'velaros-workbench-app:model-config'
const ModelCredentialRevisionKey = 'velaros-workbench-app:model-credential-revision'
const LegacyPreferencesStorageKey = 'velaros.workbench.preferences.v1'
export const StandaloneWorkbenchCompletionDisabledOptionValue = 'workbench:none'
const DefaultProvider = getStandaloneWorkbenchModelProviderPreset('openrouter')
const DefaultModelConfig: StandaloneWorkbenchModelConfig = {
  provider: DefaultProvider.id,
  model: DefaultProvider.defaultModel,
  completionModel: DefaultProvider.completionModel,
  baseURL: DefaultProvider.defaultBaseURL,
  apiKey: '',
}

const listeners = new Set<() => void>()
let currentConfig = readInitialModelConfig()
let apiKeyMutationVersion = 0
let apiKeyHydrationRequest = 0
let initialApiKeyHydrationStarted = false

function readInitialModelConfig(): StandaloneWorkbenchModelConfig {
  if (typeof window === 'undefined') return DefaultModelConfig

  const legacyAiCompletionEnabled = consumeLegacyAiCompletionEnabled()
  try {
    const raw = window.localStorage.getItem(ModelConfigStorageKey)
    if (!raw) {
      const config = {
        ...DefaultModelConfig,
        completionModel:
          legacyAiCompletionEnabled === false ? '' : DefaultModelConfig.completionModel,
      }
      if (legacyAiCompletionEnabled !== undefined) persistNonSecretModelConfig(config)
      return config
    }

    const stored = JSON.parse(raw) as Record<string, unknown>
    const provider = getStandaloneWorkbenchModelProviderPreset(
      typeof stored.provider === 'string' ? stored.provider : DefaultModelConfig.provider
    )
    // 存下的服务商已经不在目录里时退回默认服务商，它的模型也一并不认，用默认服务商自己的默认模型。
    const storedForProvider = stored.provider === provider.id
    const storedCompletionModel =
      storedForProvider && typeof stored.completionModel === 'string'
        ? stored.completionModel
        : undefined
    const config = {
      provider: provider.id,
      model: resolveStandaloneWorkbenchProviderModel(
        provider.id,
        storedForProvider && typeof stored.model === 'string' ? stored.model : undefined,
        'agent'
      ),
      completionModel:
        legacyAiCompletionEnabled === false || storedCompletionModel === ''
          ? ''
          : resolveStandaloneWorkbenchProviderModel(
              provider.id,
              storedCompletionModel,
              'completion'
            ),
      baseURL:
        provider.baseURLConfigurable && typeof stored.baseURL === 'string'
          ? stored.baseURL
          : provider.defaultBaseURL,
      apiKey: '',
    }
    if (legacyAiCompletionEnabled !== undefined) persistNonSecretModelConfig(config)
    return config
  } catch {
    return {
      ...DefaultModelConfig,
      completionModel:
        legacyAiCompletionEnabled === false ? '' : DefaultModelConfig.completionModel,
    }
  }
}

function consumeLegacyAiCompletionEnabled(): boolean | undefined {
  try {
    const raw = window.localStorage.getItem(LegacyPreferencesStorageKey)
    if (!raw) return undefined
    const stored = JSON.parse(raw)
    if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return undefined

    const preferences = stored as Record<string, unknown>
    if (typeof preferences.aiCompletionEnabled !== 'boolean') return undefined

    const enabled = preferences.aiCompletionEnabled
    delete preferences.aiCompletionEnabled
    window.localStorage.setItem(LegacyPreferencesStorageKey, JSON.stringify(preferences))
    return enabled
  } catch {
    return undefined
  }
}

function persistNonSecretModelConfig(config: StandaloneWorkbenchModelConfig): void {
  if (typeof window === 'undefined') return

  try {
    window.localStorage.setItem(
      ModelConfigStorageKey,
      JSON.stringify({
        provider: config.provider,
        model: config.model,
        completionModel: config.completionModel,
        baseURL: config.baseURL,
      })
    )
  } catch {
    // 设置仍对当前进程生效；非敏感偏好持久化失败不阻断聊天。
  }
}

export function updateStandaloneWorkbenchModelConfig(
  patch: Partial<StandaloneWorkbenchModelConfig>
): void {
  applyStandaloneWorkbenchModelConfig(patch)
}

function applyStandaloneWorkbenchModelConfig(
  patch: Partial<StandaloneWorkbenchModelConfig>,
  persistApiKey = Object.prototype.hasOwnProperty.call(patch, 'apiKey')
): void {
  currentConfig = { ...currentConfig, ...patch }
  persistNonSecretModelConfig(currentConfig)
  if (persistApiKey) {
    apiKeyMutationVersion += 1
    persistApiKeyForProvider(currentConfig.provider, currentConfig.apiKey)
  }
  for (const listener of listeners) listener()
}

function persistApiKeyForProvider(provider: string, apiKey: string): void {
  if (typeof window === 'undefined' || !window.velarosWorkbenchModel) return
  if (getStandaloneWorkbenchModelProviderPreset(provider).managedByCloud) return
  void window.velarosWorkbenchModel
    .setApiKey({ provider, apiKey })
    .then(() => {
      // 设置窗口写完加密凭据后，通知已打开的工作区重新读取；信号里不含密钥。
      window.localStorage.setItem(
        ModelCredentialRevisionKey,
        `${Date.now()}:${apiKeyMutationVersion}`
      )
    })
    .catch(() => undefined)
}

async function hydrateApiKeyForProvider(provider: string): Promise<void> {
  if (typeof window === 'undefined' || !window.velarosWorkbenchModel) return
  if (getStandaloneWorkbenchModelProviderPreset(provider).managedByCloud) {
    applyStandaloneWorkbenchModelConfig({ apiKey: '' }, false)
    return
  }
  const request = ++apiKeyHydrationRequest
  const mutationVersion = apiKeyMutationVersion
  const apiKey = await window.velarosWorkbenchModel.getApiKey({ provider }).catch(() => '')
  if (
    request !== apiKeyHydrationRequest ||
    mutationVersion !== apiKeyMutationVersion ||
    currentConfig.provider !== provider
  )
    return
  applyStandaloneWorkbenchModelConfig({ apiKey }, false)
}

export function hydrateStandaloneWorkbenchModelApiKey(): void {
  if (initialApiKeyHydrationStarted) return
  initialApiKeyHydrationStarted = true
  window.addEventListener('storage', (event) => {
    if (event.key !== ModelConfigStorageKey && event.key !== ModelCredentialRevisionKey) return
    const next = readInitialModelConfig()
    currentConfig = {
      ...next,
      apiKey: next.provider === currentConfig.provider ? currentConfig.apiKey : '',
    }
    for (const listener of listeners) listener()
    void hydrateApiKeyForProvider(next.provider)
  })
  void hydrateApiKeyForProvider(currentConfig.provider)
}

export function selectStandaloneWorkbenchModelProvider(
  providerId: string,
  defaults?: { readonly model: string; readonly completionModel?: string }
): void {
  if (!isStandaloneWorkbenchModelProviderSelectable(providerId)) return
  const provider = getStandaloneWorkbenchModelProviderPreset(providerId)
  const model = defaults?.model ?? provider.defaultModel
  apiKeyHydrationRequest += 1
  applyStandaloneWorkbenchModelConfig(
    {
      provider: provider.id,
      model,
      completionModel: defaults?.completionModel ?? (model || provider.completionModel),
      baseURL: provider.defaultBaseURL,
      apiKey: '',
    },
    false
  )
  if (!provider.managedByCloud) void hydrateApiKeyForProvider(provider.id)
}

export function selectStandaloneWorkbenchModel(
  providerId: string,
  model: string,
  kind: 'agent' | 'completion'
): void {
  if (!isStandaloneWorkbenchModelProviderSelectable(providerId)) return
  const provider = getStandaloneWorkbenchModelProviderPreset(providerId)
  const selected =
    kind === 'completion' &&
    (model === StandaloneWorkbenchCompletionDisabledOptionValue || !model.trim())
      ? ''
      : resolveStandaloneWorkbenchProviderModel(provider.id, model, kind)
  updateStandaloneWorkbenchModelConfig(
    kind === 'completion' ? { completionModel: selected } : { model: selected }
  )
}

export function selectStandaloneWorkbenchAgentModel(providerId: string, model: string): void {
  if (!isStandaloneWorkbenchModelProviderSelectable(providerId)) return
  const provider = getStandaloneWorkbenchModelProviderPreset(providerId)
  const providerChanged = currentConfig.provider !== provider.id
  if (providerChanged) apiKeyHydrationRequest += 1
  applyStandaloneWorkbenchModelConfig(
    {
      provider: provider.id,
      model: resolveStandaloneWorkbenchProviderModel(provider.id, model, 'agent'),
      completionModel: providerChanged ? provider.completionModel : currentConfig.completionModel,
      baseURL: providerChanged ? provider.defaultBaseURL : currentConfig.baseURL,
      apiKey: providerChanged ? '' : currentConfig.apiKey,
    },
    false
  )
  if (providerChanged && !provider.managedByCloud) void hydrateApiKeyForProvider(provider.id)
}

export function getStandaloneWorkbenchModelConfig(): StandaloneWorkbenchModelConfig {
  return currentConfig
}

export function subscribeStandaloneWorkbenchModelConfig(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useStandaloneWorkbenchModelConfig(): StandaloneWorkbenchModelConfig {
  useEffect(hydrateStandaloneWorkbenchModelApiKey, [])
  return useSyncExternalStore(
    subscribeStandaloneWorkbenchModelConfig,
    () => currentConfig,
    () => DefaultModelConfig
  )
}
