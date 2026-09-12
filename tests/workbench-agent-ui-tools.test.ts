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

/** 假审批通道：记下每次征询，按给定答案放行或拒绝。 */
function createFakeApproval(approved = true) {
  const asked: Array<{ message: string; riskScope?: string; approvalRisk?: string }> = []
  return {
    asked,
    port: {
      awaitConfirmation: async () => undefined,
      awaitConfirmationDecision: async (
        message: string,
        _signal?: AbortSignal,
        options?: { riskScope?: string; approvalRisk?: string }
      ) => {
        asked.push({ message, riskScope: options?.riskScope, approvalRisk: options?.approvalRisk })
        return { approved, message: approved ? null : '先别跑' }
      },
    },
  }
}

function toolContext(
  root: string,
  ui?: ReturnType<typeof createFakeUi>,
  approval: ReturnType<typeof createFakeApproval> = createFakeApproval()
) {
  return {
    resourceId: root,
    abortSignal: new AbortController().signal,
    approval: approval.port,
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
      // 文件以换行结尾：编辑器里是 5 行（最后一行为空），选区只夹到最后一个有内容的第 4 行；
      // endLine 是一段 AI 选区的简写。
      assert.deepEqual(result, {
        opened: [{ path: 'src/cache/store.ts', line: 2, highlights: ['src/cache/store.ts:2-4'] }],
      })
      assert.deepEqual(ui.commands, [
        {
          type: 'open-files',
          files: [{ path: 'src/cache/store.ts', line: 2, column: 1, highlights: [{ startLine: 2, endLine: 4 }] }],
        },
      ])

      await openFile.execute({ path: join(root, 'README.md') }, toolContext(root, ui) as never)
      assert.deepEqual(ui.commands.at(-1), {
        type: 'open-files',
        files: [{ path: 'README.md', line: 1, column: 1, highlights: [] }],
      })

      // 只开一个文件、它又开不了：照实报错。
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
      assert.equal(ui.commands.length, 2)

      // 跳转行越界：夹到最后一行并说明，而不是打回。
      const clamped = await openFile.execute(
        { path: 'src/cache/store.ts', line: 40 },
        toolContext(root, ui) as never
      )
      assert.deepEqual(clamped, {
        opened: [{ path: 'src/cache/store.ts', line: 5 }],
        notes: ['src/cache/store.ts has only 5 lines; jumped to line 5 instead of 40.'],
      })
    })
  })

  void test('open_file tolerates loose batches: skips what it cannot open and says so', async () => {
    await withProject(async (root) => {
      for (let index = 0; index < 13; index += 1)
        await writeFile(join(root, `f${index}.ts`), `export const f${index} = ${index}\n`, 'utf8')
      const openFile = findTool('workbench:open_file')

      // highlights: [] 当作不标；顶层 path 与 files 同时给时，顶层那一项排第一。
      const merged = createFakeUi()
      assert.deepEqual(
        await openFile.execute(
          { path: 'README.md', highlights: [], files: [{ path: 'src/cache/store.ts', line: 2 }] },
          toolContext(root, merged) as never
        ),
        {
          opened: [
            { path: 'README.md', line: 1 },
            { path: 'src/cache/store.ts', line: 2 },
          ],
          notes: ['Both path and files were given; README.md was opened as the first file.'],
        }
      )

      // 打不开的文件、越界的选区各自跳过，同一批里其余的照开；同一文件第一次没给行号时停在第一段选区。
      const loose = createFakeUi()
      const result = await openFile.execute(
        {
          files: [
            { path: 'src/cache/store.ts' },
            { path: 'missing.ts', highlights: [{ startLine: 1 }] },
            { path: './src/cache/store.ts', highlights: [{ startLine: 40 }, { startLine: 3, endLine: 4 }] },
          ],
        },
        toolContext(root, loose) as never
      )
      assert.deepEqual(loose.commands, [
        {
          type: 'open-files',
          files: [{ path: 'src/cache/store.ts', line: 3, column: 1, highlights: [{ startLine: 3, endLine: 4 }] }],
        },
      ])
      assert.deepEqual(result, {
        opened: [{ path: 'src/cache/store.ts', line: 3, highlights: ['src/cache/store.ts:3-4'] }],
        failed: [{ path: 'missing.ts', reason: 'missing.ts does not exist in the project.' }],
        notes: ['src/cache/store.ts has only 5 lines; the selection starting at line 40 was skipped.'],
      })

      // 超过上限的文件截掉并说明；编辑器读不出来的文件从 opened 挪到 failed。
      const capped = createFakeUi((command) =>
        command.type === 'open-files'
          ? { opened: command.files.slice(1).map((file) => file.path), failed: ['f0.ts'] }
          : {}
      )
      const cappedResult = (await openFile.execute(
        { files: Array.from({ length: 13 }, (_, index) => ({ path: `f${index}.ts` })) },
        toolContext(root, capped) as never
      )) as { opened: Array<{ path: string }>; failed: unknown[]; notes: string[] }
      const sent = capped.commands[0]
      assert.equal(sent?.type === 'open-files' ? sent.files.length : 0, 12)
      assert.equal(cappedResult.opened.length, 11)
      assert.deepEqual(cappedResult.failed, [{ path: 'f0.ts', reason: 'The editor could not read this file.' }])
      assert.deepEqual(cappedResult.notes, ['Only the first 12 files were opened; skipped f12.ts.'])
    })
  })

  void test('open_file opens a batch of files with several AI selections, ending on the first file', async () => {
    await withProject(async (root) => {
      const ui = createFakeUi()
      const openFile = findTool('workbench:open_file')

      const result = await openFile.execute(
        {
          files: [
            { path: 'src/cache/store.ts', highlights: [{ startLine: 3, endLine: 4 }, { startLine: 1 }] },
            { path: 'README.md' },
            { path: './src/cache/store.ts', highlights: [{ startLine: 5, endLine: 9 }] },
          ],
        },
        toolContext(root, ui) as never
      )
      // 没给 line 时停在第一段选区；同一个文件出现两次合成一项。
      assert.deepEqual(ui.commands, [
        {
          type: 'open-files',
          files: [
            {
              path: 'src/cache/store.ts',
              line: 3,
              column: 1,
              highlights: [
                { startLine: 3, endLine: 4 },
                { startLine: 1, endLine: 1 },
                { startLine: 5, endLine: 5 },
              ],
            },
            { path: 'README.md', line: 1, column: 1, highlights: [] },
          ],
        },
      ])
      assert.deepEqual(result, {
        opened: [
          {
            path: 'src/cache/store.ts',
            line: 3,
            highlights: ['src/cache/store.ts:3-4', 'src/cache/store.ts:1', 'src/cache/store.ts:5'],
          },
          { path: 'README.md', line: 1 },
        ],
      })
      await assert.rejects(
        Promise.resolve(openFile.execute({}, toolContext(root, ui) as never)),
        /Pass files/u
      )
    })
  })

  void test('clear_highlights cancels AI selections for the whole project or for some files', async () => {
    await withProject(async (root) => {
      const ui = createFakeUi()
      const clear = findTool('workbench:clear_highlights')

      await clear.execute({}, toolContext(root, ui) as never)
      await clear.execute({ paths: [] }, toolContext(root, ui) as never)
      const partial = await clear.execute(
        { paths: ['src/cache/store.ts', './src/cache/store.ts', join(root, 'src/deleted.ts'), '../escape.ts'] },
        toolContext(root, ui) as never
      )
      assert.deepEqual(ui.commands, [
        { type: 'clear-highlights', paths: null },
        // 空数组与不给一样：全部取消。
        { type: 'clear-highlights', paths: null },
        // 不要求文件还在：被删掉的文件上的选区也要能取消。项目外的路径忽略并说明。
        { type: 'clear-highlights', paths: ['src/cache/store.ts', 'src/deleted.ts'] },
      ])
      assert.deepEqual(partial, { ignored: ['../escape.ts'] })
      // 给的路径全在项目外：一个也不取消，而不是退回「全部取消」。
      assert.deepEqual(await clear.execute({ paths: ['../escape.ts'] }, toolContext(root, ui) as never), {
        cleared: 0,
        ignored: ['../escape.ts'],
      })
      assert.equal(ui.commands.length, 3)
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

void describe('Workbench agent run, preview and problems tools', () => {
  void test('start_run asks before dangerous commands and hands ordinary ones to the permission mode', async () => {
    await withProject(async (root) => {
      const startRun = findTool('workbench:start_run')
      const ui = createFakeUi((command) =>
        command.type === 'start-run' ? { sessionId: 'run-1' } : {}
      )

      // 危险命令不再直接拒绝，而是先问；用户不同意就什么都不启动，把原因交给模型。
      const dangerousApproval = createFakeApproval(false)
      assert.deepEqual(
        await startRun.execute({ command: 'rm -rf /' }, toolContext(root, ui, dangerousApproval) as never),
        { started: false, command: 'rm -rf /', message: '先别跑' }
      )
      assert.deepEqual(dangerousApproval.asked.map(({ riskScope, approvalRisk }) => ({ riskScope, approvalRisk })), [
        { riskScope: 'workbench-run:dangerous', approvalRisk: 'high' },
      ])
      assert.match(dangerousApproval.asked[0]?.message ?? '', /高风险命令：rm -rf \//u)

      // 只读命令不打扰用户；返回会话 id 给后续 read_run / stop_run。
      const approval = createFakeApproval()
      assert.deepEqual(
        await startRun.execute({ command: 'git status' }, toolContext(root, ui, approval) as never),
        { started: true, sessionId: 'run-1', command: 'git status' }
      )
      assert.deepEqual(approval.asked, [])

      // 可能改动项目的日常命令按低风险交给权限档（标准档由策略直接放行，见 workbench-command-approval）。
      await startRun.execute({ command: 'npm run dev', label: '开发服务器' }, toolContext(root, ui, approval) as never)
      assert.deepEqual(approval.asked, [
        { message: '在底部「运行」面板里运行：npm run dev', riskScope: 'workbench-run:command', approvalRisk: 'low' },
      ])
      assert.deepEqual(ui.commands.filter((command) => command.type === 'start-run'), [
        { type: 'start-run', command: 'git status', label: 'git status' },
        { type: 'start-run', command: 'npm run dev', label: '开发服务器' },
      ])

      const declined = await startRun.execute(
        { command: 'npm install' },
        toolContext(root, ui, createFakeApproval(false)) as never
      )
      assert.deepEqual(declined, { started: false, command: 'npm install', message: '先别跑' })
      assert.equal(ui.commands.filter((command) => command.type === 'start-run').length, 2)
    })
  })

  void test('reading a run can wait for the output a dev server prints when it is ready', async () => {
    await withProject(async (root) => {
      let reads = 0
      const ui = createFakeUi((command) => {
        if (command.type === 'start-run') return { sessionId: 'run-dev' }
        if (command.type !== 'read-run') return {}
        reads += 1
        return {
          sessionId: 'run-dev',
          command: 'npm run dev',
          running: true,
          output: reads === 1 ? 'starting…' : 'Local: http://localhost:5173/',
          totalLines: reads,
          matched: reads > 1,
        }
      })

      const result = await findTool('workbench:start_run').execute(
        { command: 'npm run dev', waitFor: 'Local:', waitSeconds: 5 },
        toolContext(root, ui) as never
      )
      assert.equal((result as { matched?: boolean }).matched, true)
      assert.equal((result as { started?: boolean }).started, true)
      assert.equal(reads, 2)
      // 读输出盯住同一条运行，默认 60 行，按 waitFor 在整段输出里找。
      assert.deepEqual(ui.commands.filter((command) => command.type === 'read-run')[0], {
        type: 'read-run',
        sessionId: 'run-dev',
        lines: 60,
        match: 'Local:',
      })

      // 不等待时读一次就回；进程已经退出也立刻回。
      reads = 0
      assert.equal(findTool('workbench:read_run').schema.safeParse({ lines: 500 }).success, false)
      const once = await findTool('workbench:read_run').execute({ lines: 20 }, toolContext(root, ui) as never)
      assert.equal((once as { output?: string }).output, 'starting…')
      assert.deepEqual(ui.commands.at(-1), { type: 'read-run', sessionId: null, lines: 20, match: null })

      assert.deepEqual(
        await findTool('workbench:stop_run').execute({ sessionId: 'run-dev' }, toolContext(root, ui) as never),
        { stopped: true, sessionId: 'run-dev' }
      )
    })
  })

  void test('open_preview only opens local development servers', async () => {
    await withProject(async (root) => {
      const ui = createFakeUi((command) => (command.type === 'open-preview' ? { opened: 'workbench-browser' } : {}))
      const openPreview = findTool('workbench:open_preview')
      for (const url of [
        'http://localhost:5173/',
        'http://127.0.0.1:3000/docs',
        'http://192.168.1.20:8080',
        'https://app.localhost/',
        'http://[::1]:4000/',
      ]) {
        const result = (await openPreview.execute({ url }, toolContext(root, ui) as never)) as { opened?: string }
        assert.equal(result.opened, 'workbench-browser', url)
      }
      for (const [url, pattern] of [
        ['https://example.com/', /Only local development servers/u],
        ['http://8.8.8.8/', /Only local development servers/u],
        ['file:///etc/passwd', /Only http\(s\)/u],
        ['not a url', /not a valid address/u],
      ] as const) {
        await assert.rejects(
          Promise.resolve(openPreview.execute({ url }, toolContext(root, ui) as never)),
          pattern,
          url
        )
      }
    })
  })

  void test('get_problems resolves the files in the project before asking the language service', async () => {
    await withProject(async (root) => {
      const ui = createFakeUi(() => ({ files: [], errors: 0, warnings: 0 }))
      const getProblems = findTool('workbench:get_problems')
      await getProblems.execute(
        { paths: ['./src/cache/store.ts', 'src/cache/store.ts', 'README.md'], show: true },
        toolContext(root, ui) as never
      )
      await getProblems.execute({}, toolContext(root, ui) as never)
      assert.deepEqual(ui.commands, [
        { type: 'read-problems', paths: ['src/cache/store.ts', 'README.md'], show: true },
        { type: 'read-problems', paths: null, show: false },
      ])
      await assert.rejects(
        Promise.resolve(getProblems.execute({ paths: ['nope.ts'] }, toolContext(root, ui) as never)),
        /does not exist/u
      )
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
        assert.ok(toolNamesPerRequest[0]?.includes('workbench__start_run'))
        assert.deepEqual(requests.map((request) => [request.sessionId, request.executionId, request.command]), [
          [
            'ui-session',
            'ui-run',
            {
              type: 'open-files',
              files: [
                { path: 'src/cache/store.ts', line: 2, column: 1, highlights: [{ startLine: 2, endLine: 3 }] },
              ],
            },
          ],
        ])
        assert.match(prompts[1] ?? '', /opened/u)
      } finally {
        await stack.dispose()
      }
    })
  })
})
