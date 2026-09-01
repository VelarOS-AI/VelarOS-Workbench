import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, test } from 'bun:test'

import { WorkbenchAccountService } from '../src/main/account/WorkbenchAccountService'
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
})
