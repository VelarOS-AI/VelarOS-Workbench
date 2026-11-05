import assert from 'node:assert/strict'

import { test } from 'bun:test'

import {
  appendStandaloneUsageTelemetry,
  createStandaloneUsageTelemetrySerializer,
  readStandaloneUsageTelemetry,
  restoreStandaloneUsageTelemetry,
  serializeStandaloneUsageTelemetry,
} from '../src/renderer/src/runtime/standaloneUsageTelemetry'

test('persistence reuses unchanged usage and refreshes replayed requests without changing disk format', () => {
  const entry = readStandaloneUsageTelemetry({
    kind: 'usage-telemetry',
    model: 'model',
    timestamp: 1,
    requestId: 'request',
    inputTokens: 100,
    outputTokens: 10,
  })
  assert.ok(entry)
  const entries = Object.freeze([entry])
  const serialize = createStandaloneUsageTelemetrySerializer()
  const first = serialize(entries)
  assert.equal(serialize(entries), first)
  assert.deepEqual(first, serializeStandaloneUsageTelemetry(entries))
  assert.deepEqual(restoreStandaloneUsageTelemetry(JSON.parse(JSON.stringify(first))), entries)
  const updated = appendStandaloneUsageTelemetry(entries, { ...entry, outputTokens: 20 })
  assert.notEqual(serialize(updated), first)
  assert.equal(serialize(updated)[0]?.outputTokens, 20)
  assert.equal(first[0]?.outputTokens, 10)
  assert.equal(serialize(entries), first)
  assert.notEqual(createStandaloneUsageTelemetrySerializer()(entries), first)
})

test('empty arrays are cached and distinct sessions never share mutable output', () => {
  const serialize = createStandaloneUsageTelemetrySerializer()
  const empty = Object.freeze([])
  assert.equal(serialize(empty), serialize(empty))
  assert.notEqual(serialize([]), serialize(empty))
  assert.deepEqual(restoreStandaloneUsageTelemetry(serialize(empty)), [])
})
