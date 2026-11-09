import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { test } from 'bun:test'

import { WorkbenchProductAnalyticsPreferencesStore } from '../src/main/analytics/WorkbenchProductAnalyticsPreferencesStore'
import { WorkbenchUpdatePreferencesStore } from '../src/main/updates/WorkbenchUpdatePreferencesStore'

test('failed preference writes preserve the visible choice and the same update can be retried', async () => {
  const root = await mkdtemp(join(tmpdir(), 'workbench-preferences-'))
  const storage = join(root, 'storage')
  const analytics = new WorkbenchProductAnalyticsPreferencesStore(root)
  const updates = new WorkbenchUpdatePreferencesStore(root)
  try {
    await writeFile(storage, 'blocked directory')
    assert.throws(() => analytics.resolveNotice('declined'))
    assert.throws(() => updates.setAutomaticDownloads(false))
    assert.throws(() => updates.setChannel('canary'))
    assert.equal(analytics.value.consentDecision, 'unresolved')
    assert.equal(analytics.enabled, true)
    assert.equal(updates.automaticDownloads, true)
    assert.equal(updates.channel, 'stable')

    await rm(storage)
    await mkdir(storage)
    analytics.resolveNotice('declined')
    updates.setAutomaticDownloads(false)
    updates.setChannel('canary')
    const storedAnalytics = JSON.parse(await readFile(join(storage, 'product-analytics-preferences.json'), 'utf8'))
    const storedUpdate = JSON.parse(await readFile(join(storage, 'update-preferences.json'), 'utf8'))
    assert.equal(storedAnalytics.consentDecision, 'declined')
    assert.equal(storedAnalytics.enabled, false)
    assert.equal(storedUpdate.automaticDownloads, false)
    assert.equal(storedUpdate.channel, 'canary')
    assert.deepEqual(new WorkbenchProductAnalyticsPreferencesStore(root).value, analytics.value)
    assert.equal(new WorkbenchUpdatePreferencesStore(root).channel, updates.channel)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
