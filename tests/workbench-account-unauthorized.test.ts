import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { test } from 'bun:test'

import { WorkbenchAccountService } from '../src/main/account/WorkbenchAccountService'
import {
  type WorkbenchCloudSession,
  WorkbenchSharedAccountStore,
} from '../src/main/account/WorkbenchSharedAccountStore'

function session(token = 'old', family = 'family-a', account = 'a'): WorkbenchCloudSession {
  return {
    account: { id: account, displayName: account, email: `${account}@example.com` },
    sessionFamilyId: family,
    accessToken: `access-${token}`,
    refreshToken: token,
    accessExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
    refreshExpiresAt: new Date(Date.now() + 86400_000).toISOString(),
  }
}

for (const operation of ['usage', 'models'] as const) {
  test(`a successful ${operation} metadata body arriving after local logout cannot publish old grants`, async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'workbench-metadata-result-owner-'))
    const store = new WorkbenchSharedAccountStore({ rootDir })
    const readingBody = Promise.withResolvers<void>()
    let body: ReadableStreamDefaultController<Uint8Array> | undefined
    let bodyClosed = false
    let pending: Promise<unknown> | undefined
    const access = {
      managedModels: [{
        providerId: 'velar-dev',
        displayName: 'Velar Dev',
        enabled: true,
        models: [{ id: 'old-model', status: 'available' }],
      }],
      updatedAt: new Date().toISOString(),
    }
    try {
      await store.save(session())
      const service = new WorkbenchAccountService(
        store,
        async () => {},
        'https://cloud.example.com',
        (async input => {
          const url = String(input)
          if (url.endsWith('/logout')) return Response.json({})
          if (operation === 'models' && url.endsWith('/v1/account/usage'))
            return Response.json(access)
          assert.ok(url.endsWith(operation === 'usage' ? '/v1/account/usage' : '/v1/velar-dev/models'), url)
          return new Response(new ReadableStream<Uint8Array>({
            start: controller => { body = controller },
            pull: () => { readingBody.resolve() },
          }, { highWaterMark: 0 }), { status: 200 })
        }) as typeof fetch
      )
      pending = operation === 'usage'
        ? service.getManagedModelAccess()
        : service.listManagedProviderModels('velar-dev')
      const rejected = assert.rejects(pending)
      await readingBody.promise
      await service.signOut()
      assert.ok(body)
      body.enqueue(new TextEncoder().encode(JSON.stringify(operation === 'usage'
        ? access
        : { data: [{ id: 'old-model' }] })))
      body.close()
      bodyClosed = true
      await rejected
      assert.equal(await store.load(), null)
    } finally {
      if (!bodyClosed) body?.error(new Error('Metadata fixture is closing'))
      await Promise.allSettled([pending])
      await rm(rootDir, { recursive: true, force: true })
    }
  })
}

for (const rejectedPath of ['/v1/account/usage', '/v1/velar-dev/models']) {
  test(`concurrent catalogs share one renewal after 401 from ${rejectedPath}`, async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'workbench-catalog-401-'))
    const store = new WorkbenchSharedAccountStore({ rootDir })
    let refreshCalls = 0
    try {
      await store.save(session())
      const service = new WorkbenchAccountService(
        store,
        async () => {},
        'https://cloud.example.com',
        (async (input: string | URL | Request, init?: RequestInit) => {
          const url = String(input)
          if (url.endsWith('/refresh')) {
            refreshCalls += 1
            return Response.json(session('next'))
          }
          if (
            url.endsWith(rejectedPath) &&
            new Headers(init?.headers).get('Authorization') === 'Bearer access-old'
          )
            return new Response(null, { status: 401 })
          if (url.endsWith('/usage'))
            return Response.json({
              managedModels: [
                {
                  providerId: 'velar-dev',
                  displayName: 'Velar Dev',
                  enabled: true,
                  models: [{ id: 'test-model', label: 'Test Model', status: 'available' }],
                },
              ],
              updatedAt: new Date().toISOString(),
            })
          return Response.json({ data: [{ id: 'test-model' }] })
        }) as typeof fetch
      )
      const results = await Promise.all([
        service.listManagedProviderModels('velar-dev'),
        service.listManagedProviderModels('velar-dev'),
      ])
      assert.equal(refreshCalls, 1)
      assert.deepEqual(
        results.map((result) => result.models.map((model) => model.id)),
        [['test-model'], ['test-model']]
      )
    } finally {
      await rm(rootDir, { recursive: true, force: true })
    }
  })
}

