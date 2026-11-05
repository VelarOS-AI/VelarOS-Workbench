import { describe, expect, test } from 'bun:test'

import type { ProviderModelCatalog } from '@velaros-ai/velaros/model/contracts'

import { loadWorkbenchProviderModelCatalog } from '../src/renderer/src/hooks/useWorkbenchProviderModelCatalog'
import type { WorkbenchListProviderModelsRequest } from '../src/shared/workbenchModel'

async function withCatalogBridge(
  listProviderModels: (
    request: WorkbenchListProviderModelsRequest
  ) => Promise<ProviderModelCatalog>,
  run: () => Promise<void>
): Promise<void> {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'window')
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { velarosWorkbenchModel: { listProviderModels } },
  })
  try {
    await run()
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'window', descriptor)
    else Reflect.deleteProperty(globalThis, 'window')
  }
}

const request: WorkbenchListProviderModelsRequest = {
  provider: 'openai-compatible-gateway',
  apiKey: 'test-credential',
  baseURL: 'https://catalog.example.invalid/v1',
  purpose: 'chat',
}
const catalog: ProviderModelCatalog = {
  provider: request.provider,
  source: 'remote',
  models: [
    { id: 'remote-a', label: 'Remote A' },
    { id: 'remote-b', label: 'Remote B' },
  ],
  fetchedAt: 1,
}

describe('Workbench provider catalog shared by settings and composer', () => {
  test('deduplicates concurrent requests and refreshes the complete list on focus', async () => {
    const pending = Promise.withResolvers<ProviderModelCatalog>()
    let calls = 0
    await withCatalogBridge(
      async () => {
        calls += 1
        return pending.promise
      },
      async () => {
        const settings = loadWorkbenchProviderModelCatalog(request)
        const composer = loadWorkbenchProviderModelCatalog({ ...request })
        expect(calls).toBe(1)
        pending.resolve(catalog)
        expect(await settings).toEqual(catalog)
        expect(await composer).toEqual(catalog)
        expect(await loadWorkbenchProviderModelCatalog(request)).toEqual(catalog)
        expect(calls).toBe(1)
        await loadWorkbenchProviderModelCatalog(request, true)
        expect(calls).toBe(2)
      }
    )
  })

  test('credentials and endpoint changes have independent catalogs', async () => {
    const requests: WorkbenchListProviderModelsRequest[] = []
    await withCatalogBridge(
      async (input) => {
        requests.push(input)
        return catalog
      },
      async () => {
        await loadWorkbenchProviderModelCatalog({ ...request, apiKey: 'changed-credential' })
        await loadWorkbenchProviderModelCatalog({
          ...request,
          baseURL: 'https://other.example.invalid/v1',
        })
        expect(requests).toHaveLength(2)
        expect(requests[0]?.apiKey).toBe('changed-credential')
        expect(requests[1]?.baseURL).toBe('https://other.example.invalid/v1')
      }
    )
  })

  test('a failed catalog can recover without caching the error or inventing models', async () => {
    const failedRequest = { ...request, apiKey: 'recoverable-credential' }
    let calls = 0
    await withCatalogBridge(
      async () => {
        calls += 1
        if (calls === 1) throw new Error('provider unavailable')
        if (calls === 2) return { ...catalog, models: [], error: 'invalid credential' }
        return catalog
      },
      async () => {
        await expect(loadWorkbenchProviderModelCatalog(failedRequest)).rejects.toThrow(
          'provider unavailable'
        )
        expect((await loadWorkbenchProviderModelCatalog(failedRequest)).error).toBe(
          'invalid credential'
        )
        expect(await loadWorkbenchProviderModelCatalog(failedRequest)).toEqual(catalog)
        expect(calls).toBe(3)
      }
    )
  })
})
