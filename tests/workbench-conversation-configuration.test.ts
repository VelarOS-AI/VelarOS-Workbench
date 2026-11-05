import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { AgentModelResolverApi } from '@velaros-ai/velaros/model'

import { ConversationModelDriver } from '../src/main/conversation/ConversationModelDriver'
import { createWorkbenchConversationConfiguration } from '../src/main/conversation/WorkbenchConversationConfiguration'
import type { WorkbenchConversationSendRequest } from '../src/shared/workbenchConversation'

type Resolved = Awaited<ReturnType<AgentModelResolverApi['resolve']>>

const request: WorkbenchConversationSendRequest = {
  sessionId: 'session-a',
  projectRoot: '/tmp/capacity-test',
  text: 'hello',
  inputId: 'input-a',
  model: { provider: 'openrouter', model: 'unknown-model', apiKey: 'fixture-key' },
  locale: 'zh-CN',
  reasoningLevel: 'medium',
  executionModes: [],
  permissionMode: 'standard-open',
  memory: false,
  webSearchEngine: 'google',
}

void test('configuration reuses learned limits only for the same session and model connection', async () => {
  let declared: number | undefined = undefined
  const configure = createWorkbenchConversationConfiguration({
    resolve: async (selection) =>
      ({
        providerId: selection.provider,
        model: selection.model,
        providerModel: selection.model,
        contextWindow: declared,
        supportedInputModalities: ['text'],
        provider: () => ({
          provider: 'fixture',
          modelId: selection.model,
          specificationVersion: 'v3',
        }),
      }) as Resolved,
  })
  const modelFor = async (input = request) => {
    const configured = await configure(input, new AbortController().signal)
    assert(configured.model instanceof ConversationModelDriver)
    return configured.model
  }
  const initial = await modelFor()
  assert.equal(initial.id, 'openrouter/unknown-model')
  const managed = await modelFor({
    ...request,
    model: { provider: 'velar-dev', model: 'velar-dev/gpt-5.6-sol' },
  })
  assert.equal(managed.id, 'velar-dev/gpt-5.6-sol')
  assert.equal(initial.limits.contextTokens, 1_000_000)
  initial.limits.reject(
    { type: 'error', code: 'context-limit', message: 'maximum context length is 200000 tokens' },
    240000
  )
  assert.equal((await modelFor()).limits, initial.limits)
  for (const changed of [
    { ...request, sessionId: 'session-b' },
    { ...request, model: { ...request.model, model: 'another-model' } },
    { ...request, model: { ...request.model, apiKey: 'rotated-fixture-key' } },
    { ...request, model: { ...request.model, baseURL: 'https://fixture.invalid/v1' } },
  ]) {
    const model = await modelFor(changed)
    assert.notEqual(model.limits, initial.limits)
    assert.equal(model.limits.contextTokens, 1_000_000)
  }
  declared = 300_000
  const declaredModel = await modelFor()
  assert.equal(declaredModel.limits.contextTokens, declared)
  assert.equal(declaredModel.limits.contextWindowEstimated, false)
})
