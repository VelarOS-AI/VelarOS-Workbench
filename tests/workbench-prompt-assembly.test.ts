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
import { WorkbenchSubAgentTypeProvider } from '../src/main/agent/WorkbenchSubAgentPolicy'
import { ProjectCapabilityProvider } from '../src/main/workspace/ProjectCapabilityProvider'
import { WorkbenchClaudeAgentRuntime } from '../src/plugins/agent-engines/main/WorkbenchClaudeAgentRuntime'
import { WorkbenchCodexAgentRuntime } from '../src/plugins/agent-engines/main/WorkbenchCodexAgentRuntime'

import { assertCurrentWorkbenchPrompt, type CapturedWorkbenchRequest } from './helpers/workbenchPromptAudit'

function assertDispatchCatalog(request: CapturedWorkbenchRequest, readonly = false): void {
  const system = request.prompt.filter((message) => message.role === 'system').map((message) => message.content).join('\n')
  const dispatch = request.tools?.some((tool) => ['agent__dispatch', 'agent__run_workflow'].includes(tool.name))
  if (readonly) {
    assert(!dispatch, 'Readonly workers cannot delegate further')
    assert.doesNotMatch(system, /本轮可用 subagent_type/u)
    return
  }
  assert(dispatch, 'Primary requests expose a dispatch capability')
  const provider = new WorkbenchSubAgentTypeProvider()
  const ids = [...system.matchAll(/^"([^"]+)"：(默认只读|按授权工具执行)/gmu)].map((match) => match[1])
  assert.deepEqual(ids, provider.listDescriptors().map((descriptor) => descriptor.id))
  assert.deepEqual(ids, ['explore', 'edit', 'verify', 'general'])
  assert(system.includes(`新建省略时使用 ${JSON.stringify(provider.defaultTypeId)}`))
  for (const descriptor of provider.listDescriptors()) {
    assert(system.includes(`${JSON.stringify(descriptor.id)}：${descriptor.readonlyDefault ? '默认只读' : '按授权工具执行'}`))
    if (descriptor.description) assert(system.includes(descriptor.description))
  }
}

function response(call?: { toolName: string; toolCallId: string; input: string }) {
  return { stream: simulateReadableStream({ initialDelayInMs: null, chunkDelayInMs: null, chunks: [
    { type: 'stream-start' as const, warnings: [] },
    ...(call ? [{ type: 'tool-call' as const, ...call }] : [
      { type: 'text-start' as const, id: 'answer' },
      { type: 'text-delta' as const, id: 'answer', delta: 'The supplied verification is complete.' },
      { type: 'text-end' as const, id: 'answer' },
    ]),
    { type: 'finish' as const, finishReason: { unified: call ? 'tool-calls' as const : 'stop' as const, raw: 'stop' }, usage: {
      inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 5, text: 5, reasoning: 0 },
    } },
  ] }) }
}

test('default, plan, goal and combined modes expose current instructions and UI tool examples', async () => {
  const root = await mkdtemp(join(tmpdir(), 'workbench-prompt-modes-'))
  const captures: CapturedWorkbenchRequest[] = []
  try {
    for (const runProfile of ['compact', 'balanced', 'expanded'] as const)
      for (const executionModes of [[], ['plan'], ['goal'], ['plan', 'goal']] as const) {
      const controller = new AbortController()
      const provider = new ProjectCapabilityProvider()
      let modelRequests = 0
      const model = new MockLanguageModelV3({ provider: 'probe', modelId: 'probe', doStream: async (request) => {
        captures.push({ prompt: request.prompt, tools: request.tools })
        if (++modelRequests === 1) return response({ toolName: 'tooling__map', toolCallId: 'phase-transition', input: JSON.stringify({ op: 'map', categoryIds: ['agent-control'], maxToolsPerCategory: 1 }) })
        controller.abort()
        return response()
      } })
      const composition = createModelRuntimeComposition()
      composition.agentModelRuntime.createAgentProvider = () => () => model
      composition.agentModelRuntime.resolveRoleRuntime = async () => ({ provider: () => model, providerId: 'probe', model: 'probe', providerModel: 'probe', contextWindow: 128000, supportedInputModalities: ['text'], resolutionSource: 'provider-collection', resolutionTrace: [] })
      const stack = new WorkbenchAgentExecutionStack(provider, composition)
      try {
        await stack.run({ sessionId: `mode-${executionModes.join('-')}`, executionId: 'mode-audit', projectRoot: root,
          messages: [{ role: 'user', content: 'Inspect the current project.' }],
          config: { runProfile, executionModes: [...executionModes], modelSelection: { provider: 'probe', model: 'probe' }, permissionConfirmationMode: 'never-ask' },
          events: new ExecutionEventBus({}), abortSignal: controller.signal,
        })
      } finally {
        await stack.dispose()
      }
    }
    assert.equal(captures.length, 24)
    for (const request of captures) {
      assertCurrentWorkbenchPrompt(request)
      assertDispatchCatalog(request)
      assert(request.tools?.some((tool) => tool.name.startsWith('workbench__')), 'Attached UI examples must be checked')
      assert(request.tools?.some((tool) => tool.name === 'project__edit'))
      assert.match(JSON.stringify(request.prompt), /Host command environment:/)
    }
  } finally {
    if (process.env.VELAROS_PROMPT_AUDIT_OUTPUT)
      await writeFile(join(process.env.VELAROS_PROMPT_AUDIT_OUTPUT, 'workbench-mode-provider-requests.json'), JSON.stringify(captures, null, 2))
    await rm(root, { recursive: true, force: true })
  }
})

