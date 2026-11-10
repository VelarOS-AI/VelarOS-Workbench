import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, rmdir } from 'node:fs/promises'
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

function googleStartResponse(): Response {
  return Response.json({
    authorizationUrl: 'https://accounts.google.com/authorize',
    attemptId: 'attempt-new',
    exchangeToken: 'exchange-new',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    pollAfterMs: 0,
  })
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

test('logout cancels an outstanding Google sign-in and rejects its late session result', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'workbench-signin-logout-'))
  const store = new WorkbenchSharedAccountStore({ rootDir })
  const entered = Promise.withResolvers<void>()
  const response = Promise.withResolvers<Response>()
  let requestSignal: AbortSignal | undefined
  try {
    const service = new WorkbenchAccountService(
      store,
      async () => {},
      'https://cloud.example.com',
      (async (input: string | URL | Request, init?: RequestInit) => {
        if (String(input).endsWith('/start'))
          return Response.json({
            authorizationUrl: 'https://accounts.google.com/authorize',
            attemptId: 'attempt-1',
            exchangeToken: 'exchange-1',
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
            pollAfterMs: 0,
          })
        requestSignal = init?.signal ?? undefined
        entered.resolve()
        return response.promise
      }) as typeof fetch
    )
    const login = service.signIn()
    const rejected = assert.rejects(login)
    await entered.promise

    await service.signOut()
    assert.equal(requestSignal?.aborted, true)
    response.resolve(Response.json({ status: 'complete', session: session('a', 'late', true) }))
    await rejected
    assert.equal(await store.load(), null)
  } finally {
    await rm(rootDir, { recursive: true, force: true })
  }
})

test('a late logout receipt cannot report signed-out after a newer Google sign-in', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'workbench-late-logout-'))
  const store = new WorkbenchSharedAccountStore({ rootDir })
  const logoutEntered = Promise.withResolvers<void>()
  const logoutResponse = Promise.withResolvers<Response>()
  const winner = session('b', 'winner', true)
  let logout: Promise<unknown> | undefined
  let login: Promise<unknown> | undefined
  try {
    await store.save(session('a', 'old', true))
    const service = new WorkbenchAccountService(store, async () => {}, 'https://cloud.example.com', (async input => {
      const url = String(input)
      if (url.endsWith('/logout')) {
        logoutEntered.resolve()
        return logoutResponse.promise
      }
      if (url.endsWith('/desktop/start')) return googleStartResponse()
      assert.ok(url.endsWith('/desktop/session'), url)
      return Response.json({ status: 'complete', session: winner })
    }) as typeof fetch)
    logout = service.signOut()
    const rejectedLogout = assert.rejects(logout)
    await logoutEntered.promise
    const signingIn = service.signIn()
    login = signingIn
    assert.deepEqual(await signingIn, { status: 'signed-in', account: winner.account })
    logoutResponse.resolve(Response.json({}))
    await rejectedLogout
    assert.deepEqual(await store.load(), winner)
    assert.equal((await service.getState()).status, 'signed-in')
  } finally {
    logoutResponse.resolve(Response.json({}))
    await Promise.allSettled([logout, login])
    await rm(rootDir, { recursive: true, force: true })
  }
})

test('a logout waiting for the shared mutation lock cannot disconnect a newer sign-in owner', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'workbench-logout-lock-'))
  const lockPath = join(rootDir, '.account-sessions.lock')
  const disconnectEntered = Promise.withResolvers<void>()
  const startEntered = Promise.withResolvers<void>()
  const startResponse = Promise.withResolvers<Response>()
  let ownsFixtureLock = false
  class WaitingStore extends WorkbenchSharedAccountStore {
    public override async disconnect(assertCurrent?: () => void): Promise<boolean> {
      await mkdir(lockPath)
      ownsFixtureLock = true
      disconnectEntered.resolve()
      return super.disconnect(assertCurrent)
    }
  }
  const store = new WaitingStore({ rootDir })
  const previous = session('a', 'old', true)
  const winner = session('b', 'winner', true)
  let logout: Promise<unknown> | undefined
  let login: Promise<unknown> | undefined
  let remoteLogouts = 0
  try {
    await store.save(previous)
    const service = new WorkbenchAccountService(store, async () => {}, 'https://cloud.example.com', (async input => {
      const url = String(input)
      if (url.endsWith('/desktop/start')) {
        startEntered.resolve()
        return startResponse.promise
      }
      if (url.endsWith('/logout')) {
        remoteLogouts += 1
        return Response.json({})
      }
      assert.ok(url.endsWith('/desktop/session'), url)
      return Response.json({ status: 'complete', session: winner })
    }) as typeof fetch)
    logout = service.signOut()
    const rejectedLogout = assert.rejects(logout)
    await disconnectEntered.promise
    const signingIn = service.signIn()
    login = signingIn
    await rmdir(lockPath)
    ownsFixtureLock = false
    await rejectedLogout
    await startEntered.promise
    // The new login has not saved yet: an obsolete logout must not remove the old binding either.
    assert.deepEqual(await store.load(), previous)
    startResponse.resolve(googleStartResponse())
    assert.deepEqual(await signingIn, { status: 'signed-in', account: winner.account })
    assert.deepEqual(await store.load(), winner)
    assert.equal(remoteLogouts, 0)
  } finally {
    if (ownsFixtureLock) await rmdir(lockPath)
    startResponse.resolve(googleStartResponse())
    await Promise.allSettled([logout, login])
    await rm(rootDir, { recursive: true, force: true })
  }
})

test('expired-session cleanup preserves a newer shared login and only disconnects the current expired binding', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'workbench-expiry-winner-'))
  const loaded = Promise.withResolvers<void>()
  const continueLoad = Promise.withResolvers<void>()
  class PausedStore extends WorkbenchSharedAccountStore {
    pauseNextLoad = true
    public override async load(): Promise<WorkbenchCloudSession | null> {
      const current = await super.load()
      if (this.pauseNextLoad) {
        this.pauseNextLoad = false
        loaded.resolve()
        await continueLoad.promise
      }
      return current
    }
  }
  const store = new PausedStore({ rootDir })
  const desktop = new WorkbenchSharedAccountStore({ rootDir, productId: 'velaros.desktop' })
  const expired = { ...session(), refreshExpiresAt: new Date(0).toISOString() }
  const winner = { ...session('a', 'winner', true), sessionFamilyId: 'family-new-login' }
  let reading: Promise<unknown> | undefined
  try {
    await store.save(expired)
    const service = new WorkbenchAccountService(store, async () => {})
    const state = service.getState()
    reading = state
    await loaded.promise
    await desktop.save(winner)
    continueLoad.resolve()
    assert.deepEqual(await state, { status: 'signed-in', account: winner.account })
    assert.deepEqual(await store.load(), winner)
    assert.deepEqual(await desktop.load(), winner)

    await store.save(expired)
    assert.deepEqual(await service.getState(), { status: 'signed-out' })
    assert.equal(await store.load(), null)
    assert.deepEqual(await desktop.load(), expired)
  } finally {
    continueLoad.resolve()
    await Promise.allSettled([reading])
    await rm(rootDir, { recursive: true, force: true })
  }
})
