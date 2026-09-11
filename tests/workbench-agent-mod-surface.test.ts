import assert from 'node:assert/strict'

import { asSchema, type ModelMessage, simulateReadableStream } from 'ai'
import { MockLanguageModelV3 } from 'ai/test'
import { describe, test } from 'bun:test'
import { z } from 'zod'

import { CodingSessionTracker, createToolTransportNamePlan, ExecutionEventBus } from '@velaros-ai/agent'
import type { AgentEvent, ToolCategoryDefinition } from '@velaros-ai/agent/protocol'
import { createModelRuntimeComposition } from '@velaros-ai/model/node'
import type { ProjectKernel } from '@velaros-ai/project/runtime'

import {
  WorkbenchAgentControlCategoryIds,
  WorkbenchAgentControlToolNames,
} from '../src/main/agent/WorkbenchAgentControlTools'
import {
  composeWorkbenchAgentRunToolSnapshot,
  createWorkbenchToolContext,
  WorkbenchAgentExecutionStack,
  type WorkbenchAgentModSurfaceProvider,
  type WorkbenchAgentModSurfaceSnapshot,
} from '../src/main/agent/WorkbenchAgentExecutionStack'
import {
  type WorkbenchAgentToolDefinition,
  WorkbenchAgentToolRegistry,
} from '../src/main/agent/WorkbenchAgentToolRegistry'
import type {
  WorkbenchProjectCapability,
  WorkbenchProjectCapabilityProvider,
} from '../src/main/workspace/ProjectCapabilityProvider'

const ProjectCategory: ToolCategoryDefinition = {
  id: 'project-files',
  label: 'Project files',
  description: 'Read project files.',
  toolOs: { domain: 'project', defaultState: 'resident' },
}

const BrowserCategory: ToolCategoryDefinition = {
  id: 'browser-core',
  label: 'Browser core',
  description: 'Inspect and operate the page.',
  toolOs: { domain: 'browser', defaultState: 'loadable' },
}

function providerToolName(canonicalName: string): string {
  return createToolTransportNamePlan([canonicalName]).canonicalToProvider[canonicalName]!
}

function createTool(input: {
  name: string
  categoryId: string
  available?: boolean
  requiresImage?: boolean
}): WorkbenchAgentToolDefinition {
  return {
    name: input.name,
    categoryId: input.categoryId,
    role: 'inspect',
    description: `Run ${input.name}`,
    permissions: ['network'],
    capabilities: { effectKind: 'read', concurrency: 'safe' },
    requiredModelInputModalities: input.requiresImage ? ['image'] : undefined,
    exposure: { tier: 'common', rank: 12 },
    usageSkillId: 'browser-control',
    outputInline: true,
    providerId: 'velaros.browser',
    providerKind: 'mod',
    schema: z.object({}),
    isAvailable: input.available === undefined ? undefined : () => input.available === true,
    execute: async () => ({ ok: true }),
  }
}

function createProjectCapability(projectRoot = '/tmp/workbench-project'): WorkbenchProjectCapability {
  const projectTool = createTool({ name: 'project:read', categoryId: 'project-files' })
  return {
    kernel: { root: projectRoot } as ProjectKernel,
    tools: [projectTool],
    categoryDefinitions: { 'project-files': ProjectCategory },
    enabledCategoryIds: ['project-files'],
    residentCategoryIds: ['project-files'],
    initialVisibleToolNames: ['project:read'],
  }
}

function createModSurface(
  generation: number,
  tools: readonly WorkbenchAgentToolDefinition[] = []
): WorkbenchAgentModSurfaceSnapshot {
  const hasBrowser = tools.length > 0
  return {
    generation,
    tools,
    categoryDefinitions: hasBrowser ? { 'browser-core': BrowserCategory } : {},
    enabledCategoryIds: hasBrowser ? ['browser-core'] : [],
    residentCategoryIds: [],
    initialVisibleToolNames: hasBrowser ? tools.slice(0, 1).map((tool) => tool.name) : [],
  }
}