for (const worker of [{ type: 'verify', role: 'verifier' }, { type: 'explore', role: 'operator' }]) test(`Workbench provider requests carry current discovery copy and a consistent ${worker.type} role`, async () => {
  const root = await mkdtemp(join(tmpdir(), 'workbench-prompt-assembly-'))
  const provider = new ProjectCapabilityProvider()
  const requests: CapturedWorkbenchRequest[] = []
  const model = new MockLanguageModelV3({ provider: 'probe', modelId: 'probe', doStream: async (request) => {
    requests.push({ prompt: request.prompt, tools: request.tools })
    if (requests.length === 1) return response({ toolName: 'tooling__map', toolCallId: 'map-copy', input: JSON.stringify({ op: 'map', categoryIds: ['agent-control', 'context'], maxToolsPerCategory: 1 }) })
    if (requests.length === 2) return response({ toolName: 'agent__dispatch', toolCallId: 'dispatch-verifier', input: JSON.stringify({
        agent_name: 'Observer', subagent_type: worker.type, prompt: 'Verify the supplied statement without changing files: one equals one.',
      }) })
    return response()
  } })
  const composition = createModelRuntimeComposition()
  composition.agentModelRuntime.createAgentProvider = () => () => model
  composition.agentModelRuntime.resolveRoleRuntime = async () => ({ provider: () => model, providerId: 'probe', model: 'probe', providerModel: 'probe', contextWindow: 128000, supportedInputModalities: ['text'], resolutionSource: 'provider-collection', resolutionTrace: [] })
  const stack = new WorkbenchAgentExecutionStack(provider, composition)
  try {
    const result = await stack.run({ sessionId: 'prompt-audit', executionId: 'prompt-audit-run', projectRoot: root,
      messages: [{ role: 'user', content: 'Review available tools, then delegate a read-only check.' }],
      config: { modelSelection: { provider: 'probe', model: 'probe' }, permissionConfirmationMode: 'never-ask' },
      rendererAttached: false, events: new ExecutionEventBus({}), abortSignal: new AbortController().signal,
    })
    assert.equal(result.status, 'completed')
    assert.equal(requests.length, 4)
    // Assert after capture: model callback errors are converted into Agent tool receipts.
    for (const [index, request] of requests.entries()) {
      assertCurrentWorkbenchPrompt(request, index === 2)
      assertDispatchCatalog(request, index === 2)
    }
    assert.match(JSON.stringify(requests[0]!.prompt), /Host command environment:/)
    assert(requests[0]!.tools?.some((tool) => tool.name === 'project__file'))
    assert.match(JSON.stringify(requests[1]!.prompt), /发现并装载当前可用工具/)
    assert.match(JSON.stringify(requests[1]!.prompt), /失败调用参数与文件历史版本/)
    const childPrompt = JSON.stringify(requests[2]!.prompt)
    assert(childPrompt.includes(`目标角色：${worker.role}`))
    assert.match(childPrompt, /模式：只读/)
    assert.doesNotMatch(childPrompt, /在授权范围内改动项目文件并运行验证命令/)
    assert(!requests[2]!.tools?.some((tool) => ['project__file', 'project__edit', 'project__change'].includes(tool.name)))
    const wrongType = structuredClone(requests[0]!)
    for (const message of wrongType.prompt) {
      if (message.role === 'system' && typeof message.content === 'string') message.content = message.content.replace('"verify"：', '"verifier"：')
    }
    assert.throws(() => assertDispatchCatalog(wrongType), 'Worker roles cannot replace provider type ids')
    const missingCatalog = structuredClone(requests[0]!)
    for (const message of missingCatalog.prompt) {
      if (message.role === 'system' && typeof message.content === 'string') message.content = message.content.replace(/^"[^"]+"：(默认只读|按授权工具执行).*$/gmu, '')
    }
    assert.throws(() => assertDispatchCatalog(missingCatalog), 'Dispatch tools require their current type catalog')

    const staleTool = structuredClone(requests[0]!)
    staleTool.prompt.unshift({ role: 'system', content: '创建文件使用 project:write。' })
    assert.throws(() => assertCurrentWorkbenchPrompt(staleTool))
    const staleEdit = structuredClone(requests[0]!)
    staleEdit.prompt.unshift({ role: 'system', content: '编辑使用 selectionRef 和 baseRevision，失败后重新输入完整参数。' })
    assert.throws(() => assertCurrentWorkbenchPrompt(staleEdit))
    const badExample = structuredClone(requests[0]!)
    badExample.tools!.find((tool) => tool.name === 'project__edit')!.description = '调用参数示例：{"edits":[{"type":"replace_text","path":"a.ts","oldText":"a","newText":"b"}]}。'
    assert.throws(() => assertCurrentWorkbenchPrompt(badExample))
    const staleSchema = structuredClone(requests[0]!)
    staleSchema.tools!.find((tool) => tool.name === 'project__edit')!.inputSchema = {
      type: 'object', properties: { match: { type: 'string', description: 'Use expectedMatches to choose a repeated match.' } },
    }
    assert.throws(() => assertCurrentWorkbenchPrompt(staleSchema))
    const unavailableDiscovery = structuredClone(requests[2]!)
    unavailableDiscovery.prompt.unshift({ role: 'system', content: 'Discover and load project:code through tooling:map and tooling:replace.' })
    assert.throws(() => assertCurrentWorkbenchPrompt(unavailableDiscovery, true))
    const overprivileged = structuredClone(requests[2]!)
    overprivileged.tools!.push(requests[0]!.tools!.find((tool) => tool.name === 'project__file')!)
    assert.throws(() => assertCurrentWorkbenchPrompt(overprivileged, true))
  } finally {
    if (process.env.VELAROS_PROMPT_AUDIT_OUTPUT)
      await writeFile(join(process.env.VELAROS_PROMPT_AUDIT_OUTPUT, `workbench-${worker.type}-provider-requests.json`), JSON.stringify(requests, null, 2))
    await stack.dispose()
    await rm(root, { recursive: true, force: true })
  }
})

