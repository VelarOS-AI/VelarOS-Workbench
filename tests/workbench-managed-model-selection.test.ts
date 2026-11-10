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
import type { WorkbenchAccountState } from '../src/shared/workbenchAccount'
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
  run: (events: {
    accountChanged(state: WorkbenchAccountState): void
    focus(): void
    observers(): { account: number; focus: number; installed: number; removed: number }
  }) => Promise<void>
): Promise<void> {
  const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const accounts = new Set<(state: WorkbenchAccountState) => void>()
  const focus = new Set<() => void>()
  let installed = 0
  let removed = 0
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      localStorage: { setItem: () => undefined },
      velarosWorkbenchModel: { listManagedProviders },
      velarosWorkbenchAccount: {
        onChanged: (listener: (state: WorkbenchAccountState) => void) => {
          installed += 1
          accounts.add(listener)
          return () => { removed += 1; accounts.delete(listener) }
        },
      },
      addEventListener: (event: string, listener: () => void) => {
        expect(event).toBe('focus')
        focus.add(listener)
      },
      removeEventListener: (event: string, listener: () => void) => {
        expect(event).toBe('focus')
        expect(focus.delete(listener)).toBe(true)
      },
    },
  })
  try {
    await run({
      accountChanged: state => { for (const listener of [...accounts]) listener(state) },
      focus: () => { for (const listener of [...focus]) listener() },
      observers: () => ({ account: accounts.size, focus: focus.size, installed, removed }),
    })
  } finally {
    expect(accounts.size).toBe(0)
    expect(focus.size).toBe(0)
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
    await withModelBridge(() => request, async events => {
      let notifications = 0
      const dispose = subscribeStandaloneWorkbenchManagedModels(() => { notifications += 1 })
      try {
        await refreshStandaloneWorkbenchManagedModels()
        const initialState = getStandaloneWorkbenchManagedModelState()
        notifications = 0
        request = pending.promise
        events.focus()
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

  test('one account observer retires every old caller and keeps a newer catalog request owned', async () => {
    const old = snapshot([managedProvider('velar-dev', true, 'old-model')])
    const winner = snapshot([managedProvider('velaros', true, 'new-model')])
    const first = Promise.withResolvers<WorkbenchManagedModelAccessSnapshot>()
    const second = Promise.withResolvers<WorkbenchManagedModelAccessSnapshot>()
    const third = Promise.withResolvers<WorkbenchManagedModelAccessSnapshot>()
    let response = first.promise
    let calls = 0
    await withModelBridge(() => { calls += 1; return response }, async events => {
      const disposeSettings = subscribeStandaloneWorkbenchManagedModels(() => {})
      const disposeChat = subscribeStandaloneWorkbenchManagedModels(() => {})
      const settings = refreshStandaloneWorkbenchManagedModels()
      const chat = refreshStandaloneWorkbenchManagedModels()
      const oldOutcomes = Promise.allSettled([settings, chat])
      const pending: Array<Promise<unknown>> = [oldOutcomes]
      try {
        expect(settings).toBe(chat)
        expect(calls).toBe(1)
        expect(events.observers()).toEqual({ account: 1, focus: 1, installed: 1, removed: 0 })
        response = second.promise
        events.accountChanged({ status: 'signed-in', account: { id: 'b', displayName: 'B', email: 'b@example.com' } })
        const current = refreshStandaloneWorkbenchManagedModels()
        pending.push(current)
        expect(calls).toBe(2)
        expect(current).not.toBe(settings)
        disposeSettings()
        disposeChat()
        expect(events.observers().account).toBe(1)
        first.resolve(old)
        const outcomes = await oldOutcomes
        for (const outcome of outcomes)
          expect(outcome).toMatchObject({ status: 'rejected', reason: { code: 'CANCELLED' } })
        expect(getStandaloneWorkbenchManagedModelState().status).toBe('loading')
        expect(refreshStandaloneWorkbenchManagedModels()).toBe(current)
        expect(events.observers().account).toBe(1)
        second.resolve(winner)
        expect(await current).toEqual(winner)
        expect(getStandaloneWorkbenchManagedModelState().managedModels).toEqual(winner.managedModels)
        expect(events.observers()).toEqual({ account: 0, focus: 0, installed: 1, removed: 1 })

        response = third.promise
        const direct = refreshStandaloneWorkbenchManagedModels()
        const directOutcome = Promise.allSettled([direct])
        pending.push(directOutcome)
        expect(events.observers().account).toBe(1)
        events.accountChanged({ status: 'signed-out' })
        third.resolve(winner)
        expect((await directOutcome)[0]).toMatchObject({ status: 'rejected', reason: { code: 'CANCELLED' } })
        expect(getStandaloneWorkbenchManagedModelState().managedModels).toEqual([])
        expect(calls).toBe(3)
        expect(events.observers()).toEqual({ account: 0, focus: 0, installed: 2, removed: 2 })
      } finally {
        disposeSettings()
        disposeChat()
        first.resolve(old)
        second.resolve(winner)
        third.resolve(winner)
        await Promise.allSettled(pending)
      }
    })
  })
})
