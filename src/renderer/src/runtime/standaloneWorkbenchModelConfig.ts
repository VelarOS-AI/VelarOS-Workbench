import { useSyncExternalStore } from 'react'

export interface StandaloneWorkbenchModelConfig {
  provider: string
  model: string
  baseURL: string
  /** 密钥只驻留当前 renderer 进程，不写 localStorage。 */
  apiKey: string
}

const ModelConfigStorageKey = 'velaros-workbench-app:model-config'
const DefaultModelConfig: StandaloneWorkbenchModelConfig = {
  provider: 'openai',
  model: 'gpt-4.1',
  baseURL: 'https://api.openai.com/v1',
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
    return {
      provider:
        typeof stored.provider === 'string' && stored.provider.trim()
          ? stored.provider
          : DefaultModelConfig.provider,
      model:
        typeof stored.model === 'string' && stored.model.trim()
          ? stored.model
          : DefaultModelConfig.model,
      baseURL:
        typeof stored.baseURL === 'string' && stored.baseURL.trim()
          ? stored.baseURL
          : DefaultModelConfig.baseURL,
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
