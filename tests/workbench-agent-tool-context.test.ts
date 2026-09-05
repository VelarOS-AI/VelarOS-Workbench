import assert from 'node:assert/strict'

import { test } from 'bun:test'

import {
  CodingSessionTracker,
  ContextBuilder,
  createBuiltInPromptRegistry,
  defaultRuntimePromptFeaturePolicy,
  PrimaryAgentProfile,
  RunContext,
} from '@velaros-ai/agent'

import { createWorkbenchToolContext } from '../src/main/agent/WorkbenchAgentExecutionStack'
import { WorkbenchAgentToolRegistry } from '../src/main/agent/WorkbenchAgentToolRegistry'

void test('Workbench agent tool context tracks model input modalities required by SoloLoop', () => {
  const context = createWorkbenchToolContext({
    sessionId: 'session-1',
    locale: 'en-US',
    projectRoot: '/tmp/workbench-project',
    abortSignal: new AbortController().signal,
    tracker: new CodingSessionTracker([], []),
    registry: new WorkbenchAgentToolRegistry([], {}, 0),
  })

  assert.equal(context.locale, 'en-US')
  assert.deepEqual(context.getEnabledToolCategories(), [])
  assert.deepEqual(context.getSupportedModelInputModalities(), ['text'])
  context.setSupportedModelInputModalities(['text', 'image', 'image'])
  assert.deepEqual(context.getSupportedModelInputModalities(), ['text', 'image'])
  assert.deepEqual(context.interaction.getCurrentPlan(), [])
  assert.deepEqual(context.interaction.updateCurrentPlan({ steps: [] }), [])
  assert.equal(context.interaction.getCurrentTask(), null)
  assert.equal(context.interaction.getCurrentRecommendedAction(), null)
  assert.equal(context.interaction.getCurrentExecutionAdvice(), null)
})

void test('Workbench no-execution sessions build an Agent prompt with an empty plan', async () => {
  const registry = new WorkbenchAgentToolRegistry([], {}, 0)
  const tracker = new CodingSessionTracker([], undefined, [], [], {
    toolCategoryToolNames: {},
    residentToolCategories: [],
  })
  const context = createWorkbenchToolContext({
    sessionId: 'session-prompt',
    projectRoot: '/tmp/workbench-project',
    abortSignal: new AbortController().signal,
    tracker,
    registry,
  })
  const profile = new PrimaryAgentProfile(
    {
      getSkillMarkdownForRole: () => '',
      listSkillsForRole: () => [],
    },
    { getToolCategoryId: () => 'project-files' }
  )
  const resolution = profile.resolve({ knownToolNames: [], allowSubAgents: false })
  const runtime = new RunContext(
    new ContextBuilder(createBuiltInPromptRegistry(), null),
    defaultRuntimePromptFeaturePolicy
  )

  const result = await runtime.buildPrimaryAgentSystemPrompt({
    chatConfig: {
      modelSelection: { provider: 'probe', model: 'probe' },
      systemPromptAppend: '',
    },
    systemConfig: {
      thinkingDepth: 'balanced',
      disabledToolNames: [],
      prompt: { segmentOverrides: [] },
      advancedRuntime: {},
      modelRuntimeContext: {
        providerRuntimeConfigs: [],
        openRouter: { useFreeModelsForDebug: false },
      },
    },
    messages: [{ role: 'user', content: 'Explain the Kernel design.' }],
    roleResolution: resolution,
    toolContext: context,
    contextPhase: 'operational',
  })

  assert.ok(result.systemPrompt.length > 0)
})
