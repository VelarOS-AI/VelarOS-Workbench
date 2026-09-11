import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { type ModelMessage, simulateReadableStream } from 'ai'
import { MockLanguageModelV3 } from 'ai/test'
import { describe, test } from 'bun:test'
import { z } from 'zod'

import { ExecutionEventBus } from '@velaros-ai/agent'
import { createModelRuntimeComposition } from '@velaros-ai/model/node'
import type { ProjectKernel } from '@velaros-ai/project/runtime'

import { WorkbenchAgentExecutionStack } from '../src/main/agent/WorkbenchAgentExecutionStack'
import type { WorkbenchAgentToolDefinition } from '../src/main/agent/WorkbenchAgentToolRegistry'
import { WorkbenchContextPayloadStore } from '../src/main/agent/WorkbenchContextRecall'
import { WorkbenchSubAgentDescriptors } from '../src/main/agent/WorkbenchSubAgentPolicy'
import type { WorkbenchProjectCapabilityProvider } from '../src/main/workspace/ProjectCapabilityProvider'

function payloadRecord(sessionId: string, hash: string, toolCallId: string, serializedResult: string) {
  return {
    sessionId,
    hash,
    payloadRef: `ctx-payload:${sessionId}:${hash}`,
    toolCallId,
    toolName: 'project:read',
    serializedResult,
    chars: serializedResult.length,
    createdAt: 1,
  }
}

void describe('Workbench context payload store', () => {
  void test('serves paged-out tool output by handle or tool call id, whichever session paged it out', async () => {
    const store = new WorkbenchContextPayloadStore()
    await store.put(payloadRecord('parent', 'h1', 'call-1', 'first payload'))
    await store.put(payloadRecord('parent:sub', 'h2', 'call-2', 'second payload'))

    assert.equal((await store.findByHash('parent', 'h1'))?.toolCallId, 'call-1')
    assert.equal(await store.findByHash('parent', 'h2'), null)
    assert.deepEqual(
      (await store.listForSession('parent')).map((record) => record.hash),
      ['h1']
    )
    // 子 Agent 页出时记的是它自己的会话键；按句柄、按调用 id 召回都不看会话。
    assert.equal(
      (await store.loadToolPayload('parent', 'ctx-payload:parent:sub:h2'))?.serializedResult,
      'second payload'
    )
    assert.equal((await store.loadToolPayload('parent', 'tool:call-2'))?.serializedResult, 'second payload')
    assert.equal((await store.loadToolPayload('parent', 'call-1'))?.serializedResult, 'first payload')
    assert.equal(await store.loadToolPayload('parent', 'tool:missing'), null)

    const snapshot = await store.loadSessionPayloads('parent')
    assert.deepEqual(Object.keys(snapshot.toolResults), ['ctx-payload:parent:h1'])
  })

  void test('keeps memory bounded by dropping the oldest payloads', async () => {
    const store = new WorkbenchContextPayloadStore()
    for (let index = 0; index < 401; index += 1)
      await store.put(payloadRecord('s', `h${index}`, `call-${index}`, 'x'))
    assert.equal(await store.findByHash('s', 'h0'), null)
    assert.equal((await store.findByHash('s', 'h400'))?.toolCallId, 'call-400')
    assert.equal((await store.listForSession('s')).length, 400)
  })
})

