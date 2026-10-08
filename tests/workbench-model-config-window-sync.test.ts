import { expect, test } from 'bun:test'

import {
  getStandaloneWorkbenchModelConfig,
  hydrateStandaloneWorkbenchModelApiKey,
  subscribeStandaloneWorkbenchModelConfig,
  updateStandaloneWorkbenchModelConfig,
} from '../src/renderer/src/runtime/standaloneWorkbenchModelConfig'

test('an already-open workspace observes model and credential changes from another window', async () => {
  const original = getStandaloneWorkbenchModelConfig()
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const storage = new Map<string, string>()
  const events = new Map<string, (event: { key: string }) => void>()
  let credential = 'first-test-credential'
  let notifications = 0
  const dispose = subscribeStandaloneWorkbenchModelConfig(() => { notifications += 1 })
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      localStorage: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => storage.set(key, value),
      },
      addEventListener: (name: string, listener: (event: { key: string }) => void) => events.set(name, listener),
      velarosWorkbenchModel: { getApiKey: async () => credential },
    },
  })
  const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))
  try {
    hydrateStandaloneWorkbenchModelApiKey()
    await flush()
    expect(getStandaloneWorkbenchModelConfig().apiKey).toBe('first-test-credential')

    const key = 'velaros-workbench-app:model-config'
    storage.set(key, JSON.stringify({
      provider: 'openai', model: 'changed-model', completionModel: '', baseURL: '',
    }))
    const before = notifications
    events.get('storage')!({ key })
    expect(getStandaloneWorkbenchModelConfig()).toMatchObject({
      provider: 'openai', model: 'changed-model', completionModel: '',
    })
    expect(notifications).toBeGreaterThan(before)
    await flush()

    credential = 'second-test-credential'
    events.get('storage')!({ key: 'velaros-workbench-app:model-credential-revision' })
    await flush()
    expect(getStandaloneWorkbenchModelConfig().apiKey).toBe('second-test-credential')
    expect([...storage.values()].some((value) => value.includes('test-credential'))).toBe(false)
  } finally {
    dispose()
    if (descriptor) Object.defineProperty(globalThis, 'window', descriptor)
    else Reflect.deleteProperty(globalThis, 'window')
    updateStandaloneWorkbenchModelConfig(original)
  }
})
