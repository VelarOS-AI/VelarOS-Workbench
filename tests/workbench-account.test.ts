import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, test } from 'bun:test'

import {
  parseWorkbenchManagedModelAccessSnapshot,
  WorkbenchAccountService,
} from '../src/main/account/WorkbenchAccountService'
import {
  type WorkbenchCloudSession,
  WorkbenchSharedAccountStore,
} from '../src/main/account/WorkbenchSharedAccountStore'

function session(accountId: string): WorkbenchCloudSession {
  return {
    account: {
      id: accountId,
      displayName: `Account ${accountId}`,
      email: `${accountId}@example.com`,
    },
    sessionFamilyId: `family-${accountId}`,
    accessToken: `access-${accountId}`,
    accessExpiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
    refreshToken: `refresh-${accountId}`,
    refreshExpiresAt: new Date(Date.now() + 30 * 24 * 60 * 60_000).toISOString(),
  }
}

const DevModelId = 'velar-dev/Z3B0LTUuNi1zb2w'

function usageSnapshot(managedModels: unknown[]): Record<string, unknown> {
  return {
    account: {
      id: 'internal-account',
      displayName: 'Internal User',
      email: 'internal@example.com',
      initials: 'IU',
      membershipLevel: 'none',
      administrator: true,
    },
    features: {},
    managedModels,
    updatedAt: '2026-09-05T10:00:00.000Z',
  }
}

const VelarDevAccess = {
  providerId: 'velar-dev',
  displayName: 'Velar Dev',
  enabled: true,
  defaultModel: DevModelId,
  models: [
    { id: DevModelId, label: 'GPT 5.6 Sol', status: 'available' },
    { id: 'velar-dev/dW5wcmljZWQ', label: 'Unpriced', status: 'not-configured' },
  ],
}

