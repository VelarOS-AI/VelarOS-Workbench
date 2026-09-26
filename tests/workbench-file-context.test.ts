import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { type ModelMessage, simulateReadableStream } from 'ai'
import { MockLanguageModelV3 } from 'ai/test'

import { ExecutionEventBus } from '@velaros-ai/agent'
import { createModelRuntimeComposition } from '@velaros-ai/model/node'

import { WorkbenchAgentExecutionStack } from '../src/main/agent/WorkbenchAgentExecutionStack'
import { WorkbenchContextPayloadStore } from '../src/main/agent/WorkbenchContextRecall'
import { ProjectCapabilityProvider } from '../src/main/workspace/ProjectCapabilityProvider'

import { assertCurrentWorkbenchPrompt, type CapturedWorkbenchRequest } from './helpers/workbenchPromptAudit'

function currentFiles(
  value: unknown
): Array<{ path: string; revision: string; excerpts: Array<{ lines: Array<[number, string]>; fileRef: string }> }> {
  if (typeof value === 'string' && value.startsWith('[Current project files]'))
    return JSON.parse(value.slice(value.indexOf('{"files":'))).files
  if (!value || typeof value !== 'object') return []
  return Object.values(value).flatMap(currentFiles)
}

function stackFor(
  provider: ProjectCapabilityProvider,
  model: MockLanguageModelV3,
  store: WorkbenchContextPayloadStore
) {
  const composition = createModelRuntimeComposition()
  const getModel = () => model
  composition.agentModelRuntime.createAgentProvider = () => getModel
  composition.agentModelRuntime.resolveRoleRuntime = async () => ({
    provider: getModel,
    providerId: 'probe',
    model: 'probe',
    providerModel: 'probe',
    contextWindow: 128000,
    supportedInputModalities: ['text'],
    resolutionSource: 'provider-collection',
    resolutionTrace: [],
  })
  return new WorkbenchAgentExecutionStack(
    provider,
    composition,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    store
  )
}

function response(call?: { toolCallId: string; toolName: string; input: string }) {
  return {
    stream: simulateReadableStream({
      initialDelayInMs: null,
      chunkDelayInMs: null,
      chunks: [
        { type: 'stream-start' as const, warnings: [] },
        ...(call
          ? [{ type: 'tool-call' as const, ...call }]
          : [
              { type: 'text-start' as const, id: 'reply' },
              { type: 'text-delta' as const, id: 'reply', delta: '验收完成。' },
              { type: 'text-end' as const, id: 'reply' },
            ]),
        {
          type: 'finish' as const,
          finishReason: {
            unified: call ? ('tool-calls' as const) : ('stop' as const),
            raw: 'stop',
          },
          usage: {
            inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
            outputTokens: { total: 4, text: 4, reasoning: 0 },
          },
        },
      ],
    }),
  }
}