void describe('Workbench Agent Mod surface', () => {
  void test('runs the installed Platform execution factory through the real Workbench host', async () => {
    const model = new MockLanguageModelV3({
      provider: 'probe',
      modelId: 'probe',
      doStream: async () => ({
        stream: simulateReadableStream({
          initialDelayInMs: null,
          chunkDelayInMs: null,
          chunks: [
            { type: 'stream-start', warnings: [] },
            { type: 'text-start', id: 'reply' },
            { type: 'text-delta', id: 'reply', delta: 'Workbench factory ready' },
            { type: 'text-end', id: 'reply' },
            {
              type: 'finish',
              finishReason: { unified: 'stop', raw: 'stop' },
              usage: {
                inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
                outputTokens: { total: 4, text: 4, reasoning: 0 },
              },
            },
          ],
        }),
      }),
    })
    const provider = () => model
    const projectProvider: WorkbenchProjectCapabilityProvider = {
      invoke: async () => null,
      resolveProject: async (root) => createProjectCapability(root),
      dispose: async () => undefined,
    }
    const stack = new WorkbenchAgentExecutionStack(projectProvider, {
      ...createModelRuntimeComposition(),
      agentModelRuntime: {
        createAgentProvider: () => provider,
        resolveRoleRuntime: async (_selection, _context, signal) => {
          signal?.throwIfAborted()
          return {
            provider,
            providerId: 'probe',
            model: 'probe',
            providerModel: 'probe',
            contextWindow: 128_000,
            supportedInputModalities: ['text'],
            resolutionSource: 'probe',
            resolutionTrace: [],
          }
        },
      },
    })
    const messages: ModelMessage[] = [{ role: 'user', content: 'Say that the factory is ready.' }]
    const events: AgentEvent[] = []
    try {
      const result = await stack.run({
        sessionId: 'factory-consumer',
        projectRoot: '/tmp/workbench-project',
        messages,
        config: { modelSelection: { provider: 'probe', model: 'probe' } },
        events: new ExecutionEventBus({ agent: (event) => events.push(event) }),
        abortSignal: new AbortController().signal,
      })
      assert.equal(result.status, 'completed')
      assert.equal(model.doStreamCalls.length, 1)
      assert.equal(events.filter((event) => event.type === 'text-delta')
        .map((event) => event.text).join(''), 'Workbench factory ready')
      assert.match(JSON.stringify(messages), /Workbench factory ready/)
    } finally {
      await stack.dispose()
    }
  })

  void test('sends resident tools on the first turn with audit schemas and preserves contextual visibility', async () => {
    const executed: unknown[] = []
    const resident = {
      ...createTool({ name: 'project:read', categoryId: 'project-files' }),
      permissions: [],
      schema: z.object({ path: z.string() }),
      execute: async (input: unknown) => { executed.push(input); return { text: 'file evidence' } },
    }
    const contextual = createTool({ name: 'browser:contextual', categoryId: 'browser-core' })
    const hidden = {
      ...createTool({ name: 'browser:hidden', categoryId: 'browser-core', available: false }),
      hideWhenUnavailable: true,
    }
    const unavailable = createTool({ name: 'browser:resident_unavailable', categoryId: 'browser-core', available: false })
    let requests = 0
    const model = new MockLanguageModelV3({
      provider: 'probe', modelId: 'probe',
      doStream: async (request) => {
        requests += 1
        const names = request.tools?.map((tool) => tool.name) ?? []
        // agent:dispatch、目标 / 计划、上下文召回与工作台界面工具常驻，首轮就在场；job:* 自带可用性门
        // （要宿主提供后台作业读写口），Workbench 的执行面没有，因此它们正确地不出现在请求里。
        if (requests === 1)
          assert.deepEqual(names, [
            'project__read',
            'agent__dispatch',
            'goal__get',
            'goal__create',
            'goal__update',
            'plan__update',
            'plan__get',
            'context__recall',
            'workbench__open_file',
            'workbench__clear_highlights',
            'workbench__reveal_in_explorer',
            'workbench__open_diff',
            'workbench__explain_code',
            'workbench__clear_explanations',
            'workbench__get_editor_state',
            'workbench__start_run',
            'workbench__read_run',
            'workbench__stop_run',
            'workbench__open_preview',
            'workbench__get_problems',
          ])
        assert.ok(!names.includes('browser__hidden'))
        assert.ok(!names.includes('browser__resident_unavailable'))
        if (requests === 2) assert.match(JSON.stringify(request.prompt), /file evidence/)
        return { stream: simulateReadableStream({
          initialDelayInMs: null, chunkDelayInMs: null,
          chunks: [
            { type: 'stream-start', warnings: [] },
            ...(requests === 1 ? [{ type: 'tool-call' as const, toolCallId: 'read-1', toolName: 'project__read', input: '{"path":"README.md"}' }] : [
              { type: 'text-start' as const, id: 'reply' },
              { type: 'text-delta' as const, id: 'reply', delta: 'Verified file evidence.' },
              { type: 'text-end' as const, id: 'reply' },
            ]),
            { type: 'finish', finishReason: { unified: requests === 1 ? 'tool-calls' : 'stop', raw: 'stop' },
              usage: { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 4, text: 4, reasoning: 0 } } },
          ],
        }) }
      },
    })
    const provider = () => model
    const projectProvider: WorkbenchProjectCapabilityProvider = {
      invoke: async () => null,
      resolveProject: async (root) => ({ ...createProjectCapability(root), tools: [resident] }),
      dispose: async () => undefined,
    }
    const stack = new WorkbenchAgentExecutionStack(projectProvider, {
      ...createModelRuntimeComposition(),
      agentModelRuntime: {
        createAgentProvider: () => provider,
        resolveRoleRuntime: async () => ({ provider, providerId: 'probe', model: 'probe', providerModel: 'probe', contextWindow: 128_000, supportedInputModalities: ['text'], resolutionSource: 'probe', resolutionTrace: [] }),
      },
    }, {
      captureSnapshot: () => ({
        ...createModSurface(1, [contextual, hidden, unavailable]),
        // 即便 unavailable 工具在宿主常驻清单里，实际请求仍应经过 registry 可用性门。
        initialVisibleToolNames: [unavailable.name],
      }),
    })
    const messages: ModelMessage[] = [{ role: 'user', content: 'Read README.md and report the evidence.' }]
    try {
      const result = await stack.run({
        sessionId: 'resident-tools', projectRoot: '/tmp/workbench-project', messages,
        config: { modelSelection: { provider: 'probe', model: 'probe' } },
        events: new ExecutionEventBus(), abortSignal: new AbortController().signal,
      })
      assert.equal(result.status, 'completed')
      assert.equal(requests, 2)
      assert.deepEqual(executed, [{ path: 'README.md' }])
      assert.match(JSON.stringify(messages), /file evidence/)
      assert.match(JSON.stringify(messages), /read-1/)
      assert.match(JSON.stringify(messages), /project:read/)
      assert.doesNotMatch(JSON.stringify(messages), /project__read/)
    } finally { await stack.dispose() }
  })

  void test('retains VelaTool descriptor metadata and real category definitions', () => {
    const available = createTool({ name: 'browser:enter_site', categoryId: 'browser-core' })
    const unavailable = createTool({
      name: 'browser:capture_screenshot',
      categoryId: 'browser-core',
      available: false,
      requiresImage: true,
    })
    const registry = new WorkbenchAgentToolRegistry(
      [available, unavailable],
      { 'browser-core': BrowserCategory },
      7
    )

    assert.deepEqual(registry.getDescriptor(available.name), {
      descriptorId: available.name,
      name: available.name,
      description: available.description,
      role: 'inspect',
      permissions: ['network'],
      capabilities: { effectKind: 'read', concurrency: 'safe' },
      requiredModelInputModalities: undefined,
      exposure: { tier: 'common', rank: 12 },
      usageSkillId: 'browser-control',
      outputInline: true,
      categoryId: 'browser-core',
      systemEnabled: true,
      providerId: 'velaros.browser',
      providerKind: 'mod',
      registrationStatus: 'active',
    })
    assert.deepEqual(registry.listCategories({}, undefined, 'all')[0]?.category, BrowserCategory)
    assert.deepEqual(registry.listAvailable({}, undefined, 'all').map((tool) => tool.name), [
      available.name,
    ])
    assert.deepEqual(registry.listAvailable({}, undefined, 'catalog').map((tool) => tool.name), [
      available.name,
      unavailable.name,
    ])
    assert.equal(registry.getCapabilityRevision(), 7)
    assert.match(registry.getRegistrationSignature(available.name) ?? '', /^7:/)
  })

  void test('composes Project and globally enabled Mod tools with an explicit resident set', () => {
    const browserTool = createTool({ name: 'browser:enter_site', categoryId: 'browser-core' })
    const snapshot = composeWorkbenchAgentRunToolSnapshot(
      createProjectCapability(),
      createModSurface(3, [browserTool])
    )

    assert.equal(snapshot.generation, 3)
    // 执行栈自有的工具（agent:dispatch / job:* 与 goal:* / plan:*）恒定夹在项目工具与 Mod 工具之间，
    // 且恒定常驻——模型看不见「可以派出去」「该先立个计划」这些选项就不会去选。
    assert.deepEqual(snapshot.tools.map((tool) => tool.name), [
      'project:read',
      ...WorkbenchAgentControlToolNames,
      'browser:enter_site',
    ])
    assert.deepEqual(snapshot.enabledCategoryIds, [
      'project-files',
      ...WorkbenchAgentControlCategoryIds,
      'browser-core',
    ])
    assert.deepEqual(snapshot.residentCategoryIds, [
      'project-files',
      ...WorkbenchAgentControlCategoryIds,
    ])
    assert.deepEqual(snapshot.initialVisibleToolNames, [
      'project:read',
      ...WorkbenchAgentControlToolNames,
      'browser:enter_site',
    ])
    assert.equal(snapshot.categoryDefinitions['browser-core'], BrowserCategory)

    const registry = new WorkbenchAgentToolRegistry(
      snapshot.tools,
      snapshot.categoryDefinitions,
      snapshot.generation
    )
    const tracker = new CodingSessionTracker([...snapshot.enabledCategoryIds], undefined, [], [], {
      toolCategoryToolNames: registry.toolCategoryToolNames,
      residentToolCategories: snapshot.residentCategoryIds,
    })
    const context = createWorkbenchToolContext({
      sessionId: 'session-residency',
      projectRoot: '/tmp/workbench-project',
      abortSignal: new AbortController().signal,
      tracker,
      registry,
      enabledCategoryIds: snapshot.enabledCategoryIds,
      initialVisibleToolNames: snapshot.initialVisibleToolNames,
    })
    assert.deepEqual(context.capabilityPorts?.allocation?.baselineToolNames, snapshot.initialVisibleToolNames)
    assert.deepEqual(context.describeToolInputSchema('project:read'), registry.describeToolInputSchema('project:read'))
    const scopePolicy = context.capabilityPorts?.scopePolicy
    assert.ok(scopePolicy?.getResidency)
    assert.deepEqual(
      scopePolicy.getResidency({}).residentToolNames,
      ['project:read', ...WorkbenchAgentControlToolNames, 'browser:enter_site']
    )
    registry.toAiTools(context, ['project:read'])
    assert.deepEqual(context.getCurrentVisibleToolTransportNames(), {
      'project:read': 'project__read',
    })
    registry.toAiTools(context, [])
    assert.deepEqual(context.getCurrentVisibleToolTransportNames(), {})
  })

  void test('budgets the emitted input schema and preserves validation and availability filters', async () => {
    let available = true
    const small = {
      ...createTool({ name: 'browser:small', categoryId: 'browser-core' }),
      schema: z.object({ value: z.string().default('default').transform((value) => value.trim()) }),
    }
    const large = {
      ...createTool({ name: 'browser:large', categoryId: 'browser-core' }),
      schema: z.object(Object.fromEntries(Array.from({ length: 100 }, (_, index) => [
        `field${index}`,
        z.string().describe('A meaningful property explanation that occupies input context.'),
      ]))),
      isAvailable: () => available,
    }
    const registry = new WorkbenchAgentToolRegistry(
      [small, large],
      { 'browser-core': BrowserCategory },
      1
    )
    const aiTools = registry.toAiTools({})
    const sizes = registry.estimateToolSerializedCharsByName({})
    for (const definition of [small, large]) {
      const emittedSchema = await asSchema(aiTools[providerToolName(definition.name)]?.inputSchema).jsonSchema
      assert.deepEqual(registry.describeToolInputSchema(definition.name), emittedSchema)
      assert.equal(sizes[definition.name], definition.name.length + definition.description.length
        + 50 + JSON.stringify(emittedSchema).length)
    }
    assert.ok((sizes[large.name] ?? 0) - (sizes[small.name] ?? 0) > 10_000)
    assert.equal(registry.estimateToolsSerializedChars({}),
      (sizes[small.name] ?? 0) + (sizes[large.name] ?? 0))
    assert.deepEqual(registry.estimateToolSerializedCharsByName({}, [small.name]), {
      [small.name]: sizes[small.name],
    })
    assert.equal(registry.toAiTools({})[providerToolName(small.name)]?.inputSchema, aiTools[providerToolName(small.name)]?.inputSchema)

    const smallInput = asSchema(aiTools[providerToolName(small.name)]?.inputSchema)
    assert.equal(Object.hasOwn(await smallInput.jsonSchema, 'required'), false)
    assert.deepEqual(await smallInput.validate?.({ value: '  trimmed  ' }), {
      success: true,
      value: { value: 'trimmed' },
    })
    assert.equal((await smallInput.validate?.({ value: 42 }))?.success, false)

    // Warm schema caches must not bypass the current category or tool availability gates.
    available = false
    assert.deepEqual(registry.estimateToolSerializedCharsByName({}), { [small.name]: sizes[small.name] })
    assert.deepEqual(Object.keys(registry.toAiTools({})), [providerToolName(small.name)])
    assert.equal(registry.estimateToolsSerializedChars({
      codingSession: { hasToolCategoryAccess: () => false },
    }), 0)
  })

  void test('budgets the same discovery fallback emitted for a duck schema', async () => {
    const definition = {
      ...createTool({ name: 'browser:duck', categoryId: 'browser-core' }),
      schema: { safeParse: (value: unknown) => ({ success: true as const, data: value }) },
    }
    const registry = new WorkbenchAgentToolRegistry(
      [definition],
      { 'browser-core': BrowserCategory },
      1
    )
    const emittedSchema = await asSchema(registry.toAiTools({})[providerToolName(definition.name)]?.inputSchema).jsonSchema
    assert.deepEqual(emittedSchema, { type: 'object', properties: {}, additionalProperties: true })
    assert.equal(registry.estimateToolsSerializedChars({}),
      definition.name.length + definition.description.length + 50 + JSON.stringify(emittedSchema).length)
  })

  void test('reuses an equivalent tool surface across UI revisions and rebuilds real Mod changes', async () => {
    let currentSurface = createModSurface(1)
    const modSurfaceProvider: WorkbenchAgentModSurfaceProvider = {
      captureSnapshot: () => currentSurface,
    }
    const projectProvider: WorkbenchProjectCapabilityProvider = {
      invoke: () => Promise.resolve(null),
      resolveProject: (projectRoot) => Promise.resolve(createProjectCapability(projectRoot)),
      dispose: () => Promise.resolve(),
    }
    const stack = new WorkbenchAgentExecutionStack(
      projectProvider,
      undefined,
      modSurfaceProvider
    )
    const resolveSession = stack['resolveSession'].bind(stack)
    const input = {
      sessionId: 'session-a',
      projectRoot: '/tmp/workbench-project',
      abortSignal: new AbortController().signal,
    }

    const first = await resolveSession(input)
    const same = await resolveSession(input)
    assert.equal(same, first)

    // Browser host 也用 generation 广播 URL/title/load 等 UI 变化。工具面不变时
    // 不得丢掉已有 tracker/loop。
    currentSurface = createModSurface(2)
    const emptyUiRevision = await resolveSession(input)
    assert.equal(emptyUiRevision, first)
    assert.equal(emptyUiRevision.tracker, first.tracker)
    assert.equal(emptyUiRevision.stack, first.stack)

    const otherSession = await resolveSession({ ...input, sessionId: 'session-b' })
    assert.notEqual(otherSession.stack, first.stack)

    const browserTool = {
      ...createTool({ name: 'browser:enter_site', categoryId: 'browser-core' }),
      registrationSignature: '3:velaros.browser:browser:enter_site',
    }
    currentSurface = createModSurface(3, [browserTool])
    const enabledBrowser = await resolveSession(input)
    assert.notEqual(enabledBrowser, first)
    assert.notEqual(enabledBrowser.stack, first.stack)
    assert.deepEqual(first.registry.names, ['project:read', ...WorkbenchAgentControlToolNames])
    assert.deepEqual(enabledBrowser.registry.names, [
      'project:read',
      ...WorkbenchAgentControlToolNames,
      'browser:enter_site',
    ])
    const browserAllowList = [browserTool.name]
    const originalBrowserSize = enabledBrowser.registry.estimateToolsSerializedChars({}, browserAllowList)
    const originalBrowserInputSchema = enabledBrowser.registry.toAiTools({})[providerToolName(browserTool.name)]?.inputSchema

    // capture 会重建宿主 wrapper，并用当前 UI generation 作注册签名前缀；
    // 这些都不是 Mod 工具面变化。
    const sameBrowserTool = {
      ...createTool({ name: 'browser:enter_site', categoryId: 'browser-core' }),
      registrationSignature: '4:velaros.browser:browser:enter_site',
    }
    currentSurface = createModSurface(4, [sameBrowserTool])
    const browserUiRevision = await resolveSession(input)
    assert.equal(browserUiRevision, enabledBrowser)
    assert.equal(browserUiRevision.tracker, enabledBrowser.tracker)
    assert.equal(browserUiRevision.stack, enabledBrowser.stack)
    assert.equal(browserUiRevision.registry.toAiTools({})[providerToolName(browserTool.name)]?.inputSchema,
      originalBrowserInputSchema)

    const changedBrowserTool = {
      ...sameBrowserTool,
      registrationSignature: '5:velaros.browser:browser:enter_site',
      description: 'Updated Browser Mod tool description',
    }
    currentSurface = createModSurface(5, [changedBrowserTool])
    const changedBrowserSurface = await resolveSession(input)
    assert.notEqual(changedBrowserSurface, enabledBrowser)
    assert.notEqual(changedBrowserSurface.stack, enabledBrowser.stack)
    assert.notEqual(changedBrowserSurface.surfaceSignature, enabledBrowser.surfaceSignature)

    currentSurface = createModSurface(6, [{
      ...changedBrowserTool,
      registrationSignature: '6:velaros.browser:browser:enter_site',
      schema: z.object({ target: z.enum(['current', 'new']).describe('Choose the browser tab target.') }),
    }])
    const replacedSchema = await resolveSession(input)
    assert.notEqual(replacedSchema, changedBrowserSurface)
    assert.ok(replacedSchema.registry.estimateToolsSerializedChars({}, browserAllowList) > originalBrowserSize)
    assert.notEqual(replacedSchema.registry.toAiTools({})[providerToolName(browserTool.name)]?.inputSchema,
      originalBrowserInputSchema)

    currentSurface = createModSurface(7)
    const removedBrowser = await resolveSession(input)
    assert.equal(removedBrowser.registry.estimateToolsSerializedChars({}, browserAllowList), 0)
    assert.deepEqual(removedBrowser.registry.toAiTools({}, browserAllowList), {})

    currentSurface = createModSurface(8, [{
      ...browserTool,
      registrationSignature: '8:velaros.browser:browser:enter_site',
    }])
    const restoredBrowser = await resolveSession(input)
    assert.notEqual(restoredBrowser.registry, enabledBrowser.registry)
    assert.equal(restoredBrowser.registry.estimateToolsSerializedChars({}, browserAllowList), originalBrowserSize)
    assert.deepEqual(
      await asSchema(restoredBrowser.registry.toAiTools({})[providerToolName(browserTool.name)]?.inputSchema).jsonSchema,
      await asSchema(originalBrowserInputSchema).jsonSchema
    )

    const nextRoot = await resolveSession({ ...input, projectRoot: '/tmp/other-project' })
    assert.notEqual(nextRoot, restoredBrowser)
    await stack.dispose()
  })
})
