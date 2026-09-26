import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { simulateReadableStream } from 'ai'
import { MockLanguageModelV3 } from 'ai/test'
import { test } from 'bun:test'

import { ExecutionEventBus } from '@velaros-ai/agent'
import { createModelRuntimeComposition } from '@velaros-ai/model/node'

import { WorkbenchAgentExecutionStack } from '../src/main/agent/WorkbenchAgentExecutionStack'
import { ProjectCapabilityProvider } from '../src/main/workspace/ProjectCapabilityProvider'

import { assertCurrentWorkbenchPrompt, type CapturedWorkbenchRequest } from './helpers/workbenchPromptAudit'

function response(call?: { toolName: string; toolCallId: string; input: string }) {
  return { stream: simulateReadableStream({ initialDelayInMs: null, chunkDelayInMs: null, chunks: [
    { type: 'stream-start' as const, warnings: [] },
    ...(call ? [{ type: 'tool-call' as const, ...call }] : [
      { type: 'text-start' as const, id: 'answer' },
      { type: 'text-delta' as const, id: 'answer', delta: 'Located Service.' },
      { type: 'text-end' as const, id: 'answer' },
    ]),
    { type: 'finish' as const, finishReason: { unified: call ? 'tool-calls' as const : 'stop' as const, raw: 'stop' }, usage: {
      inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 5, text: 5, reasoning: 0 },
    } },
  ] }) }
}

test('real Workbench tool discovery loads the six-action code schema into the next provider request', async () => {
  const root = await mkdtemp(join(tmpdir(), 'workbench-project-discovery-'))
  await writeFile(join(root, 'service.ts'), 'export function Service() { return 1 }\n')
  const provider = new ProjectCapabilityProvider()
  const requests: CapturedWorkbenchRequest[] = []
  let turn = 0
  const model = new MockLanguageModelV3({ provider: 'probe', modelId: 'probe', doStream: async (request) => {
    requests.push({ prompt: request.prompt, tools: request.tools })
    turn++
    const names = (request.tools ?? []).map((tool) => tool.name)
    if (turn === 1) {
      assert(names.includes('tooling__map'), `turn 1 missing tooling map: ${names}`)
      assert(names.includes('tooling__replace'), `turn 1 missing tooling replace: ${names}`)
      assert(!names.includes('project__code'), 'situational code schema should not be resident')
      assert(!names.includes('project__change'), 'situational change schema should not be resident')
      return response({ toolName: 'tooling__map', toolCallId: 'discover-code', input: JSON.stringify({ op: 'find', query: '代码符号引用' }) })
    }
    if (turn === 2) {
      assert(JSON.stringify(request.prompt).includes('project:code'), `turn 2 discovery result: ${JSON.stringify(request.prompt)}`)
      return response({ toolName: 'tooling__replace', toolCallId: 'load-code', input: JSON.stringify({ pageIn: ['tool:project:code'], reason: '定位 Service 声明' }) })
    }
    if (turn === 3) {
      const code = (request.tools ?? []).find((tool) => tool.name === 'project__code')
      assert(code, 'successful activation must update the next request')
      const schema = JSON.stringify(code)
      assert(schema.includes('symbols'))
      assert(schema.includes('references'))
      assert(!schema.includes('build_index'))
      assert(!schema.includes('find_symbols'))
      return response({ toolName: 'project__code', toolCallId: 'use-code', input: JSON.stringify({ action: 'symbols', path: 'service.ts', query: 'Service' }) })
    }
    assert.equal(turn, 4)
    assert(JSON.stringify(request.prompt).includes('Service'))
    return response()
  } })
  const composition = createModelRuntimeComposition()
  composition.agentModelRuntime.createAgentProvider = () => () => model
  composition.agentModelRuntime.resolveRoleRuntime = async () => ({ provider: () => model, providerId: 'probe', model: 'probe', providerModel: 'probe', contextWindow: 128000, supportedInputModalities: ['text'], resolutionSource: 'provider-collection', resolutionTrace: [] })
  const stack = new WorkbenchAgentExecutionStack(provider, composition)
  try {
    const result = await stack.run({ sessionId: 'discovery', executionId: 'discovery-run', projectRoot: root,
      messages: [{ role: 'user', content: '检查 Service 的声明。' }],
      config: { modelSelection: { provider: 'probe', model: 'probe' }, permissionConfirmationMode: 'never-ask' },
      events: new ExecutionEventBus({}), abortSignal: new AbortController().signal,
    })
    assert.equal(result.status, 'completed')
    assert.equal(turn, 4)
    for (const request of requests) assertCurrentWorkbenchPrompt(request)
  } finally {
    await stack.dispose()
    await provider.dispose()
    await rm(root, { recursive: true, force: true })
  }
})
