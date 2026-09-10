import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { type ModelMessage, simulateReadableStream } from 'ai'
import { MockLanguageModelV3 } from 'ai/test'
import { describe, test } from 'bun:test'

import { CodingSessionTracker, ExecutionEventBus, goalTools, plansTools } from '@velaros-ai/agent'
import { createModelRuntimeComposition } from '@velaros-ai/model/node'
import type { ProjectKernel } from '@velaros-ai/project/runtime'

import { WorkbenchActiveContextStore } from '../src/main/agent/WorkbenchActiveContextStore'
import {
  WorkbenchAgentControlCategory,
  WorkbenchAgentControlCategoryIds,
  WorkbenchAgentControlTools,
} from '../src/main/agent/WorkbenchAgentControlTools'
import {
  createWorkbenchInteractionPort,
  createWorkbenchToolContext,
  WorkbenchAgentExecutionStack,
} from '../src/main/agent/WorkbenchAgentExecutionStack'
import { WorkbenchAgentToolRegistry } from '../src/main/agent/WorkbenchAgentToolRegistry'
import type { WorkbenchProjectCapabilityProvider } from '../src/main/workspace/ProjectCapabilityProvider'

async function withStoreDirectory(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'workbench-active-context-'))
  try {
    await run(directory)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

function createPlanningContext(store: WorkbenchActiveContextStore, sessionId: string) {
  const registry = new WorkbenchAgentToolRegistry(
    WorkbenchAgentControlTools,
    WorkbenchAgentControlCategory,
    0
  )
  const tracker = new CodingSessionTracker([...WorkbenchAgentControlCategoryIds], undefined, [], [], {
    toolCategoryToolNames: registry.toolCategoryToolNames,
    residentToolCategories: WorkbenchAgentControlCategoryIds,
  })
  return createWorkbenchToolContext({
    sessionId,
    projectRoot: '/tmp/workbench-project',
    abortSignal: new AbortController().signal,
    tracker,
    registry,
    activeContext: store.forSession(sessionId),
    interaction: createWorkbenchInteractionPort('execution-1'),
  })
}

const NoProjectProvider: WorkbenchProjectCapabilityProvider = {
  invoke: () => Promise.resolve(null),
  resolveProject: () => Promise.reject(new Error('not used')),
  dispose: () => Promise.resolve(),
}

const EmptyProjectProvider: WorkbenchProjectCapabilityProvider = {
  invoke: () => Promise.resolve(null),
  resolveProject: async (root) => ({
    kernel: { root } as ProjectKernel,
    tools: [],
    categoryDefinitions: {},
    enabledCategoryIds: [],
    residentCategoryIds: [],
    initialVisibleToolNames: [],
  }),
  dispose: () => Promise.resolve(),
}

/** 按顺序回放的模型：每个请求吐一段预先写好的流（工具调用或正文）。 */
function createScriptedStack(
  store: WorkbenchActiveContextStore,
  turns: ReadonlyArray<{ toolCall: { name: string; input: string } } | { text: string }>
): { stack: WorkbenchAgentExecutionStack; requests: () => number } {
  let requests = 0
  const model = new MockLanguageModelV3({
    provider: 'probe',
    modelId: 'probe',
    doStream: async () => {
      const turn = turns[Math.min(requests, turns.length - 1)]!
      requests += 1
      return {
        stream: simulateReadableStream({
          initialDelayInMs: null,
          chunkDelayInMs: null,
          chunks: [
            { type: 'stream-start', warnings: [] },
            ...('toolCall' in turn
              ? [{
                  type: 'tool-call' as const,
                  toolCallId: `call-${requests}`,
                  toolName: turn.toolCall.name,
                  input: turn.toolCall.input,
                }]
              : [
                  { type: 'text-start' as const, id: 'reply' },
                  { type: 'text-delta' as const, id: 'reply', delta: turn.text },
                  { type: 'text-end' as const, id: 'reply' },
                ]),
            {
              type: 'finish',
              finishReason: { unified: 'toolCall' in turn ? 'tool-calls' : 'stop', raw: 'stop' },
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
  const stack = new WorkbenchAgentExecutionStack(
    EmptyProjectProvider,
    {
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
    },
    undefined,
    undefined,
    store
  )
  return { stack, requests: () => requests }
}

void describe('Workbench goal and plan state', () => {
  void test('goal tools keep the session goal on disk across store instances', async () => {
    await withStoreDirectory(async (directory) => {
      const store = new WorkbenchActiveContextStore(() => directory)
      const context = createPlanningContext(store, 'session-a')

      const created = await goalTools['goal:create'].execute(
        { objective: '修复保存失败并跑验证', steps: [{ step: '定位保存路径', status: 'in_progress' }] },
        context as never
      )
      assert.equal((created as { status: string }).status, 'active')
      // 同一会话已有活动目标时不覆盖：重复创建是幂等读取。
      const repeated = await goalTools['goal:create'].execute({ objective: '另一个目标' }, context as never)
      assert.equal((repeated as { reused?: boolean }).reused, true)

      const reopened = new WorkbenchActiveContextStore(() => directory)
      const goals = await reopened.list('session-a', { status: 'all', kinds: ['requirement'] })
      assert.equal(goals.length, 1)
      assert.equal(goals[0]?.content.includes('修复保存失败并跑验证'), true)
      assert.deepEqual(await reopened.list('session-b'), [])
    })
  })

  void test('plan tools keep a per-run plan and reference steps by number', async () => {
    const store = new WorkbenchActiveContextStore()
    const context = createPlanningContext(store, 'session-plan')

    const initial = (await plansTools['plan:update'].execute(
      {
        plan: [
          { step: '读代码', status: 'in_progress' },
          { step: '改代码', status: 'pending' },
        ],
      },
      context as never
    )) as { plan: Array<{ title: string; status: string }> }
    assert.deepEqual(initial.plan.map((step) => [step.title, step.status]), [
      ['读代码', 'running'],
      ['改代码', 'pending'],
    ])

    const advanced = (await plansTools['plan:update'].execute(
      { complete_step: 1 },
      context as never
    )) as { plan: Array<{ title: string; status: string }> }
    assert.deepEqual(advanced.plan.map((step) => step.status), ['completed', 'running'])
    // 计划正文同时写进活动上下文：跨轮、跨压缩都在。
    const plans = await store.list('session-plan', { status: 'all', kinds: ['plan'] })
    assert.equal(plans.length, 1)
  })

  void test('the goal card pauses, resumes and forgets a goal with its session', async () => {
    await withStoreDirectory(async (directory) => {
      const store = new WorkbenchActiveContextStore(() => directory)
      const stack = new WorkbenchAgentExecutionStack(
        NoProjectProvider,
        undefined,
        undefined,
        undefined,
        store
      )
      assert.equal(await stack.getGoalLifecycle('session-goal'), null)
      await assert.rejects(() => stack.updateGoalLifecycle('session-goal', 'pause'), /No goal exists/u)

      await goalTools['goal:create'].execute(
        { objective: '把设置页迁到新表单' },
        createPlanningContext(store, 'session-goal') as never
      )
      const paused = await stack.updateGoalLifecycle('session-goal', 'pause')
      assert.equal(paused.metadata?.goalStatus, 'paused')
      const resumed = await stack.updateGoalLifecycle('session-goal', 'resume')
      assert.equal(resumed.metadata?.goalStatus, 'active')
      assert.equal((await stack.getGoalLifecycle('session-goal'))?.id, resumed.id)

      await stack.releaseSession('session-goal')
      assert.equal(await stack.getGoalLifecycle('session-goal'), null)
      assert.deepEqual(await readdir(directory), [])
    })
  })

  void test('goal mode sets the goal from the message and the model closes it with goal:update', async () => {
    const store = new WorkbenchActiveContextStore()
    const { stack, requests } = createScriptedStack(store, [
      { toolCall: { name: 'goal__update', input: '{"status":"complete"}' } },
      { text: '目标已完成。' },
    ])
    const messages: ModelMessage[] = [{ role: 'user', content: '把导出按钮改成下拉菜单' }]
    try {
      const result = await stack.run({
        sessionId: 'goal-mode',
        executionId: 'goal-mode-run',
        projectRoot: '/tmp/workbench-project',
        messages,
        config: { modelSelection: { provider: 'probe', model: 'probe' }, executionModes: ['goal'] },
        events: new ExecutionEventBus(),
        abortSignal: new AbortController().signal,
      })
      assert.equal(result.status, 'completed')
      assert.equal(requests(), 2)
      const goal = await stack.getGoalLifecycle('goal-mode')
      assert.equal(goal?.content.includes('把导出按钮改成下拉菜单'), true)
      assert.equal(goal?.metadata?.goalStatus, 'complete')
    } finally {
      await stack.dispose()
    }
  })

  void test('ignores a damaged store file and rejects unsafe session ids', async () => {
    await withStoreDirectory(async (directory) => {
      await writeFile(join(directory, 'session-broken.json'), '{"version":1,"artifacts":[{"id":"x"}', 'utf8')
      const store = new WorkbenchActiveContextStore(() => directory)
      assert.deepEqual(await store.list('session-broken', { status: 'all' }), [])
      await assert.rejects(() => store.list('../escape'), /无效的会话 id/u)
      assert.equal(existsSync(join(directory, 'session-broken.json')), true)
    })
  })
})