test('Codex resume replaces prior mode instructions in the actual app-server request', async () => {
  const requests: Array<{ method: string; params: Record<string, any> }> = []
  const runtime = new WorkbenchCodexAgentRuntime(
    {} as never,
    { get: async () => null, set: async () => undefined } as never,
    { codexSpecs: () => [] } as never,
    async () => undefined,
    '0.3.54',
    {} as never,
  )
  Object.assign(runtime, { client: { request: async (method: string, params: Record<string, any>) => {
    requests.push({ method, params })
    if (method === 'thread/start' || method === 'thread/resume') return { thread: { id: 'thread' } }
    if (method === 'turn/start') {
      queueMicrotask(() => Reflect.get(runtime, 'handleEnvelope').call(runtime, { method: 'turn/completed', params: { threadId: 'thread', turn: { id: 'turn', status: 'completed' } } }))
      return { turn: { id: 'turn' } }
    }
    return {}
  }, close: () => undefined } })
  try {
    for (const executionModes of [['plan', 'goal'], []]) {
      const result = await runtime.run({ executionId: `run-${requests.length}`, sessionId: 'modes', projectRoot: '/tmp/project',
        executionModes, messages: [{ role: 'user', content: 'Continue the current task.' }],
        events: new ExecutionEventBus({}), abortSignal: new AbortController().signal,
      })
      assert.equal(result.status, 'completed')
    }
    const start = requests.find((request) => request.method === 'thread/start')!
    const resume = requests.find((request) => request.method === 'thread/resume')!
    assert.match(start.params.developerInstructions, /Plan mode is writable/)
    assert.match(start.params.developerInstructions, /goal mode is active/)
    assert.doesNotMatch(resume.params.developerInstructions, /plan mode|goal mode/i)
    assert.match(resume.params.developerInstructions, /current project/)
  } finally {
    runtime.close()
  }
})

test('Claude resume sends a complete current mode snapshot to the SDK', async () => {
  const prompts: string[] = []
  const runtime = new WorkbenchClaudeAgentRuntime(
    {} as never,
    { get: async () => null, set: async () => undefined } as never,
    { claudeServer: () => ({ type: 'sdk', name: 'velaros-workbench' }) } as never,
    { resolveClaudeCommand: () => '/test/claude', loadClaudeSdk: async () => ({
      query: ({ prompt }: { prompt: string }) => {
        prompts.push(prompt)
        return Object.assign((async function* () { yield { type: 'result', subtype: 'success', session_id: 'claude-session', result: 'Checked.' } })(), { close: () => undefined })
      },
    }) } as never,
  )
  for (const executionModes of [['plan', 'goal'], []]) {
    assert.equal((await runtime.run({ executionId: `claude-${prompts.length}`, sessionId: 'claude-modes', projectRoot: '/tmp/project',
      executionModes, messages: [{ role: 'user', content: 'Inspect the current project.' }],
      events: new ExecutionEventBus({}), abortSignal: new AbortController().signal,
    })).status, 'completed')
  }
  assert.equal(prompts.length, 2)
  assert.match(prompts[0]!, /Current Workbench execution modes: plan, goal/)
  assert.match(prompts[0]!, /Plan mode is writable/)
  assert.match(prompts[1]!, /Current Workbench execution modes: standard/)
  assert.doesNotMatch(prompts[1]!, /plan mode is active|goal mode is active/)
})
