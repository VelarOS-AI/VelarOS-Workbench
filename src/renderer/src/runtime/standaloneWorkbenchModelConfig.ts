import { useSyncExternalStore } from 'react'

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
  /** 密钥只驻留当前 renderer 进程，不写 localStorage。 */
  apiKey: string
}

const ModelConfigStorageKey = 'velaros-workbench-app:model-config'
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

function readInitialModelConfig(): StandaloneWorkbenchModelConfig {
  if (typeof window === 'undefined') return DefaultModelConfig

  try {
    const raw = window.localStorage.getItem(ModelConfigStorageKey)
    if (!raw) return DefaultModelConfig

    const stored = JSON.parse(raw) as Record<string, unknown>
    const provider = getStandaloneWorkbenchModelProviderPreset(
      typeof stored.provider === 'string' ? stored.provider : DefaultModelConfig.provider
    )
    return {
      provider: provider.id,
      model: resolveStandaloneWorkbenchProviderModel(
        provider.id,
        typeof stored.model === 'string' ? stored.model : undefined,
        'agent'
      ),
      completionModel: resolveStandaloneWorkbenchProviderModel(
        provider.id,
        typeof stored.completionModel === 'string' ? stored.completionModel : undefined,
        'completion'
      ),
      baseURL: provider.defaultBaseURL,
      apiKey: '',
    }
  } catch {
    return DefaultModelConfig
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
  currentConfig = { ...currentConfig, ...patch }
  persistNonSecretModelConfig(currentConfig)
  for (const listener of listeners) listener()
}

export function selectStandaloneWorkbenchModelProvider(providerId: string): void {
  const provider = getStandaloneWorkbenchModelProviderPreset(providerId)
  updateStandaloneWorkbenchModelConfig({
    provider: provider.id,
    model: provider.defaultModel,
    completionModel: provider.completionModel,
    baseURL: provider.defaultBaseURL,
    apiKey: '',
  })
}

export function selectStandaloneWorkbenchModel(
  providerId: string,
  model: string,
  kind: 'agent' | 'completion'
): void {
  const provider = getStandaloneWorkbenchModelProviderPreset(providerId)
  const selected = resolveStandaloneWorkbenchProviderModel(provider.id, model, kind)
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
  updateStandaloneWorkbenchModelConfig({
    provider: provider.id,
    model: resolveStandaloneWorkbenchProviderModel(provider.id, model, 'agent'),
    completionModel: providerChanged ? provider.completionModel : currentConfig.completionModel,
    baseURL: provider.defaultBaseURL,
    apiKey: providerChanged ? '' : currentConfig.apiKey,
  })
}

export function getStandaloneWorkbenchModelConfig(): StandaloneWorkbenchModelConfig {
  return currentConfig
}

export function useStandaloneWorkbenchModelConfig(): StandaloneWorkbenchModelConfig {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => currentConfig,
    () => DefaultModelConfig
  )
}