void test('real Workbench stack updates current source, recalls old source, and resumes after disk-store restart', async () => {
  const owned = await mkdtemp(
    join(process.env.VELAROS_FILE_CONTEXT_PROJECT_ROOT ?? tmpdir(), 'file-context-acceptance-')
  )
  const root = process.env.VELAROS_FILE_CONTEXT_PROJECT_ROOT ?? owned
  const path = root === owned ? 'sample.ts' : `${owned.slice(root.length + 1)}/sample.ts`
  const original = 'export const count = 1\n// 中文🙂\\path\n'
  await writeFile(join(root, path), original)
  const storage = await mkdtemp(join(tmpdir(), 'workbench-file-context-store-'))
  const provider = new ProjectCapabilityProvider()
  let oldRevision = ''
  const prompts: unknown[] = []
  const requests: CapturedWorkbenchRequest[] = []
  const emittedCalls: string[] = []
  const model = new MockLanguageModelV3({
    provider: 'probe',
    modelId: 'probe',
    doStream: async (request) => {
      prompts.push(request.prompt)
      requests.push({ prompt: request.prompt, tools: request.tools })
      const turn = prompts.length
      const file = currentFiles(request.prompt).find((file) => file.path === path)
      let name = ''
      let input: unknown
      if (turn === 1) {
        name = 'project__read'
        input = { path }
      } else if (turn === 2) {
        assert.ok(file)
        oldRevision = file.revision
        assert.deepEqual(file.excerpts[0]!.lines[0], [1, 'export const count = 1'])
        name = 'project__edit'
        input = {
          files: [{
            fileRef: file.excerpts[0]!.fileRef,
            edits: [{ op: 'replace', range: 1, text: 'export const count = 2' }],
          }],
        }
      } else if (turn === 3) {
        assert.ok(file)
        assert.notEqual(file.revision, oldRevision)
        assert.deepEqual(file.excerpts[0]!.lines[0], [1, 'export const count = 2'])
        name = 'context__recall'
        input = { path, revision: oldRevision }
      } else if (turn === 4) {
        assert.ok(file)
        assert.deepEqual(file.excerpts[0]!.lines[0], [1, 'export const count = 2'])
        assert.ok(JSON.stringify(request.prompt).includes('historical'))
        name = 'project__edit'
        input = {
          files: [{
            fileRef: file.excerpts[0]!.fileRef,
            edits: [{ op: 'replace', range: 1, text: 'export const count = 3' }],
          }],
        }
      } else {
        assert.equal(turn, 5)
        assert.ok(file)
        assert.deepEqual(file.excerpts[0]!.lines[0], [1, 'export const count = 3'])
        return response()
      }
      emittedCalls.push(name)
      return response({
        toolCallId: `file-call-${turn}`,
        toolName: name,
        input: JSON.stringify(input),
      })
    },
  })
  const store = new WorkbenchContextPayloadStore(() => storage)
  const stack = stackFor(provider, model, store)
  const messages: ModelMessage[] = [{ role: 'user', content: '连续修改 sample.ts，并检查旧版本。' }]
  const run = {
    sessionId: 'file-context-session',
    executionId: 'first',
    projectRoot: root,
    messages,
    config: {
      modelSelection: { provider: 'probe', model: 'probe' },
      permissionConfirmationMode: 'never-ask' as const,
    },
    events: new ExecutionEventBus({}),
    abortSignal: new AbortController().signal,
  }
  try {
    assert.equal((await stack.run(run)).status, 'completed')
    for (const request of requests) assertCurrentWorkbenchPrompt(request)
    assert.deepEqual(emittedCalls, [
      'project__read',
      'project__edit',
      'context__recall',
      'project__edit',
    ])
    assert.equal(
      await readFile(join(root, path), 'utf8'),
      original.replace('count = 1', 'count = 3')
    )
    await stack.dispose()
    let restartTurns = 0
    const restarted = stackFor(
      provider,
      new MockLanguageModelV3({
        provider: 'probe',
        modelId: 'probe',
        doStream: async (request) => {
          restartTurns += 1
          if (restartTurns === 1)
            return response({
              toolCallId: 'restart-recall',
              toolName: 'context__recall',
              input: JSON.stringify({ path, revision: oldRevision }),
            })
          assert.ok(JSON.stringify(request.prompt).includes('export const count = 1'))
          return response()
        },
      }),
      new WorkbenchContextPayloadStore(() => storage)
    )
    try {
      assert.equal(
        (
          await restarted.run({
            ...run,
            executionId: 'second',
            messages: [{ role: 'user', content: '取回文件第一次读取的旧版本。' }],
          })
        ).status,
        'completed'
      )
      assert.equal(restartTurns, 2)
      assert.equal(
        await readFile(join(root, path), 'utf8'),
        original.replace('count = 1', 'count = 3')
      )
    } finally {
      await restarted.dispose()
    }
  } finally {
    await stack.dispose()
    await provider.dispose()
    await rm(owned, { recursive: true, force: true })
    await rm(storage, { recursive: true, force: true })
  }
})


