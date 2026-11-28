import { expect, test } from 'bun:test'

import { WorkbenchWebSearchSettingsService } from '../src/main/model/WorkbenchWebSearchSettings'

test('custom search verifies the Tavily request and keeps persisted credentials out of settings', async () => {
  const endpoint = 'https://search.example/api/search'
  const saved = new Map([['tavily', 'previous-key']])
  let result = Response.json({
    results: [{ url: 'https://example.com/', title: 'Example', content: 'Example result' }],
  })
  const service = new WorkbenchWebSearchSettingsService(
    {
      getApiKey: async (name) => saved.get(name) ?? '',
      setApiKey: async (name, value) => {
        saved.set(name, value)
      },
    },
    async (url, options) => {
      expect(url).toBe(endpoint)
      expect(options?.method).toBe('POST')
      const headers = new Headers(options?.headers)
      expect(headers.get('Authorization')).toBe('Bearer custom-key')
      expect(headers.get('Content-Type')).toBe('application/json')
      expect(JSON.parse(String(options?.body))).toEqual({ query: 'VelarOS', max_results: 1 })
      return result
    }
  )
  expect(await service.getApiConnection()).toEqual({ provider: 'tavily', apiKey: 'previous-key' })
  const request = { action: 'save', provider: 'custom', endpoint, apiKey: 'custom-key' }
  await expect(service.update(request)).resolves.toEqual({
    provider: 'custom',
    tavilyConfigured: true,
    custom: { endpoint },
  })
  expect(await service.getApiConnection()).toEqual({
    provider: 'custom',
    endpoint,
    apiKey: 'custom-key',
  })
  await expect(service.update({ action: 'select', provider: 'browser' })).resolves.toMatchObject({
    provider: 'browser',
  })
  result = Response.json({ unexpected: [] })
  await expect(service.update(request)).rejects.toMatchObject({ code: 'NETWORK' })
  expect(await service.getApiConnection()).toBeNull()
})
