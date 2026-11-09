import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'bun:test'

import { WorkbenchProductAnalyticsPreferencesStore } from '../src/main/analytics/WorkbenchProductAnalyticsPreferencesStore'
import { WorkbenchProductAnalyticsReporter } from '../src/main/analytics/WorkbenchProductAnalyticsReporter'

const temporaryRoots: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  )
})

describe('WorkbenchProductAnalyticsReporter', () => {
  test('defaults on and persists the one-time notice choice', async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), 'workbench-analytics-preferences-test-'))
    temporaryRoots.push(dataRoot)
    const preferences = new WorkbenchProductAnalyticsPreferencesStore(dataRoot)
    expect(preferences.value).toEqual({
      enabled: true,
      noticeRequired: false,
      noticeResolved: false,
      consentDecision: 'unresolved',
      consentReceiptRecorded: false,
    })

    preferences.requireNotice()
    preferences.resolveNotice('declined')
    expect(new WorkbenchProductAnalyticsPreferencesStore(dataRoot).value).toEqual({
      enabled: false,
      noticeRequired: false,
      noticeResolved: true,
      consentDecision: 'declined',
      consentReceiptRecorded: false,
    })
  })

  test('counts only foreground use and waits ten minutes between upload attempts', async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), 'workbench-analytics-test-'))
    temporaryRoots.push(dataRoot)
    let now = Date.parse('2026-08-27T00:00:00.000Z')
    let active = false
    const requests: RequestInit[] = []
    const reporter = await WorkbenchProductAnalyticsReporter.create({
      dataRoot,
      appVersion: '1.2.3',
      isActive: () => active,
      now: () => now,
      fetchImpl: (async (_input, init) => {
        requests.push(init ?? {})
        return new Response(null, { status: 202 })
      }) as typeof fetch,
    })
    expect(reporter).toBeDefined()
    reporter!.setConsentState({
      noticeResolved: true,
      reportingAllowed: true,
      onNoticeRequired: () => undefined,
    })

    now += 10 * 60_000
    await reporter!.flush()
    expect(requests).toHaveLength(0)

    active = true
    now += 10 * 60_000
    await reporter!.flush()
    expect(requests).toHaveLength(1)
    expect(JSON.parse(String(requests[0]?.body))).toMatchObject({
      product: 'workbench',
      activeSeconds: 60,
      appVersion: '1.2.3',
    })

    now += 60_000
    await reporter!.flush()
    expect(requests).toHaveLength(1)
    now += 9 * 60_000
    await reporter!.flush()
    expect(requests).toHaveLength(2)
  })

  test('does not retry a failed upload on every sample', async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), 'workbench-analytics-retry-test-'))
    temporaryRoots.push(dataRoot)
    let now = Date.parse('2026-08-27T00:00:00.000Z')
    let attempts = 0
    const reporter = await WorkbenchProductAnalyticsReporter.create({
      dataRoot,
      appVersion: '1.2.3',
      isActive: () => true,
      now: () => now,
      fetchImpl: (async () => {
        attempts += 1
        return new Response(null, { status: attempts === 1 ? 503 : 202 })
      }) as typeof fetch,
    })
    reporter!.setConsentState({
      noticeResolved: true,
      reportingAllowed: true,
      onNoticeRequired: () => undefined,
    })

    now += 10 * 60_000
    await reporter!.flush()
    expect(attempts).toBe(1)
    now += 60_000
    await reporter!.flush()
    expect(attempts).toBe(1)
    now += 9 * 60_000
    await reporter!.flush()
    expect(attempts).toBe(2)
  })

  test('an old upload cannot subtract usage collected after analytics is re-enabled', async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), 'workbench-analytics-reenabled-test-'))
    temporaryRoots.push(dataRoot)
    let now = Date.parse('2026-08-27T00:00:00.000Z')
    const firstUpload = Promise.withResolvers<Response>()
    const requests: RequestInit[] = []
    const reporter = await WorkbenchProductAnalyticsReporter.create({
      dataRoot,
      appVersion: '1.2.3',
      isActive: () => true,
      now: () => now,
      fetchImpl: (async (_input, init) => {
        requests.push(init ?? {})
        return requests.length === 1 ? firstUpload.promise : new Response(null, { status: 202 })
      }) as typeof fetch,
    })
    expect(reporter).toBeDefined()
    reporter!.setConsentState({
      noticeResolved: true,
      reportingAllowed: true,
      onNoticeRequired: () => undefined,
    })
    try {
      reporter!.recordRunStarted({
        executionId: 'old-run',
        sessionId: 'old-chat',
        projectRoot: null,
        modelSelection: null,
      })
      reporter!.recordAgentEvent({ type: 'tool-start', toolName: 'script' }, null)
      now += 60_000
      const uploading = reporter!.flush(true)
      expect(requests).toHaveLength(1)

      reporter!.setEnabled(false)
      reporter!.setEnabled(true)
      reporter!.recordRunStarted({
        executionId: 'new-run',
        sessionId: 'new-chat',
        projectRoot: null,
        modelSelection: null,
      })
      reporter!.recordAgentEvent({ type: 'tool-start', toolName: 'script' }, null)
      firstUpload.resolve(new Response(null, { status: 202 }))
      await uploading
      now += 60_000
      await reporter!.flush(true)

      expect(requests).toHaveLength(2)
      expect(JSON.parse(String(requests[1]?.body))).toMatchObject({
        activeSeconds: 60,
        conversationCount: 1,
        toolCallCount: 1,
      })
    } finally {
      firstUpload.resolve(new Response(null, { status: 202 }))
      await reporter!.dispose()
    }
  })

  test('requests one explicit choice after thirty active minutes and keeps usage blocked', async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), 'workbench-analytics-consent-test-'))
    temporaryRoots.push(dataRoot)
    let now = Date.parse('2026-08-27T00:00:00.000Z')
    let noticeCount = 0
    const requests: Array<{ input: RequestInfo | URL; init?: RequestInit }> = []
    const reporter = await WorkbenchProductAnalyticsReporter.create({
      dataRoot,
      appVersion: '1.2.3',
      isActive: () => true,
      now: () => now,
      fetchImpl: (async (input, init) => {
        requests.push({ input, init })
        return new Response(null, { status: 202 })
      }) as typeof fetch,
    })
    reporter!.setConsentState({
      noticeResolved: false,
      reportingAllowed: false,
      onNoticeRequired: () => {
        noticeCount += 1
      },
    })

    for (let index = 0; index < 30; index += 1) {
      now += 60_000
      await reporter!.flush()
    }
    expect(noticeCount).toBe(1)
    expect(requests).toHaveLength(0)

    reporter!.setConsentState({
      noticeResolved: true,
      reportingAllowed: false,
      onNoticeRequired: () => undefined,
    })
    await reporter!.flush(true)
    expect(requests).toHaveLength(0)

    await reporter!.recordConsentDecision('declined')
    expect(String(requests[0]?.input)).toEndWith('/v1/analytics/consent')
    expect(JSON.parse(String(requests[0]?.init?.body))).toMatchObject({
      product: 'workbench',
      decision: 'declined',
    })
  })
})
