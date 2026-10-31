import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, test } from 'bun:test'

import { useWorkbenchProviderModelCatalog } from '../src/renderer/src/hooks/useWorkbenchProviderModelCatalog'
import {
  getStandaloneWorkbenchManagedModelState,
  getStandaloneWorkbenchManagedProvider,
  refreshStandaloneWorkbenchManagedModels,
  type StandaloneWorkbenchManagedModelState,
} from '../src/renderer/src/runtime/standaloneWorkbenchManagedModels'
import { createStandaloneWorkbenchModelSelectorProviders } from '../src/renderer/src/runtime/standaloneWorkbenchModelCatalog'
import type { StandaloneWorkbenchModelConfig } from '../src/renderer/src/runtime/standaloneWorkbenchModelConfig'
import type { WorkbenchManagedModelAccessSnapshot } from '../src/shared/workbenchModel'

const config: StandaloneWorkbenchModelConfig = {
  provider: 'velar-dev',
  model: 'previous-model',
  completionModel: '',
  baseURL: '',
  apiKey: '',
}

function readCatalog(
  state: StandaloneWorkbenchManagedModelState,
  enabled = true,
  selectedConfig = config
): ReturnType<typeof useWorkbenchProviderModelCatalog> {
  let result!: ReturnType<typeof useWorkbenchProviderModelCatalog>
  function Consumer() {
    result = useWorkbenchProviderModelCatalog(
      selectedConfig,
      getStandaloneWorkbenchManagedProvider(selectedConfig.provider, state),
      enabled,
      state
    )
    return null
  }
  renderToStaticMarkup(createElement(Consumer))
  return result
}

describe('managed catalog feedback shared by settings and composer', () => {
  test('one shared request exposes failure to both consumers and recovers without stale model choices', async () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'window')
    const first = Promise.withResolvers<WorkbenchManagedModelAccessSnapshot>()
    let request = first.promise
    let managedCalls = 0
    let catalogCalls = 0
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        velarosWorkbenchModel: {
          listManagedProviders: () => {
            managedCalls += 1
            return request
          },
          listProviderModels: () => {
            catalogCalls += 1
            throw new Error('duplicate catalog request')
          },
        },
      },
    })
    try {
      const settingsRequest = refreshStandaloneWorkbenchManagedModels()
      const chatRequest = refreshStandaloneWorkbenchManagedModels()
      const settled = Promise.allSettled([settingsRequest, chatRequest])
      expect(managedCalls).toBe(1)
      expect(readCatalog(getStandaloneWorkbenchManagedModelState())).toEqual({
        catalog: null,
        loading: true,
        error: null,
      })
      first.reject(new Error('Sign in again in Settings, then refresh the model list.'))
      await settled
      const failedState = getStandaloneWorkbenchManagedModelState()
      const settings = readCatalog(failedState)
      const chat = readCatalog(failedState)
      expect(settings).toEqual(chat)
      expect(settings.catalog).toBeNull()
      expect(settings.loading).toBe(false)
      expect(settings.error).toContain('Sign in again')
      const unavailable = createStandaloneWorkbenchModelSelectorProviders(
        config.provider,
        config.model,
        []
      )
      expect(unavailable).toHaveLength(1)
      expect(unavailable[0]?.models).toEqual([])
      expect(config.model).toBe('previous-model')

      request = Promise.resolve({
        updatedAt: new Date().toISOString(),
        managedModels: [
          {
            providerId: 'velar-dev',
            displayName: 'Velar Dev',
            enabled: true,
            models: [
              { id: 'available-model', label: 'Available model', status: 'available' },
              { id: 'blocked-model', label: 'Blocked model', status: 'not-configured' },
            ],
          },
        ],
      })
      await Promise.all([
        refreshStandaloneWorkbenchManagedModels(),
        refreshStandaloneWorkbenchManagedModels(),
      ])
      expect(managedCalls).toBe(2)
      const recovered = readCatalog(getStandaloneWorkbenchManagedModelState())
      expect(recovered.error).toBeNull()
      expect(recovered.loading).toBe(false)
      expect(recovered.catalog?.models).toEqual([
        { id: 'available-model', label: 'Available model' },
      ])
      expect(catalogCalls).toBe(0)
    } finally {
      if (descriptor) Object.defineProperty(globalThis, 'window', descriptor)
      else Reflect.deleteProperty(globalThis, 'window')
    }
  })

  test('managed errors do not leak into external engines, closed settings or BYOK catalogs', () => {
    const failed: StandaloneWorkbenchManagedModelState = {
      status: 'error',
      managedModels: [],
      error: 'Account expired',
    }
    expect(readCatalog(failed, false)).toEqual({ catalog: null, loading: false, error: null })
    expect(readCatalog({ status: 'loading', managedModels: [] }, false).loading).toBe(false)
    expect(readCatalog(failed, true, { ...config, provider: 'openai' })).toEqual({
      catalog: null,
      loading: true,
      error: null,
    })
  })
})
