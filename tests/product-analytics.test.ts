import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test'

import { WorkbenchProductAnalyticsPreferencesStore } from '../src/main/analytics/WorkbenchProductAnalyticsPreferencesStore'
import { WorkbenchProductAnalyticsReporter } from '../src/main/analytics/WorkbenchProductAnalyticsReporter'
import { WorkbenchProductAnalyticsChannels } from '../src/shared/workbenchProductAnalytics'

const temporaryRoots: string[] = []
const ipcHandlers = new Map<string, (...args: unknown[]) => unknown>()
const broadcasts: unknown[] = []

mock.module('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) => ipcHandlers.set(channel, handler),
    removeHandler: (channel: string) => ipcHandlers.delete(channel),
  },
  BrowserWindow: {
    getAllWindows: () => [{
      isDestroyed: () => false,
      webContents: { send: (_channel: string, state: unknown) => broadcasts.push(state) },
    }],
  },
  shell: { openExternal: async () => undefined },
}))

afterEach(async () => {
  ipcHandlers.clear()
  broadcasts.length = 0
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

  test('unreadable analytics preferences remain unavailable through the installer without replacing data', async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), 'workbench-analytics-unavailable-'))
    temporaryRoots.push(dataRoot)
    const directory = join(dataRoot, 'storage')
    const path = join(directory, 'product-analytics-preferences.json')
    await mkdir(directory)
    const { installWorkbenchProductAnalyticsRuntime } = await import('../src/main/analytics/WorkbenchProductAnalyticsRuntime')
    let requests = 0
    let now = 0
    const reporter = await WorkbenchProductAnalyticsReporter.create({
      dataRoot,
      appVersion: '1.2.3',
      isActive: () => true,
      now: () => now,
      fetchImpl: (async () => { requests += 1; return new Response(null, { status: 202 }) }) as typeof fetch,
    })
    expect(reporter).toBeDefined()
    const invoke = (channel: string, value?: unknown): Promise<unknown> => Promise.resolve().then(() => {
      const handler = ipcHandlers.get(channel)
      expect(handler).toBeDefined()
      return handler!({}, value)
    })
    const inspectUnavailable = async (): Promise<void> => {
      const dispose = installWorkbenchProductAnalyticsRuntime({
        dataRootDir: dataRoot,
        privacyDetailsUrl: 'https://privacy.test/details',
        reporter,
      })
      try {
        await expect(invoke(WorkbenchProductAnalyticsChannels.getState)).rejects.toThrow()
        await expect(invoke(WorkbenchProductAnalyticsChannels.setEnabled, false)).rejects.toThrow()
        await expect(invoke(WorkbenchProductAnalyticsChannels.resolveNotice, 'declined')).rejects.toThrow()
        await expect(invoke(WorkbenchProductAnalyticsChannels.openDetails)).resolves.toBeUndefined()
        // As in app-ready, the reporter may subsequently start, but the failed
        // composition must have stopped collection without inventing preferences.
        reporter!.start()
        reporter!.setConsentState({
          noticeResolved: true,
          reportingAllowed: true,
          onNoticeRequired: () => { throw new Error('No consent notice owner is available') },
        })
        now += 60_000
        await reporter!.flush(true)
        expect(requests).toBe(0)
        expect(broadcasts).toHaveLength(0)
      } finally {
        await dispose()
      }
    }
    try {
      for (const source of [
        '{"version":99,"enabled":false,"futurePreference":"keep"}\n',
        '{"version":1,',
        '{"version":1,"enabled":false}\n',
      ]) {
        await writeFile(path, source)
        await inspectUnavailable()
        expect(await readFile(path, 'utf8')).toBe(source)
      }
      // A directory in place of the file is a real non-ENOENT read failure,
      // without depending on machine-specific permission/ACL behavior.
      await rm(path)
      await mkdir(path)
      await writeFile(join(path, 'keep.txt'), 'keep this directory')
      await inspectUnavailable()
      expect(await readFile(join(path, 'keep.txt'), 'utf8')).toBe('keep this directory')
    } finally {
      await reporter!.dispose()
    }
  })

  test('runtime close waits for a late consent response without writing or broadcasting it', async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), 'workbench-analytics-closing-'))
    temporaryRoots.push(dataRoot)
    const preferences = new WorkbenchProductAnalyticsPreferencesStore(dataRoot)
    preferences.resolveNotice('allowed')
    const path = join(dataRoot, 'storage', 'product-analytics-preferences.json')
    const previousBytes = await readFile(path)
    const response = Promise.withResolvers<Response>()
    const requests: Array<{ input: RequestInfo | URL; init?: RequestInit }> = []
    let now = 0
    const reporter = await WorkbenchProductAnalyticsReporter.create({
      dataRoot,
      appVersion: '1.2.3',
      isActive: () => true,
      now: () => now,
      fetchImpl: (async (input, init) => {
        requests.push({ input, init })
        // Deliberately ignore abort: close must wait for the actual response and
        // still reject its late success before persisting the consent receipt.
        return response.promise
      }) as typeof fetch,
    })
    expect(reporter).toBeDefined()
    const disposeReporter = spyOn(reporter!, 'dispose')
    const { installWorkbenchProductAnalyticsRuntime } = await import('../src/main/analytics/WorkbenchProductAnalyticsRuntime')
    const stopRuntime = installWorkbenchProductAnalyticsRuntime({
      dataRootDir: dataRoot,
      privacyDetailsUrl: 'https://privacy.test/details',
      reporter,
    })
    let cleanup: Promise<void> | undefined
    try {
      reporter!.start()
      expect(requests).toHaveLength(1)
      expect(String(requests[0]?.input)).toEndWith('/v1/analytics/consent')
      const signal = requests[0]?.init?.signal
      expect(signal?.aborted).toBe(false)
      const previousBroadcasts = broadcasts.length
      now += 60_000

      const runtimeClosing = stopRuntime()
      cleanup = runtimeClosing.finally(() => reporter!.dispose())
      expect(signal?.aborted).toBe(true)
      expect(ipcHandlers.size).toBe(0)
      await Promise.resolve()
      expect(disposeReporter).not.toHaveBeenCalled()

      response.resolve(new Response(null, { status: 202 }))
      await cleanup
      expect(disposeReporter).toHaveBeenCalledTimes(1)
      expect(await readFile(path)).toEqual(previousBytes)
      expect(new WorkbenchProductAnalyticsPreferencesStore(dataRoot).value.consentReceiptRecorded).toBe(false)
      expect(broadcasts).toHaveLength(previousBroadcasts)
      expect(requests).toHaveLength(1)
    } finally {
      response.resolve(new Response(null, { status: 202 }))
      try {
        await (cleanup ?? stopRuntime().finally(() => reporter!.dispose()))
      } finally {
        disposeReporter.mockRestore()
      }
    }
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