for (const mode of [
  'recover',
  'refresh-denied',
  'retry-denied',
  'shared-rotation',
  'account-change',
  'family-change',
  'logout',
  'forbidden',
  'invalid-refresh-family',
] as const) {
  test(`metadata authorization handles ${mode} without crossing account boundaries`, async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'workbench-account-401-'))
    const store = new WorkbenchSharedAccountStore({ rootDir })
    const previous = session()
    const next = session('next')
    let refreshCalls = 0
    let metadataCalls = 0
    const usedTokens: Array<string | null> = []
    let service!: WorkbenchAccountService
    try {
      await store.save(previous)
      service = new WorkbenchAccountService(
        store,
        async () => {},
        'https://cloud.example.com',
        (async (input: string | URL | Request, init?: RequestInit) => {
          const url = String(input)
          if (url.endsWith('/refresh')) {
            refreshCalls += 1
            if (mode === 'refresh-denied') return new Response(null, { status: 401 })
            return Response.json(
              mode === 'invalid-refresh-family' ? session('next', 'other-family') : next
            )
          }
          if (url.endsWith('/logout')) return Response.json({})
          metadataCalls += 1
          usedTokens.push(new Headers(init?.headers).get('Authorization'))
          if (metadataCalls === 1) {
            if (mode === 'shared-rotation') await store.save(next)
            if (mode === 'account-change') await store.save(session('winner', 'family-b', 'b'))
            if (mode === 'family-change') await store.save(session('winner', 'family-new'))
            if (mode === 'logout') await service.signOut()
            return new Response(null, { status: mode === 'forbidden' ? 403 : 401 })
          }
          if (mode === 'retry-denied') return new Response(null, { status: 401 })
          return Response.json({ managedModels: [], updatedAt: new Date().toISOString() })
        }) as typeof fetch
      )
      if (mode === 'recover' || mode === 'shared-rotation') {
        await service.getManagedModelAccess()
        assert.equal(refreshCalls, mode === 'recover' ? 1 : 0)
        assert.deepEqual(usedTokens, ['Bearer access-old', 'Bearer access-next'])
        assert.equal((await service.getState()).status, 'signed-in')
      } else {
        const error = await service.getManagedModelAccess().then(
          () => null,
          (reason: unknown) => reason
        )
        assert.ok(error instanceof Error)
        if (mode === 'refresh-denied' || mode === 'retry-denied') {
          assert.match(error.message, /重新登录|Sign in again/u)
          assert.equal((await service.getState()).status, 'signed-out')
          const priorCalls = metadataCalls
          await assert.rejects(service.getManagedModelAccess())
          assert.equal(metadataCalls, priorCalls)
          assert.equal(refreshCalls, 1)
          // Another product's later successful refresh is still usable.
          await store.save(session('winner'))
          assert.equal((await service.getState()).status, 'signed-in')
        } else {
          assert.equal(metadataCalls, 1)
          assert.equal(refreshCalls, mode === 'invalid-refresh-family' ? 1 : 0)
          if (mode === 'logout') assert.equal(await store.load(), null)
          if (mode === 'account-change') assert.equal((await store.load())?.account.id, 'b')
          if (mode === 'family-change')
            assert.equal((await store.load())?.sessionFamilyId, 'family-new')
          if (mode === 'invalid-refresh-family') assert.deepEqual(await store.load(), previous)
        }
      }
    } finally {
      await rm(rootDir, { recursive: true, force: true })
    }
  })
}