void describe('Workbench context recall in a real run', () => {
  void test('every sub-agent type can recall paged-out output', () => {
    for (const descriptor of WorkbenchSubAgentDescriptors)
      assert.ok(descriptor.toolCategories.includes('context'), descriptor.id)
  })

  void test('a large tool result is paged out and the model reads the rest back with context:recall', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wb-recall-'))
    // 60K 字的输出：远超页出阈值。摘要是头尾各一截，正中间的标记只在原文里。
    const bigOutput = `${'a'.repeat(30_000)}MIDDLE-MARKER-7f3${'b'.repeat(30_000)}`
    const dumpTool: WorkbenchAgentToolDefinition = {
      name: 'project:dump',
      categoryId: 'project-files',
      role: 'inspect',
      description: 'Return a large block of text.',
      permissions: [],
      capabilities: { effectKind: 'read', readScopes: ['project'], concurrency: 'safe' },
      providerId: 'velaros.test',
      schema: z.object({}) as WorkbenchAgentToolDefinition['schema'],
      isConcurrencySafe: () => true,
      execute: async () => bigOutput,
    }
    const projectProvider: WorkbenchProjectCapabilityProvider = {
      invoke: () => Promise.resolve(null),
      resolveProject: async (projectRoot) => ({
        kernel: { root: projectRoot } as ProjectKernel,
        tools: [dumpTool],
        categoryDefinitions: {
          'project-files': { id: 'project-files', label: 'Project files', description: 'Read project files.' },
        },
        enabledCategoryIds: ['project-files'],
        residentCategoryIds: ['project-files'],
        initialVisibleToolNames: ['project:dump'],
      }),
      dispose: () => Promise.resolve(),
    }

    const prompts: string[] = []
    const toolNamesPerRequest: string[][] = []
    const model = new MockLanguageModelV3({
      provider: 'probe',
      modelId: 'probe',
      doStream: async (request) => {
        toolNamesPerRequest.push(request.tools?.map((tool) => tool.name) ?? [])
        const prompt = JSON.stringify(request.prompt)
        prompts.push(prompt)
        const turn = prompts.length
        const ref = /ctx-payload:[^"\\]+/u.exec(prompt)?.[0] ?? 'missing'
        const toolCall =
          turn === 1
            ? { toolCallId: 'dump-1', toolName: 'project__dump', input: '{}' }
            : turn === 2
              ? {
                  toolCallId: 'recall-1',
                  toolName: 'context__recall',
                  input: JSON.stringify({ ref, offset: 29_000, maxChars: 4_000, reason: 'read the middle' }),
                }
              : null
        return {
          stream: simulateReadableStream({
            initialDelayInMs: null,
            chunkDelayInMs: null,
            chunks: [
              { type: 'stream-start', warnings: [] },
              ...(toolCall
                ? [{ type: 'tool-call' as const, ...toolCall }]
                : [
                    { type: 'text-start' as const, id: 'reply' },
                    { type: 'text-delta' as const, id: 'reply', delta: '看完了。' },
                    { type: 'text-end' as const, id: 'reply' },
                  ]),
              {
                type: 'finish',
                finishReason: { unified: toolCall ? 'tool-calls' : 'stop', raw: 'stop' },
                usage: {
                  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
                  outputTokens: { total: 4, text: 4, reasoning: 0 },
                },
              },
            ],
          }),
        }
      },
    })
    const provider = () => model
    const stack = new WorkbenchAgentExecutionStack(projectProvider, {
      ...createModelRuntimeComposition(),
      agentModelRuntime: {
        createAgentProvider: () => provider,
        resolveRoleRuntime: async () => ({
          provider,
          providerId: 'probe',
          model: 'probe',
          providerModel: 'probe',
          contextWindow: 128_000,
          supportedInputModalities: ['text'],
          resolutionSource: 'probe',
          resolutionTrace: [],
        }),
      },
    })
    const messages: ModelMessage[] = [{ role: 'user', content: '把那段大输出读完' }]
    try {
      const result = await stack.run({
        sessionId: 'recall-session',
        executionId: 'recall-run',
        projectRoot: root,
        messages,
        config: { modelSelection: { provider: 'probe', model: 'probe' } },
        events: new ExecutionEventBus({}),
        abortSignal: new AbortController().signal,
      })
      assert.equal(result.status, 'completed')
      assert.equal(prompts.length, 3)
      // 召回常驻：第一轮起就在工具面上，出核地板不再因为句柄拦请求。
      assert.ok(toolNamesPerRequest.every((names) => names.includes('context__recall')))
      // 第二轮看到的是摘要 + 句柄，而不是整段原文。
      assert.match(prompts[1] ?? '', /ctx-payload:/u)
      assert.doesNotMatch(prompts[1] ?? '', /MIDDLE-MARKER-7f3/u)
      // 第三轮拿到了召回回来的中间那段。
      assert.match(prompts[2] ?? '', /MIDDLE-MARKER-7f3/u)
    } finally {
      await stack.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })
})
