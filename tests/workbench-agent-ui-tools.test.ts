import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { type ModelMessage, simulateReadableStream } from 'ai'
import { MockLanguageModelV3 } from 'ai/test'
import { describe, test } from 'bun:test'

import { ExecutionEventBus } from '@velaros-ai/agent'
import type { AgentEvent } from '@velaros-ai/agent/protocol'
import { createModelRuntimeComposition } from '@velaros-ai/model/node'
import type { ProjectKernel } from '@velaros-ai/project/runtime'

import { WorkbenchAgentExecutionStack } from '../src/main/agent/WorkbenchAgentExecutionStack'
import { WorkbenchAgentUiBridge } from '../src/main/agent/WorkbenchAgentUiBridge'
import { WorkbenchAgentUiToolSpecs } from '../src/main/agent/WorkbenchAgentUiTools'
import type { WorkbenchProjectCapabilityProvider } from '../src/main/workspace/ProjectCapabilityProvider'
import {
  type WorkbenchAgentUiCommand,
  WorkbenchAgentUiNoticeKind,
  type WorkbenchAgentUiRequest,
} from '../src/shared/workbenchAgentUi'

async function withProject(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'workbench-agent-ui-'))
  try {
    await mkdir(join(root, 'src', 'cache'), { recursive: true })
    await writeFile(join(root, 'src', 'cache', 'store.ts'), 'line 1\nline 2\nline 3\nline 4\n', 'utf8')
    await writeFile(join(root, 'README.md'), '# demo\n', 'utf8')
    await run(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

function findTool(name: string) {
  const tool = WorkbenchAgentUiToolSpecs.find((candidate) => candidate.name === name)
  assert.ok(tool, name)
  return tool
}

/** 假窗口：记下每条界面命令，按给定的回执回。 */
function createFakeUi(reply: (command: WorkbenchAgentUiCommand) => Record<string, unknown> = () => ({})) {
  const commands: WorkbenchAgentUiCommand[] = []
  return {
    commands,
    port: {
      request: async (command: WorkbenchAgentUiCommand) => {
        commands.push(command)
        return reply(command)
      },
    },
  }
}

function toolContext(root: string, ui?: ReturnType<typeof createFakeUi>) {
  return {
    resourceId: root,
    abortSignal: new AbortController().signal,
    ...(ui ? { workbenchUi: ui.port } : {}),
  }
}

void describe('Workbench agent UI bridge', () => {
  void test('sends a request through the run event stream and settles on the matching reply', async () => {
    const bridge = new WorkbenchAgentUiBridge({ createRequestId: () => 'request-1' })
    const events: AgentEvent[] = []
    const port = bridge.forExecution({
      executionId: 'execution-1',
      sessionId: 'session-1',
      events: new ExecutionEventBus({ agent: (event) => events.push(event) }),
      abortSignal: new AbortController().signal,
    })

    const pending = port.request({ type: 'reveal-path', path: 'src' })
    assert.deepEqual(events, [
      {
        type: 'notice',
        kind: WorkbenchAgentUiNoticeKind,
        payload: {
          requestId: 'request-1',
          executionId: 'execution-1',
          sessionId: 'session-1',
          command: { type: 'reveal-path', path: 'src' },
        } satisfies WorkbenchAgentUiRequest,
      },
    ])
    // 别的执行回不了这一条；对上了才结算。
    assert.equal(
      bridge.resolve({ requestId: 'request-1', executionId: 'other', ok: true, data: {} }),
      false
    )
    assert.equal(
      bridge.resolve({ requestId: 'request-1', executionId: 'execution-1', ok: true, data: { done: 1 } }),
      true
    )
    assert.deepEqual(await pending, { done: 1 })
    // 结算过的请求不再接回执。
    assert.equal(
      bridge.resolve({ requestId: 'request-1', executionId: 'execution-1', ok: true, data: {} }),
      false
    )
  })

  void test('fails on a UI error, a timeout, a stopped run and the end of the run', async () => {
    let sequence = 0
    const bridge = new WorkbenchAgentUiBridge({
      timeoutMs: 20,
      createRequestId: () => `request-${(sequence += 1)}`,
    })
    const abort = new AbortController()
    const port = bridge.forExecution({
      executionId: 'execution-2',
      sessionId: 'session-2',
      events: new ExecutionEventBus(),
      abortSignal: abort.signal,
    })

    const rejected = port.request({ type: 'read-editor-state' })
    bridge.resolve({ requestId: 'request-1', executionId: 'execution-2', ok: false, message: 'no editor' })
    await assert.rejects(rejected, /no editor/u)

    await assert.rejects(port.request({ type: 'read-editor-state' }), /did not answer the UI action/u)

    const ended = port.request({ type: 'read-editor-state' })
    bridge.cancelExecution('execution-2', 'This run has ended.')
    await assert.rejects(ended, /This run has ended/u)

    const stopped = port.request({ type: 'read-editor-state' })
    abort.abort()
    await assert.rejects(stopped, /stopped/u)
    assert.throws(() => port.request({ type: 'read-editor-state' }))
  })
})

void describe('Workbench agent UI tools', () => {
  void test('stay hidden when no Workbench window is attached to the run', () => {
    for (const tool of WorkbenchAgentUiToolSpecs) {
      assert.equal(tool.hideWhenUnavailable, true, tool.name)
      assert.equal(tool.isAvailable?.(toolContext('/tmp/project')), false, tool.name)
      assert.equal(tool.isAvailable?.(toolContext('/tmp/project', createFakeUi())), true, tool.name)
    }
  })

  void test('open_file checks the path in the project and clamps the selected range', async () => {
    await withProject(async (root) => {
      const ui = createFakeUi()
      const openFile = findTool('workbench:open_file')

      const result = await openFile.execute(
        { path: './src/cache/store.ts', line: 2, endLine: 99 },
        toolContext(root, ui) as never
      )
      // 文件以换行结尾：编辑器里是 5 行（最后一行为空），结束行夹到第 5 行。
      assert.deepEqual(result, { opened: true, path: 'src/cache/store.ts', line: 2, endLine: 5 })
      assert.deepEqual(ui.commands, [
        { type: 'open-file', path: 'src/cache/store.ts', line: 2, column: 1, endLine: 5 },
      ])

      await openFile.execute({ path: join(root, 'README.md') }, toolContext(root, ui) as never)
      assert.deepEqual(ui.commands.at(-1), {
        type: 'open-file',
        path: 'README.md',
        line: 1,
        column: 1,
        endLine: null,
      })

      await assert.rejects(
        Promise.resolve(openFile.execute({ path: 'missing.ts' }, toolContext(root, ui) as never)),
        /does not exist/u
      )
      await assert.rejects(
        Promise.resolve(openFile.execute({ path: '../escape.ts' }, toolContext(root, ui) as never)),
        /outside the project root/u
      )
      await assert.rejects(
        Promise.resolve(openFile.execute({ path: 'src' }, toolContext(root, ui) as never)),
        /is a folder/u
      )
      await assert.rejects(
        Promise.resolve(
          openFile.execute({ path: 'src/cache/store.ts', line: 40 }, toolContext(root, ui) as never)
        ),
        /has only 5 lines/u
      )
      assert.equal(ui.commands.length, 2)
    })
  })

  void test('explain_code validates every stop of the walkthrough before touching the editor', async () => {
    await withProject(async (root) => {
      const ui = createFakeUi()
      const explain = findTool('workbench:explain_code')

      const result = await explain.execute(
        {
          explanations: [
            { path: 'src/cache/store.ts', startLine: 1, endLine: 2, title: ' 读缓存 ', text: ' 先查内存。 ' },
            { path: 'README.md', startLine: 1, text: '项目说明。' },
          ],
        },
        toolContext(root, ui) as never
      )
      assert.deepEqual(result, {
        added: 2,
        explanations: ['src/cache/store.ts:1-2', 'README.md:1'],
      })
      assert.deepEqual(ui.commands, [
        {
          type: 'explain-code',
          replace: true,
          explanations: [
            { path: 'src/cache/store.ts', startLine: 1, endLine: 2, title: '读缓存', text: '先查内存。' },
            { path: 'README.md', startLine: 1, endLine: 1, title: '', text: '项目说明。' },
          ],
        },
      ])

      // 任何一站写错，整批都不发出去。
      await assert.rejects(
        Promise.resolve(
          explain.execute(
            {
              explanations: [
                { path: 'README.md', startLine: 1, text: 'ok' },
                { path: 'README.md', startLine: 30, text: 'wrong line' },
              ],
              replace: false,
            },
            toolContext(root, ui) as never
          )
        ),
        /has only 2 lines/u
      )
      assert.equal(ui.commands.length, 1)
      assert.equal(explain.schema.safeParse({ explanations: [] }).success, false)
    })
  })

  void test('reveal, diff, clear and editor state pass project paths and window replies through', async () => {
    await withProject(async (root) => {
      const ui = createFakeUi((command) =>
        command.type === 'read-editor-state'
          ? { view: 'file', activeFile: { path: 'README.md', line: 1, column: 1, unsaved: false } }
          : command.type === 'clear-explanations'
            ? { cleared: 3 }
            : {}
      )
      const context = toolContext(root, ui) as never

      assert.deepEqual(
        await findTool('workbench:reveal_in_explorer').execute({ path: 'src/cache' }, context),
        { revealed: true, path: 'src/cache', kind: 'directory' }
      )
      await assert.rejects(
        Promise.resolve(findTool('workbench:reveal_in_explorer').execute({ path: '.' }, context)),
        /not the project root/u
      )
      // 删掉的文件也可能有改动可看：open_diff 只拦越界，不要求文件还在。
      assert.deepEqual(
        await findTool('workbench:open_diff').execute({ path: 'src/deleted.ts' }, context),
        { opened: true, path: 'src/deleted.ts' }
      )
      await assert.rejects(
        Promise.resolve(findTool('workbench:open_diff').execute({ path: '../x.ts' }, context)),
        /not a file inside the project/u
      )
      assert.deepEqual(await findTool('workbench:clear_explanations').execute({}, context), {
        cleared: 3,
      })
      assert.deepEqual(
        await findTool('workbench:get_editor_state').execute({}, context),
        { view: 'file', activeFile: { path: 'README.md', line: 1, column: 1, unsaved: false } }
      )
      assert.deepEqual(ui.commands, [
        { type: 'reveal-path', path: 'src/cache' },
        { type: 'open-diff', path: 'src/deleted.ts' },
        { type: 'clear-explanations', path: null },
        { type: 'read-editor-state' },
      ])
    })
  })
})

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

void describe('Workbench agent UI tools in a real run', () => {
  void test('the model opens a file in the window that started the run and reads the result', async () => {
    await withProject(async (root) => {
      const toolNamesPerRequest: string[][] = []
      const prompts: string[] = []
      const model = new MockLanguageModelV3({
        provider: 'probe',
        modelId: 'probe',
        doStream: async (request) => {
          toolNamesPerRequest.push(request.tools?.map((tool) => tool.name) ?? [])
          prompts.push(JSON.stringify(request.prompt))
          const first = toolNamesPerRequest.length === 1
          return {
            stream: simulateReadableStream({
              initialDelayInMs: null,
              chunkDelayInMs: null,
              chunks: [
                { type: 'stream-start', warnings: [] },
                ...(first
                  ? [{
                      type: 'tool-call' as const,
                      toolCallId: 'open-1',
                      toolName: 'workbench__open_file',
                      input: '{"path":"src/cache/store.ts","line":2,"endLine":3}',
                    }]
                  : [
                      { type: 'text-start' as const, id: 'reply' },
                      { type: 'text-delta' as const, id: 'reply', delta: '已经在编辑器里打开了。' },
                      { type: 'text-end' as const, id: 'reply' },
                    ]),
                {
                  type: 'finish',
                  finishReason: { unified: first ? 'tool-calls' : 'stop', raw: 'stop' },
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
      const stack = new WorkbenchAgentExecutionStack(EmptyProjectProvider, {
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
      const requests: WorkbenchAgentUiRequest[] = []
      // 窗口这一侧：收到界面请求就在「界面」上做完并回执（真实链路里走 Kernel IPC）。
      const events = new ExecutionEventBus({
        agent: (event) => {
          if (event.type !== 'notice' || event.kind !== WorkbenchAgentUiNoticeKind) return
          const request = event.payload as WorkbenchAgentUiRequest
          requests.push(request)
          queueMicrotask(() =>
            stack.ui.resolve({
              requestId: request.requestId,
              executionId: request.executionId,
              ok: true,
              data: { path: 'src/cache/store.ts', line: 2 },
            })
          )
        },
      })
      const messages: ModelMessage[] = [{ role: 'user', content: '带我看看缓存读写那段' }]
      try {
        const result = await stack.run({
          sessionId: 'ui-session',
          executionId: 'ui-run',
          projectRoot: root,
          messages,
          config: { modelSelection: { provider: 'probe', model: 'probe' } },
          events,
          abortSignal: new AbortController().signal,
        })
        assert.equal(result.status, 'completed')
        // 界面工具常驻：第一轮就摆在模型面前。
        assert.ok(toolNamesPerRequest[0]?.includes('workbench__open_file'))
        assert.ok(toolNamesPerRequest[0]?.includes('workbench__explain_code'))
        assert.deepEqual(requests.map((request) => [request.sessionId, request.executionId, request.command]), [
          [
            'ui-session',
            'ui-run',
            { type: 'open-file', path: 'src/cache/store.ts', line: 2, column: 1, endLine: 3 },
          ],
        ])
        assert.match(prompts[1] ?? '', /opened/u)
      } finally {
        await stack.dispose()
      }
    })
  })
})
