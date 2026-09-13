import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'node:test'

import { type ModelMessage, simulateReadableStream } from 'ai'
import { MockLanguageModelV3 } from 'ai/test'
import { z } from 'zod'

import { ExecutionEventBus } from '@velaros-ai/agent'
import { optionalWhen } from '@velaros-ai/core'
import { createModelRuntimeComposition } from '@velaros-ai/model/node'
import type { ProjectKernel } from '@velaros-ai/project/runtime'

import { WorkbenchAgentExecutionStack } from '../src/main/agent/WorkbenchAgentExecutionStack'
import type { WorkbenchAgentToolDefinition } from '../src/main/agent/WorkbenchAgentToolRegistry'
import { WorkbenchContextPayloadStore } from '../src/main/agent/WorkbenchContextRecall'
import { WorkbenchSubAgentDescriptors } from '../src/main/agent/WorkbenchSubAgentPolicy'
import type { WorkbenchProjectCapabilityProvider } from '../src/main/workspace/ProjectCapabilityProvider'

function payloadRecord(
  sessionId: string,
  hash: string,
  toolCallId: string,
  serializedResult: string,
) {
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

function projectProviderWith(
  tool: WorkbenchAgentToolDefinition,
): WorkbenchProjectCapabilityProvider {
  return {
    invoke: () => Promise.resolve(null),
    resolveProject: async (projectRoot) => ({
      kernel: { root: projectRoot } as ProjectKernel,
      tools: [tool],
      categoryDefinitions: {
        'project-files': {
          id: 'project-files',
          label: 'Project files',
          description: 'Read project files.',
          toolOs: { domain: 'project', defaultState: 'resident' },
        },
      },
      enabledCategoryIds: ['project-files'],
      residentCategoryIds: ['project-files'],
      initialVisibleToolNames: [tool.name],
    }),
    dispose: () => Promise.resolve(),
  }
}

function executionStackWith(
  projectProvider: WorkbenchProjectCapabilityProvider,
  model: MockLanguageModelV3,
  payloadStore?: WorkbenchContextPayloadStore,
): WorkbenchAgentExecutionStack {
  const provider = () => model
  const composition = createModelRuntimeComposition()
  const { agentModelRuntime } = composition
  agentModelRuntime.createAgentProvider = () => provider
  agentModelRuntime.resolveRoleRuntime = async () => ({
    provider,
    providerId: 'probe',
    model: 'probe',
    providerModel: 'probe',
    contextWindow: 128_000,
    supportedInputModalities: ['text'],
    resolutionSource: 'provider-collection',
    resolutionTrace: [],
  })
  return new WorkbenchAgentExecutionStack(
    projectProvider,
    composition,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    payloadStore,
  )
}

function findProperty(root: unknown, key: string): unknown {
  if (typeof root === 'string') {
    try {
      return findProperty(JSON.parse(root) as unknown, key)
    } catch {
      return undefined
    }
  }
  if (!root || typeof root !== 'object') return undefined
  if (!Array.isArray(root) && Object.prototype.hasOwnProperty.call(root, key))
    return (root as Record<string, unknown>)[key]
  for (const value of Array.isArray(root) ? root : Object.values(root)) {
    const found = findProperty(value, key)
    if (found !== undefined) return found
  }
  return undefined
}

function findToolResultOutput(root: unknown, toolCallId: string): unknown {
  if (!root || typeof root !== 'object') return undefined
  if (!Array.isArray(root)) {
    const record = root as Record<string, unknown>
    if (record.type === 'tool-result' && record.toolCallId === toolCallId) return record.output
  }
  for (const value of Array.isArray(root) ? root : Object.values(root)) {
    const found = findToolResultOutput(value, toolCallId)
    if (found !== undefined) return found
  }
  return undefined
}

function requireStringProperty(root: unknown, key: string): string {
  const value = findProperty(root, key)
  if (typeof value !== 'string') throw new TypeError(`Expected ${key} to be a string.`)
  return value
}

function collectStrings(root: unknown): string {
  if (typeof root === 'string') {
    try {
      return collectStrings(JSON.parse(root) as unknown)
    } catch {
      return root
    }
  }
  if (!root || typeof root !== 'object') return ''
  return (Array.isArray(root) ? root : Object.values(root)).map(collectStrings).join('\n')
}

function recallPageBody(content: string): string {
  const marker = 'serializedResultAtPath:\n'
  const markerIndex = content.indexOf(marker)
  if (markerIndex < 0) throw new Error(`Recall content is missing ${marker.trimEnd()}.`)
  return content.slice(markerIndex + marker.length)
}

void describe('Workbench context payload store', () => {
  void test('keeps call-id lookup session-scoped while honoring explicit cross-session payload references', async () => {
    const store = new WorkbenchContextPayloadStore()
    await store.put(payloadRecord('parent', 'h1', 'call-1', 'first payload'))
    await store.put(payloadRecord('parent:sub', 'h2', 'call-2', 'second payload'))

    assert.equal((await store.findByHash('parent', 'h1'))?.toolCallId, 'call-1')
    assert.equal(await store.findByHash('parent', 'h2'), null)
    assert.deepEqual(
      (await store.listForSession('parent')).map((record) => record.hash),
      ['h1'],
    )
    // 完整句柄携带来源；裸调用 id 不足以定位另一个会话的原文。
    assert.equal(
      (await store.loadToolPayload('parent', 'ctx-payload:parent:sub:h2'))?.serializedResult,
      'second payload',
    )
    assert.equal(await store.loadToolPayload('parent', 'tool:call-2'), null)
    assert.equal(
      (await store.loadToolPayload('parent:sub', 'tool:call-2'))?.serializedResult,
      'second payload',
    )
    assert.equal(
      (await store.loadToolPayload('parent', 'call-1'))?.serializedResult,
      'first payload',
    )
    assert.equal(await store.loadToolPayload('parent', 'tool:missing'), null)

    const snapshot = await store.loadSessionPayloads('parent')
    assert.deepEqual(Object.keys(snapshot.toolResults), ['ctx-payload:parent:h1'])
  })

  void test('deleted sessions cannot recall another session through a repeated call id', async () => {
    const store = new WorkbenchContextPayloadStore()
    await store.put(payloadRecord('first', 'h1', 'input:same', 'first original'))
    await store.put(payloadRecord('second', 'h2', 'input:same', 'second original'))
    await store.deleteSession('first')
    assert.equal(await store.loadToolPayload('first', 'input:same'), null)
    assert.equal(await store.loadToolPayload('unrelated', 'tool:input:same'), null)
    assert.equal(
      (await store.loadToolPayload('second', 'input:same'))?.serializedResult,
      'second original',
    )
    assert.equal(
      (await store.loadToolPayload('first', 'ctx-payload:second:h2'))?.serializedResult,
      'second original',
    )
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

  for (const source of ['output', 'input'] as const)
    void test(`a large tool ${source} is recoverable through the real execution stack`, async () => {
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
        schema: z.object({
          content: z.string().optional(),
        }) as WorkbenchAgentToolDefinition['schema'],
        isConcurrencySafe: () => true,
        execute: async () => (source === 'input' ? { ok: true } : bigOutput),
      }
      const projectProvider = projectProviderWith(dumpTool)

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
          const ref =
            source === 'input'
              ? 'input:dump-1'
              : (/ctx-payload:[^"\\]+/u.exec(prompt)?.[0] ?? 'missing')
          const toolCall =
            turn === 1
              ? {
                  toolCallId: 'dump-1',
                  toolName: 'project__dump',
                  input: JSON.stringify(source === 'input' ? { content: bigOutput } : {}),
                }
              : turn === 2
                ? {
                    toolCallId: 'recall-1',
                    toolName: 'context__recall',
                    input: JSON.stringify({
                      ref,
                      jsonPath: optionalWhen(source === 'input', '$.content'),
                      offset: 29_000,
                      maxChars: 4_000,
                      reason: 'read the middle',
                    }),
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
      const payloadStore = new WorkbenchContextPayloadStore(() => join(root, 'payloads'))
      const stack = executionStackWith(projectProvider, model, payloadStore)
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
        if (source === 'output') {
          const originalRecords = (await payloadStore.listForSession('recall-session')).filter(
            (record) => record.toolCallId === 'dump-1',
          )
          assert.equal(
            originalRecords.length,
            1,
            'provider replanning must not archive a reference wrapper',
          )
          assert.equal(
            (await payloadStore.loadToolPayload('recall-session', 'dump-1'))?.serializedResult,
            bigOutput,
          )
        }
        // 召回常驻：第一轮起就在工具面上，出核地板不再因为句柄拦请求。
        assert.ok(toolNamesPerRequest.every((names) => names.includes('context__recall')))
        // 第二轮看到的是摘要 + 句柄，而不是整段原文。
        assert.match(prompts[1] ?? '', source === 'input' ? /input:dump-1/u : /ctx-payload:/u)
        assert.doesNotMatch(prompts[1] ?? '', /MIDDLE-MARKER-7f3/u)
        // 第三轮拿到了召回回来的中间那段。
        assert.match(prompts[2] ?? '', /MIDDLE-MARKER-7f3/u)
      } finally {
        await stack.dispose()
        await rm(root, { recursive: true, force: true })
      }
    })

  void test('recalls paged original input after the tool fails without confusing it with the error result', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wb-recall-failure-'))
    const prefix = '前页😀\\路径\\段落\r\n'.repeat(1_800)
    const middleMarker = 'MIDDLE-失败输入-中文😀-C:\\资料\\片段'
    const tailMarker = 'TAIL-原始输入尾部-🚀-D:\\收尾\\文件'
    const longInput = `${prefix}${middleMarker}\r\n${'后页\\续读\r\n'.repeat(800)}${tailMarker}\r\nEND`
    const failureMessage = 'SYNTHETIC-FAILURE-RESULT-ONLY'
    const firstOffset = prefix.length - 120
    let receivedInput: unknown
    const failingTool: WorkbenchAgentToolDefinition = {
      name: 'project:fail',
      categoryId: 'project-files',
      role: 'inspect',
      description: 'Receive a large input and fail.',
      permissions: [],
      capabilities: { effectKind: 'read', readScopes: ['project'], concurrency: 'safe' },
      providerId: 'velaros.test',
      schema: z.object({ content: z.string() }) as WorkbenchAgentToolDefinition['schema'],
      isConcurrencySafe: () => true,
      execute: async (input) => {
        receivedInput = input
        throw new Error(failureMessage)
      },
    }
    const projectProvider = projectProviderWith(failingTool)

    const prompts: unknown[] = []
    let historyInputRef: unknown
    let nextOffset: unknown
    const model = new MockLanguageModelV3({
      provider: 'probe',
      modelId: 'probe',
      doStream: async (request) => {
        prompts.push(request.prompt)
        const turn = prompts.length
        let toolCall: { toolCallId: string; toolName: string; input: string } | null = null
        if (turn === 1) {
          toolCall = {
            toolCallId: 'fail-1',
            toolName: 'project__fail',
            input: JSON.stringify({ content: longInput }),
          }
        } else if (turn === 2) {
          historyInputRef = findProperty(request.prompt, '__historyInputRef')
          toolCall = {
            toolCallId: 'recall-middle',
            toolName: 'context__recall',
            input: JSON.stringify({
              ref: historyInputRef,
              jsonPath: '$.content',
              offset: firstOffset,
              maxChars: 2_000,
              reason: 'recover the middle of the failed call input',
            }),
          }
        } else if (turn === 3) {
          const firstPage = findToolResultOutput(request.prompt, 'recall-middle')
          nextOffset = findProperty(firstPage, 'nextOffset')
          toolCall = {
            toolCallId: 'recall-tail',
            toolName: 'context__recall',
            input: JSON.stringify({
              ref: historyInputRef,
              jsonPath: '$.content',
              offset: nextOffset,
              maxChars: 30_000,
              reason: 'continue from the returned offset through the tail',
            }),
          }
        }
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
                    { type: 'text-delta' as const, id: 'reply', delta: '输入已完整找回。' },
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
    const stack = executionStackWith(projectProvider, model)
    try {
      const result = await stack.run({
        sessionId: 'recall-failure-session',
        executionId: 'recall-failure-run',
        projectRoot: root,
        messages: [{ role: 'user', content: '失败后找回工具收到的原始长参数' }],
        config: { modelSelection: { provider: 'probe', model: 'probe' } },
        events: new ExecutionEventBus({}),
        abortSignal: new AbortController().signal,
      })

      assert.equal(result.status, 'completed')
      assert.equal(prompts.length, 4)
      assert.deepEqual(receivedInput, { content: longInput })
      assert.equal(historyInputRef, 'input:fail-1')
      assert.equal(typeof nextOffset, 'number')

      const failedResult = collectStrings(findToolResultOutput(prompts[1], 'fail-1'))
      assert.match(failedResult, new RegExp(failureMessage, 'u'))
      assert.doesNotMatch(failedResult, /MIDDLE-失败输入/u)
      assert.doesNotMatch(failedResult, /TAIL-原始输入尾部/u)

      const middleResult = findToolResultOutput(prompts[2], 'recall-middle')
      const middlePage = requireStringProperty(middleResult, 'content')
      const middleBody = recallPageBody(middlePage)
      assert.match(middleBody, /MIDDLE-失败输入-中文😀-C:\\资料\\片段/u)
      assert.match(middleBody, /\r\n/u)
      assert.doesNotMatch(middleBody, new RegExp(failureMessage, 'u'))
      assert.doesNotMatch(middleBody, /TAIL-原始输入尾部/u)

      const tailResult = findToolResultOutput(prompts[3], 'recall-tail')
      const tailPage = requireStringProperty(tailResult, 'content')
      const tailBody = recallPageBody(tailPage)
      assert.match(tailBody, /TAIL-原始输入尾部-🚀-D:\\收尾\\文件/u)
      assert.match(tailBody, /\r\nEND/u)
      assert.doesNotMatch(tailBody, new RegExp(failureMessage, 'u'))
      assert.equal(middleBody + tailBody, longInput.slice(firstOffset))
      assert.equal(findProperty(tailResult, 'nextOffset'), null)
    } finally {
      await stack.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })
})

void test('persistent execution stack recalls failed input after dispose and deletes only the released session', async () => {
  const root = await mkdtemp(join(tmpdir(), 'workbench-persistent-execution-'))
  const openStore = () => new WorkbenchContextPayloadStore(() => join(root, 'payloads'))
  const content = `${'中文😀\\目录\r\n'.repeat(900)}原始尾部🚀`
  let receivedInput: unknown
  const tool: WorkbenchAgentToolDefinition = {
    name: 'project:fail',
    categoryId: 'project-files',
    role: 'inspect',
    description: 'Receive original input before failing.',
    permissions: [],
    capabilities: { effectKind: 'read', readScopes: ['project'], concurrency: 'safe' },
    providerId: 'velaros.test',
    schema: z.object({ content: z.string() }) as WorkbenchAgentToolDefinition['schema'],
    isConcurrencySafe: () => true,
    execute: async (input) => {
      receivedInput = input
      throw new Error('EXPECTED-TOOL-FAILURE')
    },
  }
  const prompts: unknown[] = []
  const modelFor = (toolName: string, toolCallId: string, input: unknown) => {
    let turn = 0
    return new MockLanguageModelV3({
      provider: 'probe',
      modelId: 'probe',
      doStream: async (request) => {
        prompts.push(request.prompt)
        const call = turn++ === 0
        return {
          stream: simulateReadableStream({
            initialDelayInMs: null,
            chunkDelayInMs: null,
            chunks: [
              { type: 'stream-start', warnings: [] },
              ...(call
                ? [
                    {
                      type: 'tool-call' as const,
                      toolName,
                      toolCallId,
                      input: JSON.stringify(input),
                    },
                  ]
                : [
                    { type: 'text-start' as const, id: 'reply' },
                    { type: 'text-delta' as const, id: 'reply', delta: 'done' },
                    { type: 'text-end' as const, id: 'reply' },
                  ]),
              {
                type: 'finish',
                finishReason: { unified: call ? 'tool-calls' : 'stop', raw: 'stop' },
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
  }
  const run = (stack: WorkbenchAgentExecutionStack, executionId: string) =>
    stack.run({
      sessionId: 'persistent-session',
      executionId,
      projectRoot: root,
      messages: [{ role: 'user', content: '执行当前验收步骤' }],
      config: { modelSelection: { provider: 'probe', model: 'probe' } },
      events: new ExecutionEventBus({}),
      abortSignal: new AbortController().signal,
    })
  const writer = executionStackWith(
    projectProviderWith(tool),
    modelFor('project__fail', 'durable-failure', { content }),
    openStore(),
  )
  const reader = executionStackWith(
    projectProviderWith(tool),
    modelFor('context__recall', 'durable-recall', {
      ref: 'input:durable-failure',
      jsonPath: '$.content',
      maxChars: 30000,
    }),
    openStore(),
  )
  try {
    assert.equal((await run(writer, 'write-run')).status, 'completed')
    assert.deepEqual(receivedInput, { content })
    assert.match(
      collectStrings(findToolResultOutput(prompts[1], 'durable-failure')),
      /EXPECTED-TOOL-FAILURE/u,
    )
    assert.equal(findProperty(prompts[1], '__historyInputRef'), 'input:durable-failure')
    await writer.dispose()
    const persisted = await openStore().loadToolPayload(
      'persistent-session',
      'input:durable-failure',
    )
    assert.equal(persisted?.serializedResult, JSON.stringify({ content }))
    await openStore().put(payloadRecord('preserved-session', 'preserved', 'preserved-call', 'kept'))
    assert.equal((await run(reader, 'read-run')).status, 'completed')
    const recalled = findToolResultOutput(prompts[3], 'durable-recall')
    assert.equal(findProperty(recalled, 'found'), true)
    assert.equal(recallPageBody(requireStringProperty(recalled, 'content')), content)
    await reader.releaseSession('persistent-session')
    assert.deepEqual(await openStore().listForSession('persistent-session'), [])
    assert.equal(
      await openStore().loadToolPayload('persistent-session', 'input:durable-failure'),
      null,
    )
    assert.equal(
      (await openStore().findByHash('preserved-session', 'preserved'))?.serializedResult,
      'kept',
    )
  } finally {
    await writer.dispose()
    await reader.dispose()
    await rm(root, { recursive: true, force: true })
  }
})