void test('real Workbench retries a large failed edit using only corrected fields', async () => {
  const owned = await mkdtemp(join(process.env.VELAROS_FILE_CONTEXT_PROJECT_ROOT ?? tmpdir(), 'input-reuse-acceptance-'))
  const root = process.env.VELAROS_FILE_CONTEXT_PROJECT_ROOT ?? owned
  const path = root === owned ? 'reuse.ts' : `${owned.slice(root.length + 1)}/reuse.ts`
  const original = 'export const before = 1\n'
  const replacement = `${'// 中文🙂\\path\n'.repeat(3000)  }export const before = 2`
  await writeFile(join(root, path), original)
  const storage = await mkdtemp(join(tmpdir(), 'workbench-input-reuse-store-'))
  const provider = new ProjectCapabilityProvider()
  const store = new WorkbenchContextPayloadStore(() => storage)
  let turn = 0
  let fullChars = 0
  let retryChars = 0
  const requests: CapturedWorkbenchRequest[] = []
  const model = new MockLanguageModelV3({ provider: 'probe', modelId: 'probe', doStream: async (request) => {
    requests.push({ prompt: request.prompt, tools: request.tools })
    turn++
    if (turn === 1) return response({ toolCallId: 'read-reuse', toolName: 'project__read', input: JSON.stringify({ path }) })
    if (turn === 2) {
      const file = currentFiles(request.prompt).find((file) => file.path === path)
      assert.ok(file?.excerpts[0]?.fileRef)
      const args = { files: [{ fileRef: file.excerpts[0].fileRef, edits: [{ op: 'replace', range: 1, match: 'export const WRONG = 1', text: replacement }] }] }
      fullChars = JSON.stringify(args).length
      return response({ toolCallId: 'large-failed', toolName: 'project__edit', input: JSON.stringify(args) })
    }
    if (turn === 3) {
      assert.equal(await readFile(join(root, path), 'utf8'), original, 'failed prepare must leave disk unchanged')
      assert.ok(JSON.stringify(request.prompt).includes('attempt:large-failed'), 'failure must contain the reusable input handle')
      const args = { reuse: 'attempt:large-failed', changes: [{ op: 'set', path: ['files', 0, 'edits', 0, 'match'], value: 'export const before = 1' }] }
      retryChars = JSON.stringify(args).length
      return response({ toolCallId: 'large-repaired', toolName: 'project__edit', input: JSON.stringify(args) })
    }
    assert.equal(turn, 4)
    assert.ok(!JSON.stringify(request.prompt).includes('project-edit-recovery'), 'spent recovery candidates must leave active context')
    return response()
  } })
  const stack = stackFor(provider, model, store)
  try {
    const result = await stack.run({ sessionId: 'input-reuse-session', executionId: 'input-reuse', projectRoot: root,
      messages: [{ role: 'user', content: '更新这个文件，保留完整 Unicode 正文；若定位失败，只修正定位字段继续。' }],
      config: { modelSelection: { provider: 'probe', model: 'probe' }, permissionConfirmationMode: 'never-ask' as const },
      events: new ExecutionEventBus({}), abortSignal: new AbortController().signal })
    assert.equal(result.status, 'completed')
    for (const request of requests) assertCurrentWorkbenchPrompt(request)
    assert.equal(await readFile(join(root, path), 'utf8'), `${replacement  }\n`)
    assert.ok(retryChars / fullChars < 0.01)
    const records = await store.listForSession('input-reuse-session')
    if (process.env.VELAROS_INPUT_EFFICIENCY_REPORT) await writeFile(process.env.VELAROS_INPUT_EFFICIENCY_REPORT, JSON.stringify(records.filter(record => record.toolName === '__tool_attempt_outcome__')))
    const receipts = records.filter((record) => record.toolName === '__tool_attempt_outcome__' && ['attempt:large-failed', 'attempt:large-repaired'].includes(record.toolCallId)).map((record) => JSON.parse(record.serializedResult))
    assert.equal(receipts.length, 2)
    assert.equal(receipts.filter((record) => record.outcome === 'completed').length, 1)
    assert.ok(receipts.some((record) => record.metrics?.reused && record.metrics.requestedChars === retryChars))
  } finally {
    await stack.dispose()
    await provider.dispose()
    await rm(storage, { recursive: true, force: true })
    await rm(owned, { recursive: true, force: true })
  }
})
