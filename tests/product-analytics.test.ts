import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'bun:test'

import { WorkbenchProductAnalyticsReporter } from '../src/main/analytics/WorkbenchProductAnalyticsReporter'

const temporaryRoots: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  )
})

describe('WorkbenchProductAnalyticsReporter', () => {
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
})
