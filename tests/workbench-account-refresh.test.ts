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

function session(id = 'a', token = 'old', fresh = false): WorkbenchCloudSession {
  return {
    account: { id, displayName: id, email: `${id}@example.com` },
    sessionFamilyId: `family-${id}`,
    accessToken: `access-${token}`,
    refreshToken: token,
    accessExpiresAt: new Date(Date.now() + (fresh ? 3600_000 : 1000)).toISOString(),
    refreshExpiresAt: new Date(Date.now() + 86400_000).toISOString(),
  }
}

async function fixture() {
  const rootDir = await mkdtemp(join(tmpdir(), 'workbench-refresh-retry-'))
  class FailingStore extends WorkbenchSharedAccountStore {
    failures = 0
    public override async replaceSession(
      previous: WorkbenchCloudSession,
      next: WorkbenchCloudSession
    ) {
      if (this.failures-- > 0)
        throw Object.assign(new Error('test persistence failure'), {
          code: 'EPERM',
        })
      return super.replaceSession(previous, next)
    }
  }
  const store = new FailingStore({ rootDir })
  await store.save(session())
  const refreshed = session('a', 'rotated', true)
  let refreshCalls = 0
  const usedTokens: Array<string | null> = []
  const service = new WorkbenchAccountService(
    store,
    async () => {},
    'https://cloud.example.com',
    (async (input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : input.toString()
      if (url.endsWith('/refresh')) {
        refreshCalls += 1
        return Response.json(refreshed)
      }
      if (url.endsWith('/logout')) return Response.json({})
      usedTokens.push(new Headers(init?.headers).get('Authorization'))
      return Response.json({
        managedModels: [],
        updatedAt: new Date().toISOString(),
      })
    }) as typeof fetch
  )
  return {
    store,
    service,
    usedTokens,
    refreshCalls: () => refreshCalls,
    close: () => rm(rootDir, { recursive: true, force: true }),
  }
}

for (const failures of [1, 2]) {
  test(`retries ${failures} failed credential writes without reusing the rotated refresh token`, async () => {
    const f = await fixture()
    try {
      f.store.failures = failures
      for (let i = 0; i < failures; i += 1)
        await assert.rejects(f.service.getManagedModelAccess(), /test persistence failure/u)
      await f.service.getManagedModelAccess()
      assert.equal(f.refreshCalls(), 1)
      assert.deepEqual(f.usedTokens, ['Bearer access-rotated'])
      assert.equal((await f.store.load())?.refreshToken, 'rotated')
    } finally {
      await f.close()
    }
  })
}

for (const change of ['rotation', 'account', 'family', 'external-logout', 'logout'] as const) {
  test(`pending refresh cannot overwrite ${change}`, async () => {
    const f = await fixture()
    try {
      f.store.failures = 1
      await assert.rejects(f.service.getManagedModelAccess(), /test persistence failure/u)
      const replacement =
        change === 'account'
          ? session('b', 'winner', true)
          : change === 'family'
            ? { ...session('a', 'winner', true), sessionFamilyId: 'new-family' }
            : session('a', 'winner', true)
      if (change === 'logout') await f.service.signOut()
      else if (change === 'external-logout') await f.store.disconnect()
      else await f.store.save(replacement)
      if (change === 'logout' || change === 'external-logout') {
        await assert.rejects(f.service.getManagedModelAccess())
        assert.equal(await f.store.load(), null)
      } else {
        await f.service.getManagedModelAccess()
        assert.deepEqual(await f.store.load(), replacement)
        assert.deepEqual(f.usedTokens, ['Bearer access-winner'])
      }
      assert.equal(f.refreshCalls(), 1)
    } finally {
      await f.close()
    }
  })
}

test('logout while refresh awaits its network result cannot revive the binding', async () => {
  const f = await fixture()
  try {
    let resolveRefresh!: (response: Response) => void
    let started!: () => void
    const entered = new Promise<void>((resolve) => {
      started = resolve
    })
    const response = new Promise<Response>((resolve) => {
      resolveRefresh = resolve
    })
    const service = new WorkbenchAccountService(
      f.store,
      async () => {},
      'https://cloud.example.com',
      (async (input: string | URL | Request) => {
        if (String(input).endsWith('/refresh')) {
          started()
          return response
        }
        return Response.json({})
      }) as typeof fetch
    )
    const operation = service.getManagedModelAccess()
    const rejected = assert.rejects(operation)
    await entered
    await service.signOut()
    resolveRefresh(Response.json(session('a', 'late', true)))
    await rejected
    assert.equal(await f.store.load(), null)
  } finally {
    await f.close()
  }
})
