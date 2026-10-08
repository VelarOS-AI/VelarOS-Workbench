import { describe, expect, test } from 'bun:test'

import {
  getStandaloneWorkbenchManagedModelState,
  refreshStandaloneWorkbenchManagedModels,
  subscribeStandaloneWorkbenchManagedModels,
} from '../src/renderer/src/runtime/standaloneWorkbenchManagedModels'
import {
  createStandaloneWorkbenchModelProviderOptions,
  createStandaloneWorkbenchModelSelectorProviders,
} from '../src/renderer/src/runtime/standaloneWorkbenchModelCatalog'
import {
  getStandaloneWorkbenchModelConfig,
  selectStandaloneWorkbenchAgentModel,
  selectStandaloneWorkbenchModel,
  selectStandaloneWorkbenchModelProvider,
  subscribeStandaloneWorkbenchModelConfig,
  updateStandaloneWorkbenchModelConfig,
} from '../src/renderer/src/runtime/standaloneWorkbenchModelConfig'
import type {
  WorkbenchManagedModelAccessSnapshot,
  WorkbenchManagedModelProvider,
} from '../src/shared/workbenchModel'

function managedProvider(
  providerId: 'velaros' | 'velar-dev',
  enabled: boolean,
  model = `${providerId}/current`
): WorkbenchManagedModelProvider {
  return {
    providerId,
    displayName: providerId === 'velar-dev' ? 'Velar Dev' : 'Velar',
    enabled,
    defaultModel: model,
    models: [{ id: model, label: 'Original model name', status: 'available' }],
  }
}

function snapshot(
  managedModels: readonly WorkbenchManagedModelProvider[]
): WorkbenchManagedModelAccessSnapshot {
  return { managedModels, updatedAt: new Date().toISOString() }
}

async function withModelBridge(
  listManagedProviders: () => Promise<WorkbenchManagedModelAccessSnapshot>,
  run: () => Promise<void>
): Promise<void> {
  const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window')
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      localStorage: { setItem: () => undefined },
      velarosWorkbenchModel: { listManagedProviders },
    },
  })
  try {
    await run()
  } finally {
    if (windowDescriptor) Object.defineProperty(globalThis, 'window', windowDescriptor)
    else Reflect.deleteProperty(globalThis, 'window')
  }
}

describe('Workbench managed model selection', () => {
  test('disables each service independently and preserves model names', () => {
    for (const productionEnabled of [false, true]) {
      const providers = [
        managedProvider('velaros', productionEnabled),
        managedProvider('velar-dev', !productionEnabled),
      ]
      const options = createStandaloneWorkbenchModelProviderOptions(
        providers,
        (label) => `${label} service is disabled`
      )
      expect(options.find((option) => option.value === 'velaros')).toMatchObject({
        label: 'VelarOS',
        disabled: !productionEnabled,
      })
      expect(options.find((option) => option.value === 'velar-dev')).toMatchObject({
        label: 'VelarOS-Dev',
        disabled: productionEnabled,
      })
      expect(options.find((option) => option.disabled)?.description).toContain('service is disabled')
      const chat = createStandaloneWorkbenchModelSelectorProviders(
        'velar-dev',
        'velar-dev/current',
        providers[1]!.models.map((model) => ({ id: model.id, label: model.label })),
        providers[1]
      )
      if (productionEnabled) {
        expect(chat).toEqual([])
        continue
      }
      expect(chat[0]?.label).toBe('VelarOS-Dev')
      expect(chat[0]?.models).toEqual([{
        value: 'velar-dev/current',
        label: 'Original model name',
      }])
    }
  })

  test('publishes settings selections immediately and rejects callbacks using an outdated enabled option', async () => {
    const originalConfig = getStandaloneWorkbenchModelConfig()
    let access = snapshot([managedProvider('velaros', false), managedProvider('velar-dev', true)])
    let notifications = 0
    const dispose = subscribeStandaloneWorkbenchModelConfig(() => { notifications += 1 })
    try {
      await withModelBridge(async () => access, async () => {
        await refreshStandaloneWorkbenchManagedModels()
        selectStandaloneWorkbenchModelProvider('velar-dev', { model: 'velar-dev/current' })
        expect(notifications).toBe(1)
        expect(getStandaloneWorkbenchModelConfig()).toMatchObject({
          provider: 'velar-dev',
          model: 'velar-dev/current',
        })
        const selectedConfig = getStandaloneWorkbenchModelConfig()
        selectStandaloneWorkbenchModelProvider('velaros')
        expect(getStandaloneWorkbenchModelConfig()).toBe(selectedConfig)

        access = snapshot([managedProvider('velaros', true), managedProvider('velar-dev', false)])
        await refreshStandaloneWorkbenchManagedModels()
        selectStandaloneWorkbenchModelProvider('velar-dev', { model: 'stale-default' })
        selectStandaloneWorkbenchAgentModel('velar-dev', 'stale-model')
        selectStandaloneWorkbenchModel('velar-dev', 'stale-model', 'completion')
        expect(getStandaloneWorkbenchModelConfig()).toBe(selectedConfig)
        expect(notifications).toBe(1)

        selectStandaloneWorkbenchModelProvider('velaros', { model: 'velaros/current' })
        expect(getStandaloneWorkbenchModelConfig().provider).toBe('velaros')
        expect(notifications).toBe(2)
      })
    } finally {
      dispose()
      updateStandaloneWorkbenchModelConfig(originalConfig)
    }
  })

  test('keeps the current selector during refresh and notifies it when the model catalog changes', async () => {
    const initial = snapshot([managedProvider('velar-dev', true)])
    const changed = snapshot([managedProvider('velar-dev', true, 'velar-dev/new-model')])
    const pending = Promise.withResolvers<WorkbenchManagedModelAccessSnapshot>()
    let request = Promise.resolve(initial)
    await withModelBridge(() => request, async () => {
      await refreshStandaloneWorkbenchManagedModels()
      const initialState = getStandaloneWorkbenchManagedModelState()
      let notifications = 0
      const dispose = subscribeStandaloneWorkbenchManagedModels(() => { notifications += 1 })
      try {
        request = pending.promise
        const refresh = refreshStandaloneWorkbenchManagedModels()
        expect(getStandaloneWorkbenchManagedModelState()).toBe(initialState)
        expect(notifications).toBe(0)
        pending.resolve(changed)
        await refresh
        expect(notifications).toBe(1)
        const providers = getStandaloneWorkbenchManagedModelState().managedModels
        expect(providers[0]?.defaultModel).toBe('velar-dev/new-model')
        expect(createStandaloneWorkbenchModelProviderOptions(providers, () => 'disabled')[0])
          .toMatchObject({ value: 'velar-dev', label: 'VelarOS-Dev', disabled: false })
      } finally {
        dispose()
      }
    })
  })
})
