import assert from 'node:assert/strict'

import { describe, test } from 'bun:test'

import {
  appendStandaloneUsageTelemetry,
  readStandaloneUsageTelemetry,
  restoreStandaloneUsageTelemetry,
  retainStandaloneUsageTelemetryThrough,
  serializeStandaloneUsageTelemetry,
  type StandaloneUsageTelemetry,
  StandaloneUsageTelemetryLimit,
} from '../src/renderer/src/runtime/standaloneUsageTelemetry'

function usageEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: 'usage-telemetry',
    turn: 1,
    model: 'gpt-5.6-sol',
    inputTokens: 120_000,
    outputTokens: 1_500,
    visibleOutputTokens: 500,
    totalTokens: 121_500,
    reasoningTokens: 1_000,
    cachedInputTokens: 110_000,
    cacheReadInputTokens: 110_000,
    finishReasons: ['tool-calls'],
    rawFinishReasons: ['tool_calls'],
    source: 'provider',
    confidence: 'high',
    timestamp: 1_000,
    ...overrides,
  }
}

function readEntry(overrides: Record<string, unknown> = {}): StandaloneUsageTelemetry {
  const entry = readStandaloneUsageTelemetry(usageEvent(overrides))
  assert.ok(entry)
  return entry
}

void describe('standalone usage telemetry', () => {
  void test('keeps the token categories pricing needs and drops diagnostics', () => {
    const entry = readEntry()

    assert.equal(entry.inputTokens, 120_000)
    assert.equal(entry.outputTokens, 1_500)
    assert.equal(entry.reasoningTokens, 1_000)
    assert.equal(entry.cacheReadInputTokens, 110_000)
    assert.equal('finishReasons' in entry, false)
    assert.equal('rawFinishReasons' in entry, false)
  })

  void test('ignores other runtime events and payloads without a model or timestamp', () => {
    assert.equal(readStandaloneUsageTelemetry({ kind: 'context-usage-estimate', percent: 50 }), null)
    assert.equal(readStandaloneUsageTelemetry(usageEvent({ model: undefined })), null)
    assert.equal(readStandaloneUsageTelemetry(usageEvent({ timestamp: 'later' })), null)
  })

  void test('de-duplicates repeated events and keeps only the newest entries', () => {
    let entries: readonly StandaloneUsageTelemetry[] = []
    entries = appendStandaloneUsageTelemetry(entries, readEntry())
    entries = appendStandaloneUsageTelemetry(entries, readEntry())
    assert.equal(entries.length, 1)

    for (let turn = 2; turn <= StandaloneUsageTelemetryLimit + 5; turn += 1)
      entries = appendStandaloneUsageTelemetry(entries, readEntry({ turn, timestamp: 1_000 + turn }))

    assert.equal(entries.length, StandaloneUsageTelemetryLimit)
    assert.equal(entries.at(-1)?.turn, StandaloneUsageTelemetryLimit + 5)
  })

  void test('round-trips through the compact persisted shape', () => {
    const entries = [readEntry(), readEntry({ turn: 2, timestamp: 2_000, costUsd: 0.25 })]
    const persisted = serializeStandaloneUsageTelemetry(entries)

    assert.equal('kind' in persisted[0]!, false)
    assert.deepEqual(restoreStandaloneUsageTelemetry(JSON.parse(JSON.stringify(persisted))), entries)
    assert.deepEqual(restoreStandaloneUsageTelemetry('not a list'), [])
  })

  void test('drops usage of runs removed by a rewind', () => {
    const entries = [readEntry({ timestamp: 1_000 }), readEntry({ turn: 2, timestamp: 5_000 })]

    assert.deepEqual(
      retainStandaloneUsageTelemetryThrough(entries, 2_000).map((entry) => entry.timestamp),
      [1_000]
    )
    assert.deepEqual(retainStandaloneUsageTelemetryThrough(entries, null), [])
  })
})
