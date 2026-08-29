import { useEffect, useSyncExternalStore } from 'react'

import type { ChatProviderId } from '@velaros-ai/model/contracts'

import {
  getStandaloneWorkbenchModelProviderPreset,
  resolveStandaloneWorkbenchProviderModel,
} from './standaloneWorkbenchModelCatalog'

export interface StandaloneWorkbenchModelConfig {
  provider: ChatProviderId
  model: string
  completionModel: string
  baseURL: string
  /** 密钥由 main 进程使用 Electron safeStorage 加密持久化，不写 localStorage。 */
  apiKey: string
}

const ModelConfigStorageKey = 'velaros-workbench-app:model-config'
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
    const storedCompletionModel =
      typeof stored.completionModel === 'string' ? stored.completionModel : undefined
    const config = {
      provider: provider.id,
      model: resolveStandaloneWorkbenchProviderModel(
        provider.id,
        typeof stored.model === 'string' ? stored.model : undefined,
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
  void window.velarosWorkbenchModel.setApiKey({ provider, apiKey }).catch(() => undefined)
}

async function hydrateApiKeyForProvider(provider: string): Promise<void> {
  if (typeof window === 'undefined' || !window.velarosWorkbenchModel) return
  const request = ++apiKeyHydrationRequest
  const mutationVersion = apiKeyMutationVersion
  const apiKey = await window.velarosWorkbenchModel
    .getApiKey({ provider })
    .catch(() => '')
  if (
    request !== apiKeyHydrationRequest
    || mutationVersion !== apiKeyMutationVersion
    || currentConfig.provider !== provider
  ) return
  applyStandaloneWorkbenchModelConfig({ apiKey }, false)
}

export function hydrateStandaloneWorkbenchModelApiKey(): void {
  if (initialApiKeyHydrationStarted) return
  initialApiKeyHydrationStarted = true
  void hydrateApiKeyForProvider(currentConfig.provider)
}

export function selectStandaloneWorkbenchModelProvider(providerId: string): void {
  const provider = getStandaloneWorkbenchModelProviderPreset(providerId)
  apiKeyHydrationRequest += 1
  applyStandaloneWorkbenchModelConfig({
    provider: provider.id,
    model: provider.defaultModel,
    completionModel: provider.completionModel,
    baseURL: provider.defaultBaseURL,
    apiKey: '',
  }, false)
  void hydrateApiKeyForProvider(provider.id)
}

export function selectStandaloneWorkbenchModel(
  providerId: string,
  model: string,
  kind: 'agent' | 'completion'
): void {
  const provider = getStandaloneWorkbenchModelProviderPreset(providerId)
  const selected =
    kind === 'completion'
    && (model === StandaloneWorkbenchCompletionDisabledOptionValue || !model.trim())
      ? ''
      : resolveStandaloneWorkbenchProviderModel(provider.id, model, kind)
  updateStandaloneWorkbenchModelConfig(
    kind === 'completion' ? { completionModel: selected } : { model: selected }
  )
}

export function selectStandaloneWorkbenchAgentModel(
  providerId: string,
  model: string
): void {
  const provider = getStandaloneWorkbenchModelProviderPreset(providerId)
  const providerChanged = currentConfig.provider !== provider.id
  if (providerChanged) apiKeyHydrationRequest += 1
  applyStandaloneWorkbenchModelConfig({
    provider: provider.id,
    model: resolveStandaloneWorkbenchProviderModel(provider.id, model, 'agent'),
    completionModel: providerChanged ? provider.completionModel : currentConfig.completionModel,
    baseURL: providerChanged ? provider.defaultBaseURL : currentConfig.baseURL,
    apiKey: providerChanged ? '' : currentConfig.apiKey,
  }, false)
  if (providerChanged) void hydrateApiKeyForProvider(provider.id)
}

export function getStandaloneWorkbenchModelConfig(): StandaloneWorkbenchModelConfig {
  return currentConfig
}

export function useStandaloneWorkbenchModelConfig(): StandaloneWorkbenchModelConfig {
  useEffect(hydrateStandaloneWorkbenchModelApiKey, [])
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => currentConfig,
    () => DefaultModelConfig
  )
}
