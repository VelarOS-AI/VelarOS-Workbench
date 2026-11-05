import { useEffect, useMemo, useState } from 'react'

import type { ProviderModelCatalog } from '@velaros-ai/velaros/model/contracts'

import type {
  WorkbenchListProviderModelsRequest,
  WorkbenchManagedModelProvider,
} from '@shared/workbenchModel'

import {
  isStandaloneWorkbenchManagedProviderId,
  type StandaloneWorkbenchManagedModelState,
} from '../runtime/standaloneWorkbenchManagedModels'
import type { StandaloneWorkbenchModelConfig } from '../runtime/standaloneWorkbenchModelConfig'

const CatalogRefreshMs = 60_000
const requests = new Map<string, Promise<ProviderModelCatalog>>()
const catalogs = new Map<string, { catalog: ProviderModelCatalog; loadedAt: number }>()

/** 设置和聊天共用远端目录；相同连接只发一次请求，连接变化后不展示旧目录。 */
export function loadWorkbenchProviderModelCatalog(
  request: WorkbenchListProviderModelsRequest,
  refresh = false
): Promise<ProviderModelCatalog> {
  const key = JSON.stringify(request)
  const pending = requests.get(key)
  if (pending) return pending
  const cached = catalogs.get(key)
  if (!refresh && cached && Date.now() - cached.loadedAt < CatalogRefreshMs)
    return Promise.resolve(cached.catalog)
  const promise = window.velarosWorkbenchModel
    .listProviderModels(request)
    .then((catalog) => {
      if (!catalog.error) catalogs.set(key, { catalog, loadedAt: Date.now() })
      return catalog
    })
    .finally(() => requests.delete(key))
  requests.set(key, promise)
  return promise
}

export function useWorkbenchProviderModelCatalog(
  config: StandaloneWorkbenchModelConfig,
  managedProvider?: WorkbenchManagedModelProvider,
  enabled = true,
  managedState?: StandaloneWorkbenchManagedModelState
): { catalog: ProviderModelCatalog | null; loading: boolean; error: string | null } {
  const request = useMemo<WorkbenchListProviderModelsRequest>(
    () => ({
      provider: config.provider,
      apiKey: config.apiKey,
      baseURL: config.baseURL,
      purpose: 'chat',
    }),
    [config.apiKey, config.baseURL, config.provider]
  )
  const [result, setResult] = useState<{
    request: WorkbenchListProviderModelsRequest
    catalog: ProviderModelCatalog | null
    loading: boolean
    error: string | null
  } | null>(null)
  const managed = isStandaloneWorkbenchManagedProviderId(config.provider)

  useEffect(() => {
    if (!enabled || managed) return
    let active = true
    const load = (refresh = false): void => {
      setResult((previous) => ({
        request,
        catalog: previous?.request === request ? previous.catalog : null,
        loading: true,
        error: null,
      }))
      void loadWorkbenchProviderModelCatalog(request, refresh).then(
        (catalog) => {
          if (active)
            setResult({
              request,
              catalog: catalog.error ? null : catalog,
              loading: false,
              error: catalog.error ?? null,
            })
        },
        (error: unknown) => {
          if (active)
            setResult({
              request,
              catalog: null,
              loading: false,
              error: error instanceof Error ? error.message : String(error),
            })
        }
      )
    }
    load()
    const refresh = (): void => load(true)
    window.addEventListener('focus', refresh)
    return () => {
      active = false
      window.removeEventListener('focus', refresh)
    }
  }, [enabled, managed, request])

  const managedCatalog = useMemo<ProviderModelCatalog | null>(
    () =>
      managedProvider?.enabled
        ? {
            provider: config.provider,
            source: 'remote',
            fetchedAt: 0,
            models: managedProvider.models
              .filter((model) => model.status === 'available')
              .map((model) => ({ id: model.id, label: model.label })),
          }
        : null,
    [config.provider, managedProvider]
  )
  if (managed)
    return {
      catalog: managedState?.status === 'error' ? null : managedCatalog,
      loading: enabled && managedState?.status === 'loading',
      error: enabled && managedState?.status === 'error' ? managedState.error : null,
    }
  if (result?.request !== request) return { catalog: null, loading: enabled, error: null }
  return result
}
