import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { ModelDriver, ModelTurnDelta, ModelTurnRequest } from '@velaros-ai/velaros/model'

import { ConversationContextCapacity } from '../src/main/conversation/ConversationContextCapacity'
import { ConversationModelDriver } from '../src/main/conversation/ConversationModelDriver'
import { contextUsageFromProvider } from '../src/main/conversation/WorkbenchConversationRules'

const Request: ModelTurnRequest = {
  instructions: 'test',
  materials: [],
  compiledPrompt: 'test',
  response: { type: 'text' },
  mode: 'work',
  outputTokens: 12_000,
}

function fixture(contextWindow?: number, tokens = 260_000) {
  const limits = new ConversationContextCapacity(contextWindow)
  let response: readonly ModelTurnDelta[] = [{ type: 'finish', reason: 'stop' }]
  const driver: ModelDriver = {
    id: 'provider/unknown-model',
    nativeTools: true,
    limits,
    estimate: async () => ({ tokens, precision: 'exact', basis: 'test' }),
    async *stream(request, signal) {
      assert.equal(request, Request)
      signal.throwIfAborted()
      yield* response
    },
  }
  const model = new ConversationModelDriver(driver, limits)
  return {
    model,
    limits,
    reply: async (deltas: readonly ModelTurnDelta[], signal = new AbortController().signal) => {
      response = deltas
      return Array.fromAsync(model.stream(Request, signal))
    },
  }
}

void test('unknown capacity starts at a large provisional budget and provider usage keeps that distinction', () => {
  const { model } = fixture()
  assert.equal(model.limits.contextTokens, 1_000_000)
  assert.equal(model.limits.inputTokens, 983_904)
  assert.equal(model.nativeTools, true)
  const usage = contextUsageFromProvider({
    turn: 1,
    model: model.id,
    inputTokens: 260_000,
    limits: model.limits,
    timestamp: 1,
  })
  assert.equal(usage.contextWindowEstimated, true)
  assert.equal(usage.usableContextWindow, model.limits.inputTokens)
  assert.equal(usage.percent, (260_000 / model.limits.inputTokens) * 100)
})

void test('declared capacities remain authoritative, including small models', () => {
  for (const window of [4096, 8192, 32_000, 128_000, 2_000_000]) {
    const { limits } = fixture(window)
    assert.equal(limits.contextTokens, window)
    assert.equal(limits.contextWindowEstimated, false)
    assert(limits.inputTokens > 0)
    assert(limits.inputTokens + limits.outputTokens < window)
  }
})

void test('a rejected request learns the explicit maximum before recovery observes the error', async () => {
  const f = fixture()
  const limits = f.model.limits
  const response: ModelTurnDelta[] = [
    {
      type: 'error',
      code: 'context-limit',
      message:
        "This model's maximum context length is 200,000 tokens. You requested 260,000 tokens.",
    },
  ]
  assert.deepEqual(await f.reply(response), response)
  assert.equal(f.model.limits, limits)
  assert.equal(limits.contextTokens, 200_000)
  assert.equal(limits.inputTokens, 183_904)
  assert.equal(limits.contextWindowEstimated, false)
  await f.reply(response)
  assert.equal(limits.contextTokens, 200_000)
  assert.equal(limits.contextWindowEstimated, false)
})

void test('provider input-only maxima are distinguished from requested input and total windows', async () => {
  for (const message of [
    'prompt is too long: 260000 tokens > 200000 maximum',
    'input token count (260000) exceeds the maximum number of tokens allowed (200000)',
    'maximum input tokens: 200,000; received 260,000',
  ]) {
    const f = fixture()
    const reply = await f.reply([{ type: 'error', code: 'provider', message }])
    assert.equal(reply[0]?.type, 'error')
    assert.deepEqual(reply, [{ type: 'error', code: 'context-limit', message }])
    assert.equal(f.limits.inputTokens, 200_000 - 4096)
    assert.equal(f.limits.contextWindowEstimated, false)
  }
})

void test('a context rejection without a maximum tightens near the failed request', async () => {
  const f = fixture()
  await f.reply([{ type: 'error', code: 'context-limit', message: 'context_length_exceeded' }])
  assert.equal(f.limits.inputTokens, 234_000)
  assert.equal(f.limits.contextWindowEstimated, true)
})

void test('learning a small input capacity cannot regain rejected input when output reserve shrinks', async () => {
  const f = fixture()
  await f.reply([{ type: 'error', code: 'context-limit', message: 'maximum input tokens: 8192' }])
  assert(f.limits.inputTokens < 8192)
  assert(f.limits.outputTokens < 12_000)
  assert(f.limits.inputTokens + f.limits.outputTokens < f.limits.contextTokens)
})

void test('provider failures, accepted output and cancellation preserve capacity and stream identity', async () => {
  const f = fixture()
  const response: ModelTurnDelta[] = [
    { type: 'reasoning', text: 'thinking' },
    { type: 'text', text: 'answer' },
    { type: 'tool-call', value: { id: 'call', name: 'exec', input: { code: '1 + 1' } } },
    { type: 'usage', inputTokens: 180_000, outputTokens: 100 },
    { type: 'finish', reason: 'stop' },
  ]
  assert.deepEqual(await f.reply(response), response)
  const failure: ModelTurnDelta[] = [
    { type: 'error', code: 'provider', message: 'rate limit: 200000 tokens per minute' },
  ]
  assert.deepEqual(await f.reply(failure), failure)
  assert.equal(f.limits.contextTokens, 1_000_000)
  const rateFailure: ModelTurnDelta[] = [
    {
      type: 'error',
      code: 'provider',
      message: 'rate limit: 260000 tokens > 200000 maximum per minute',
      retryAfterMs: 1000,
    },
  ]
  assert.deepEqual(await f.reply(rateFailure), rateFailure)
  assert.equal(f.limits.contextTokens, 1_000_000)
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(f.reply(response, controller.signal), { name: 'AbortError' })
  assert.equal(f.limits.contextTokens, 1_000_000)
})