void describe('Workbench shared VelarOS account', () => {
  void test('gates only the built-in chat and exposes product-local sign-out in settings', () => {
    const chatAdapter = readFileSync(
      new URL('../src/renderer/src/runtime/standaloneWorkbenchChatAdapter.tsx', import.meta.url),
      'utf8'
    )
    const settings = readFileSync(
      new URL('../src/renderer/src/components/settings/WorkbenchSettingsDialog.tsx', import.meta.url),
      'utf8'
    )

    assert.match(chatAdapter, /providerId === 'workbench'/u)
    assert.match(chatAdapter, /velarosWorkbenchAccount\.ensureSignedIn\(\)/u)
    assert.match(settings, /velarosWorkbenchAccount\.signOut\(\)/u)
    assert.match(settings, /velarosWorkbenchProjectHub\.returnToEntry\(\)/u)
  })

  void test('reuses a local session while keeping product account bindings independent', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'velaros-shared-account-'))
    const desktop = new WorkbenchSharedAccountStore({
      productId: 'velaros.desktop',
      rootDir,
    })
    const workbench = new WorkbenchSharedAccountStore({
      productId: 'velaros.workbench',
      rootDir,
    })

    try {
      await desktop.save(session('desktop-account'))
      assert.equal((await workbench.load())?.account.id, 'desktop-account')

      assert.equal(await workbench.disconnect(), false)
      assert.equal((await desktop.load())?.account.id, 'desktop-account')
      assert.equal(await workbench.load(), null)

      await workbench.save(session('workbench-account'))
      assert.equal((await desktop.load())?.account.id, 'desktop-account')
      assert.equal((await workbench.load())?.account.id, 'workbench-account')

      assert.equal(await workbench.disconnect(), true)
      assert.equal((await desktop.load())?.account.id, 'desktop-account')
    } finally {
      await rm(rootDir, { recursive: true, force: true })
    }
  })

  void test('does not open browser authorization when a reusable session is already bound', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'velaros-account-reuse-'))
    const store = new WorkbenchSharedAccountStore({ rootDir })
    let browserOpenCount = 0
    let requestCount = 0

    try {
      await store.save(session('shared-account'))
      const service = new WorkbenchAccountService(
        store,
        async () => {
          browserOpenCount += 1
        },
        'https://cloud.example.com',
        async () => {
          requestCount += 1
          throw new Error('unexpected request')
        }
      )

      const state = await service.ensureSignedIn()
      assert.equal(state.status, 'signed-in')
      assert.equal(state.status === 'signed-in' ? state.account.id : null, 'shared-account')
      assert.equal(browserOpenCount, 0)
      assert.equal(requestCount, 0)
    } finally {
      await rm(rootDir, { recursive: true, force: true })
    }
  })

  void test('derives managed providers only from the online managedModels list', () => {
    const authorized = parseWorkbenchManagedModelAccessSnapshot(
      usageSnapshot([VelarDevAccess])
    )
    assert.deepEqual(authorized.managedModels, [{
      providerId: 'velar-dev',
      displayName: 'Velar Dev',
      enabled: true,
      defaultModel: DevModelId,
      models: [
        { id: DevModelId, label: 'GPT 5.6 Sol', status: 'available' },
        { id: 'velar-dev/dW5wcmljZWQ', label: 'Unpriced', status: 'not-configured' },
      ],
    }])

    const roleOnly = parseWorkbenchManagedModelAccessSnapshot({
      ...usageSnapshot([]),
      managedModel: VelarDevAccess,
    })
    assert.deepEqual(roleOnly.managedModels, [])
  })

  void test('loads the authorized Velar Dev model catalog through its isolated Cloud route', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'velaros-managed-models-'))
    const store = new WorkbenchSharedAccountStore({ rootDir })
    const requests: Array<{ url: string; authorization: string | null; method: string }> = []
    try {
      await store.save(session('internal-account'))
      const service = new WorkbenchAccountService(
        store,
        async () => undefined,
        'https://cloud.example.com/api',
        (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
          const url = input instanceof Request ? input.url : input.toString()
          requests.push({
            url,
            authorization: new Headers(init?.headers).get('authorization'),
            method: init?.method ?? (input instanceof Request ? input.method : 'GET'),
          })
          if (url.endsWith('/v1/account/usage')) return Response.json(usageSnapshot([VelarDevAccess]))
          if (url.endsWith('/v1/velar-dev/models')) return Response.json({
              object: 'list',
              data: [
                { id: DevModelId, display_name: 'GPT 5.6 Sol' },
                { id: 'velar-dev/dW5wcmljZWQ', display_name: 'Unpriced' },
              ],
            })
          throw new Error(`unexpected request: ${url}`)
        }) as typeof fetch
      )

      const catalog = await service.listManagedProviderModels('velar-dev')
      assert.deepEqual(catalog.models, [{ id: DevModelId, label: 'GPT 5.6 Sol' }])
      assert.deepEqual(requests.map((request) => request.url), [
        'https://cloud.example.com/api/v1/account/usage',
        'https://cloud.example.com/api/v1/velar-dev/models',
      ])
      assert.ok(requests.every((request) => request.authorization === 'Bearer access-internal-account'))
      assert.ok(requests.every((request) => request.method === 'GET'))
    } finally {
      await rm(rootDir, { recursive: true, force: true })
    }
  })

  void test('injects the account token only into the selected managed provider chat route', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'velaros-managed-chat-'))
    const store = new WorkbenchSharedAccountStore({ rootDir })
    let chatRequest:
      | { url: string; authorization: string | null; idempotencyKey: string | null }
      | undefined
    try {
      await store.save(session('internal-account'))
      const service = new WorkbenchAccountService(
        store,
        async () => undefined,
        'https://cloud.example.com/api',
        (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
          const url = input instanceof Request ? input.url : input.toString()
          if (url.endsWith('/v1/account/usage')) return Response.json(usageSnapshot([VelarDevAccess]))
          const headers = new Headers(init?.headers)
          chatRequest = {
            url,
            authorization: headers.get('authorization'),
            idempotencyKey: headers.get('idempotency-key'),
          }
          return Response.json({ id: 'response-1' })
        }) as typeof fetch
      )

      await assert.rejects(
        service.fetchManagedModel(
          'velar-dev',
          'https://cloud.example.com/api/v1/model/chat/completions',
          { method: 'POST' }
        ),
        /地址不受信任/u
      )
      assert.equal(chatRequest, undefined)

      const response = await service.fetchManagedModel(
        'velar-dev',
        'https://cloud.example.com/api/v1/velar-dev/chat/completions',
        { method: 'POST', headers: { Authorization: 'Bearer velar-dev-managed' } }
      )
      assert.equal(response.status, 200)
      assert.equal(chatRequest?.url, 'https://cloud.example.com/api/v1/velar-dev/chat/completions')
      assert.equal(chatRequest?.authorization, 'Bearer access-internal-account')
      assert.ok(chatRequest?.idempotencyKey)
    } finally {
      await rm(rootDir, { recursive: true, force: true })
    }
  })

  void test('does not dispatch a managed model request without explicit authorization', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'velaros-managed-denied-'))
    const store = new WorkbenchSharedAccountStore({ rootDir })
    let chatRequests = 0
    try {
      await store.save(session('regular-account'))
      const service = new WorkbenchAccountService(
        store,
        async () => undefined,
        'https://cloud.example.com/api',
        (async (input: string | URL | Request): Promise<Response> => {
          const url = input instanceof Request ? input.url : input.toString()
          if (url.endsWith('/v1/account/usage')) return Response.json(usageSnapshot([]))
          chatRequests += 1
          return Response.json({ id: 'unexpected' })
        }) as typeof fetch
      )

      await assert.rejects(
        service.fetchManagedModel(
          'velar-dev',
          'https://cloud.example.com/api/v1/velar-dev/chat/completions',
          { method: 'POST' }
        ),
        /尚未获得 Velar Dev 授权/u
      )
      assert.equal(chatRequests, 0)
    } finally {
      await rm(rootDir, { recursive: true, force: true })
    }
  })
})
