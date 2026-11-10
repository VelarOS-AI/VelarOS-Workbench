import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { describe, test } from 'bun:test'

import type { ActAgentSummary, ActTurnTrace } from '@velaros-ai/velaros/contracts'

import { ConversationAgentBoard } from '../src/main/conversation/ConversationAgents'
import {
  applyWorkbenchConversationNotice,
  withSettledWorkerThreads,
  type WorkbenchConversationTranscript,
} from '../src/renderer/src/runtime/conversation/workbenchConversationNotices'
import { workbenchWorkerTaskTitle } from '../src/renderer/src/runtime/conversation/workbenchWorkerPresentation'
import {
  createCoalescedChatPersistence,
  isSameIdentityList,
} from '../src/renderer/src/runtime/standaloneChatPersistence'
import {
  ConversationAgentNotice,
  type ConversationAgentProjection,
} from '../src/shared/workbenchConversation'

const Execution = 'exec-1'
test('worker task titles use a short first-line label and hide opaque identifiers', () => {
  assert.equal(workbenchWorkerTaskTitle('## 生产统计面板\n读取实际数据并实现面板'), '生产统计面板')
  assert.equal(workbenchWorkerTaskTitle('你负责 数据模块，包含采样和测试。'), '数据模块')
  assert.equal(workbenchWorkerTaskTitle('13a083ad-1234-5678-9abc-123456789abc'), '')
  assert.equal(workbenchWorkerTaskTitle('界'.repeat(60)), `${'界'.repeat(40)}…`)
})
const EmptyTranscript: WorkbenchConversationTranscript = {
  messages: [],
  workerThreads: [],
}

function agentSummary(overrides: Partial<ActAgentSummary> = {}): ActAgentSummary {
  return {
    id: 'job-1',
    sessionId: 'job-1-session',
    executionId: Execution,
    profile: 'worker',
    task: '\n  审计 Project 事务核心\n先读 src/core',
    status: 'running',
    error: null,
    answer: '',
    answerTruncated: false,
    durationMs: null,
    ...overrides,
  }
}

/** 追踪里子 Agent 线程只读回合身份与子任务列表。 */
function turnTrace(turnId: string, agents: readonly ActAgentSummary[]): ActTurnTrace {
  return { turnId, agents } as Pick<ActTurnTrace, 'turnId' | 'agents'> as ActTurnTrace
}

/** 主进程的子 Agent 账：发出的每条通知都记下来，会话面按到达顺序归约成线程卡。 */
function createBoard(): {
  board: ConversationAgentBoard
  emitted: ConversationAgentProjection[]
  threads: () => WorkbenchConversationTranscript['workerThreads']
} {
  const emitted: ConversationAgentProjection[] = []
  return {
    board: new ConversationAgentBoard((projection) => emitted.push(projection)),
    emitted,
    threads: () =>
      emitted.reduce(
        (transcript, projection) =>
          applyWorkbenchConversationNotice(transcript, ConversationAgentNotice, projection),
        EmptyTranscript
      ).workerThreads,
  }
}

function anchorOf(executionId: string): string {
  return `conversation:script:run-1:turn-1:${executionId}`
}

test('cold worker activity keeps phase time and separates a same-run continuation', () => {
  const { board, emitted } = createBoard()
  board.trace(turnTrace('parent', [agentSummary({ startedAt: 3000 })]), anchorOf)
  assert.equal(emitted[0]!.startedAt, 3000)
  const item = (turnId: string, timestamp: number, text: string) => ({
    kind: 'conversation-text' as const,
    timestamp,
    payload: {
      id: `conversation:shared-run:${turnId}`,
      runId: 'shared-run',
      turnId,
      phase: 'accepted' as const,
      text,
    },
  })
  const projection = {
    ...emitted[0]!,
    activity: [item('old', 1000, 'Old completed result'), item('new', 3200, 'Current result')],
  }
  const state = applyWorkbenchConversationNotice(
    EmptyTranscript,
    ConversationAgentNotice,
    projection
  )
  const thread = state.workerThreads[0]!
  assert.deepEqual(
    thread.messages.map((message) => message.timestamp),
    [1000, 3200]
  )
  assert.equal(new Set(thread.messages.map((message) => message.id)).size, 2)
  assert.deepEqual(
    applyWorkbenchConversationNotice(state, ConversationAgentNotice, projection).workerThreads[0]!
      .messages,
    thread.messages
  )
  const cold = {
    ...state,
    workerThreads: state.workerThreads.map((value) => ({ ...value, messages: [] })),
  }
  assert.deepEqual(
    applyWorkbenchConversationNotice(cold, ConversationAgentNotice, projection).workerThreads[0]!
      .messages,
    thread.messages
  )
  const unknown = applyWorkbenchConversationNotice(EmptyTranscript, ConversationAgentNotice, {
    ...projection,
    activity: [item('legacy', 0, 'Unknown old result')],
  })
  assert.equal(unknown.workerThreads[0]!.messages[0]!.timestamp, 0)
})

void describe('Workbench sub-agent threads', () => {
  void test('each dispatch or resume the main process reports becomes its own card, updated in place', () => {
    const { board, emitted, threads } = createBoard()
    board.trace(turnTrace('turn-1', [agentSummary()]), anchorOf)
    board.trace(
      turnTrace('turn-1', [
        agentSummary({
          status: 'completed',
          answer: '三处高风险',
          durationMs: 900,
        }),
        // 同一个子任务续跑：这段执行里的第二段，另起一张卡。
        agentSummary({ task: '复核第二处' }),
      ]),
      anchorOf
    )

    assert.deepEqual(
      threads().map((thread) => [thread.threadId, thread.title, thread.status, thread.output]),
      [
        ['conversation:agent:exec-1:job-1:0', '审计 Project 事务核心', 'completed', '三处高风险'],
        ['conversation:agent:exec-1:job-1:1', '复核第二处', 'running', null],
      ]
    )
    const [first] = threads()
    assert.deepEqual(threads().map((thread) => thread.agentId), ['job-1', 'job-1'])
    // 卡挂在派发它的脚本卡后面；点开看完整任务；原位更新时开始时刻不变。
    assert.equal(first?.anchorId, anchorOf(Execution))
    assert.equal(first?.input, '\n  审计 Project 事务核心\n先读 src/core')
    assert.equal(first?.subagentType, 'worker')
    assert.equal(first?.startedAt, emitted[0]?.startedAt)
    assert.deepEqual(first?.messages, [])
  })

  void test('a trace that changes nothing sends nothing', () => {
    const { board, emitted } = createBoard()
    board.trace(turnTrace('turn-1', [agentSummary()]), anchorOf)
    board.trace(turnTrace('turn-1', [agentSummary()]), anchorOf)

    assert.equal(emitted.length, 1)
  })

  void test('maps sub-task states onto card states and keeps the failure reason', () => {
    const { board, threads } = createBoard()
    board.trace(
      turnTrace('turn-1', [
        agentSummary({ id: 'waiting', status: 'waiting' }),
        agentSummary({ id: 'cancelled', status: 'cancelled' }),
        agentSummary({ id: 'interrupted', status: 'interrupted' }),
        agentSummary({ id: 'failed', status: 'failed', error: '模型不可用' }),
      ]),
      () => null
    )

    assert.deepEqual(
      threads().map((thread) => [thread.status, thread.error, 'anchorId' in thread]),
      [
        ['awaiting_input', null, false],
        ['aborted', null, false],
        ['aborted', null, false],
        ['failed', '模型不可用', false],
      ]
    )
  })

  void test('threads still running when the run ends settle as aborted on both sides', () => {
    const { board, emitted, threads } = createBoard()
    board.trace(
      turnTrace('turn-2', [
        agentSummary({ id: 'running' }),
        agentSummary({ id: 'waiting', status: 'waiting' }),
        agentSummary({ id: 'done', status: 'completed', answer: '完成' }),
      ]),
      anchorOf
    )
    // 子任务还在后台跑：主进程定时重读它所在的回合。
    assert.deepEqual(board.pendingTurns(), ['turn-2'])

    // 收尾通知没送到的线程，会话面收尾时自己按中断收掉。
    assert.deepEqual(
      withSettledWorkerThreads(threads()).map((thread) => thread.status),
      ['aborted', 'aborted', 'completed']
    )

    board.settle()
    assert.equal(emitted.length, 5)
    assert.deepEqual(
      threads().map((thread) => thread.status),
      ['aborted', 'aborted', 'completed']
    )
    assert.deepEqual(board.pendingTurns(), [])
  })
})

void describe('coalesced chat history persistence', () => {
  function createHarness(signatureOf: () => readonly unknown[]) {
    const writes: string[] = []
    const timers: Array<() => void> = []
    const persistence = createCoalescedChatPersistence<string>({
      delayMs: 1_000,
      readSignature: signatureOf,
      write: (key) => writes.push(key),
      setTimer: (callback) => {
        timers.push(callback)
        return timers.length
      },
      clearTimer: () => {},
    })
    return { writes, timers, persistence }
  }

  void test('many updates inside one window become one write', () => {
    let messages: unknown[] = []
    const { writes, timers, persistence } = createHarness(() => [messages])
    for (let token = 0; token < 50; token += 1) {
      messages = [...messages, token]
      persistence.schedule('project-a', 'project-a')
    }
    assert.equal(writes.length, 0)
    assert.equal(timers.length, 1)
    timers[0]!()
    assert.deepEqual(writes, ['project-a'])
  })

  void test('updates that leave the persisted fields untouched are not written again', () => {
    const messages: unknown[] = ['stable']
    const { writes, persistence } = createHarness(() => [messages])
    persistence.schedule('project-a', 'project-a', { immediate: true })
    // 子 Agent 线程、上下文用量这类只在内存里的更新：落盘字段一个没换引用。
    persistence.schedule('project-a', 'project-a', { immediate: true })
    persistence.flush()
    assert.deepEqual(writes, ['project-a'])
  })

  void test('an immediate write also flushes other pending projects', () => {
    let revision = 0
    const { writes, persistence } = createHarness(() => [revision])
    persistence.schedule('project-a', 'project-a')
    revision += 1
    persistence.schedule('project-b', 'project-b', { immediate: true })
    assert.deepEqual(writes, ['project-a', 'project-b'])
  })

  void test('compares identity lists element by element', () => {
    const shared = {}
    assert.equal(isSameIdentityList([shared, 1, null], [shared, 1, null]), true)
    assert.equal(isSameIdentityList([{}], [{}]), false)
    assert.equal(isSameIdentityList([1], [1, 2]), false)
  })
})

function readSource(relativePath: string): string {
  return readFileSync(path.resolve(process.cwd(), relativePath), 'utf8')
}

void describe('streaming stays cheap for the rest of the page', () => {
  void test('state updates only schedule persistence; a finished run is written right away', () => {
    const adapter = readSource('src/renderer/src/runtime/standaloneWorkbenchChatAdapter.tsx')
    const persistState = adapter.slice(
      adapter.indexOf('function persistState('),
      adapter.indexOf('function flushChatPersistence(')
    )

    const finishRun = adapter.slice(
      adapter.indexOf('function finishRun('),
      adapter.indexOf('function settleTerminalMessages(')
    )

    assert.match(persistState, /chatPersistence\.schedule\(/u)
    assert.doesNotMatch(persistState, /JSON\.stringify|localStorage/u)
    // 一轮收尾时回答已经完整：立刻落盘，不等合并窗口。
    assert.match(
      finishRun,
      /run\.settleTerminal\(terminalKind\)\n(?:\s*\/\/[^\n]*\n)*\s*flushChatPersistence\(\)/u
    )
    // 退出、刷新、切到后台前把没写的补上。
    assert.match(adapter, /window\.addEventListener\('pagehide', flushChatPersistence\)/u)
    assert.match(adapter, /window\.addEventListener\('beforeunload', flushChatPersistence\)/u)
  })

  void test('the page-level chat runtime ignores streamed content', () => {
    const adapter = readSource('src/renderer/src/runtime/standaloneWorkbenchChatAdapter.tsx')
    const projectRuntime = adapter.slice(
      adapter.indexOf('function useStandaloneProjectRuntime('),
      adapter.indexOf('function buildStandaloneProjectRuntime(')
    )
    const viewFields = adapter.slice(
      adapter.indexOf('function readProjectRuntimeFieldIdentities('),
      adapter.indexOf('function toSnapshot(')
    )

    assert.match(projectRuntime, /readStandaloneProjectRuntimeView\(normalizedRoot\)/u)
    assert.doesNotMatch(projectRuntime, /useStandaloneChatState/u)
    // 视图只认会话级字段：消息条数有没有、运行起止、运行标记——不认消息内容。
    assert.doesNotMatch(viewFields, /state\.messages,|state\.revision/u)
  })

  void test('sub-agent threads belong to one run and stay out of the saved history', () => {
    const adapter = readSource('src/renderer/src/runtime/standaloneWorkbenchChatAdapter.tsx')
    const persistedFields = adapter.slice(
      adapter.indexOf('function readPersistedFieldIdentities('),
      adapter.indexOf('function releaseRemovedSession(')
    )

    // 新的一轮开跑时清空上一轮的线程卡；线程卡不落盘。
    assert.match(adapter, /\/\/ 子 Agent 线程随轮次归零[^\n]*\n\s*workerThreads: \[\],/u)
    assert.doesNotMatch(persistedFields, /workerThreads/u)
  })

  void test('sub-agent cards show the task and then the answer, or the chat transcript when there is one', () => {
    const panel = readSource('src/renderer/src/runtime/conversation/WorkbenchWorkerThreadPanel.tsx')
    const slots = readSource(
      'src/renderer/src/runtime/conversation/standaloneWorkbenchConversationRenderSlots.tsx'
    )

    assert.match(panel, /\{thread\.input\}/u)
    assert.match(panel, /<ChatTranscript\n\s*messages=\{thread\.messages\}/u)
    assert.match(
      slots,
      /<WorkbenchWorkerThreadPanel threads=\{threads\} sessionId=\{sessionId\} \/>/u
    )
  })
})

void test('child traces preserve execution results, names and model across updates and resume', async () => {
  const emitted: ConversationAgentProjection[] = []
  const board = new ConversationAgentBoard(
    (value) => emitted.push(value),
    () => 'velar-dev/gpt-5.6-sol'
  )
  board.trace(turnTrace('parent', [agentSummary()]), anchorOf)
  const child = {
    runId: 'child-run',
    agents: [],
    turnId: 'child-turn',
    request: { sequence: 2, createdAt: new Date(1000).toISOString() },
    executions: [
      {
        executionId: 'child-exec',
        position: 0,
        status: 'succeeded',
        source: '// check source\nconsole.log(42)',
        failure: null,
        durationMs: 10,
        processOutput: '42'.repeat(4000),
      },
    ],
    invocations: [],
    observation: {},
    records: [
      {
        title: 'act:event',
        body: JSON.stringify({ type: 'accepted', text: '审查完成' }),
      },
    ],
  } as unknown as ActTurnTrace
  let reads = 0
  await board.refresh(async (query) => {
    reads++
    assert.equal(query?.sessionId, 'job-1-session')
    return { turns: [child], nextAfter: null } as never
  })
  assert(emitted.at(-1)!.activity!.every((item) => item.timestamp === 1000))
  board.trace(
    turnTrace('parent', [agentSummary({ status: 'completed', answer: '已完成' })]),
    anchorOf
  )
  await board.refresh(async () => ({ turns: [child], nextAfter: null }) as never)
  await board.refresh(async () => {
    throw Error('settled thread must not be read again')
  })
  board.trace(
    turnTrace('parent-next', [
      agentSummary({ executionId: 'exec-2', task: '再检查一次' }),
      agentSummary({ id: 'job-2', executionId: 'exec-2' }),
    ]),
    anchorOf
  )
  const state = emitted.reduce(
    (state, payload) => applyWorkbenchConversationNotice(state, ConversationAgentNotice, payload),
    EmptyTranscript
  )
  assert.equal(reads, 1)
  assert.equal(state.workerThreads[0].agentName, state.workerThreads[1].agentName)
  assert.notEqual(state.workerThreads[1].agentName, state.workerThreads[2].agentName)
  assert.equal(state.workerThreads[0].model, 'velar-dev/gpt-5.6-sol')
  const restored = JSON.parse(JSON.stringify(state)) as WorkbenchConversationTranscript
  assert.equal(restored.workerThreads[0].agentId, 'job-1')
  assert.equal(restored.workerThreads[0].status, 'completed')
  assert(
    restored.workerThreads[0].messages.some((message) =>
      message.blocks.some(
        (block) =>
          block.type === 'script-execution' &&
          block.calls.some((call) => call.output === '42'.repeat(3000) && call.outputTruncated)
      )
    )
  )
  assert(
    restored.workerThreads[0].messages.some((message) =>
      message.blocks.some((block) => block.type === 'text' && block.text === '审查完成')
    )
  )
})

void test('resumed child history retains run timestamps and an interrupted task title after persistence', () => {
  const activity = (
    runId: string
  ): NonNullable<ConversationAgentProjection['activity']>[number] => ({
    kind: 'conversation-text',
    payload: {
      id: `conversation:${runId}`,
      runId,
      turnId: `turn:${runId}`,
      phase: 'accepted',
      text: runId,
    },
  })
  const original: ConversationAgentProjection = {
    id: 'conversation:agent:original-card',
    agentId: 'same-agent',
    anchorId: null,
    task: '审计缓存命中率',
    profile: 'worker',
    model: 'gpt-6-astra',
    status: 'aborted',
    answer: '',
    error: null,
    startedAt: 100,
    updatedAt: 150,
    activity: [activity('old-run')],
  }
  let state = applyWorkbenchConversationNotice(EmptyTranscript, ConversationAgentNotice, original)
  state = JSON.parse(JSON.stringify(state)) as WorkbenchConversationTranscript
  const resumed: ConversationAgentProjection = {
    ...original,
    id: 'conversation:agent:resumed-card',
    task: '继续完成',
    status: 'running',
    startedAt: 200,
    updatedAt: 210,
    activity: [activity('old-run'), activity('new-run')],
  }
  state = applyWorkbenchConversationNotice(state, ConversationAgentNotice, resumed)
  assert.equal(state.workerThreads[1]!.title, '审计缓存命中率')
  assert.equal(state.workerThreads[1]!.agentName, state.workerThreads[0]!.agentName)
  assert.deepEqual(
    state.workerThreads[1]!.messages.map((message) => message.timestamp),
    [100, 200]
  )
  state = JSON.parse(JSON.stringify(state)) as WorkbenchConversationTranscript
  state = applyWorkbenchConversationNotice(state, ConversationAgentNotice, {
    ...resumed,
    model: undefined,
    task: '只更新状态',
    updatedAt: 300,
  })
  assert.equal(state.workerThreads[1]!.title, '审计缓存命中率')
  assert.equal(state.workerThreads[1]!.model, 'gpt-6-astra')
  assert.deepEqual(
    state.workerThreads[1]!.messages.map((message) => message.timestamp),
    [100, 200]
  )

  state = applyWorkbenchConversationNotice(state, ConversationAgentNotice, {
    ...resumed,
    status: 'completed',
  })
  state = applyWorkbenchConversationNotice(state, ConversationAgentNotice, {
    ...resumed,
    id: 'conversation:agent:new-task-card',
    task: '核对浏览器数据',
    startedAt: 400,
    activity: [activity('old-run'), activity('new-run'), activity('third-run')],
  })
  assert.equal(state.workerThreads[2]!.title, '核对浏览器数据')
  assert.deepEqual(
    state.workerThreads[2]!.messages.map((message) => message.timestamp),
    [100, 200, 400]
  )
})

void test('child history pagination publishes one complete activity snapshot without per-script intermediate updates', async () => {
  const { board, emitted } = createBoard()
  board.trace(turnTrace('parent', [agentSummary()]), anchorOf)
  const pages = Array.from({ length: 3 }, (_, page) => ({
    runId: `child-run-${page}`,
    turnId: `child-turn-${page}`,
    agents: [],
    request: { sequence: page * 32 + 2 },
    invocations: [],
    observation: {},
    executions: Array.from({ length: 4 }, (_, position) => ({
      executionId: `exec-${page}-${position}`,
      position,
      status: 'succeeded',
      source: '// 完成检查\nconsole.log(42)',
      failure: null,
      durationMs: 10,
    })),
    records: [
      { title: 'act:event', body: JSON.stringify({ type: 'accepted', text: `page ${page}` }) },
    ],
  }))
  let reads = 0
  await board.refresh(async (query) => {
    assert.equal(query?.after, reads * 32)
    const trace = pages[reads++]!
    return { turns: [trace], nextAfter: reads < 3 ? reads * 32 : null } as never
  })
  assert.equal(reads, 3)
  assert.equal(emitted.length, 2)
  assert.equal(emitted[1]!.activity!.length, 15)
  await board.refresh(async () => ({ turns: [pages[2]], nextAfter: null }) as never)
  assert.equal(emitted.length, 2)
})

void test('failed agent publication can retry both first dispatch and an identical status update', () => {
  const emitted: ConversationAgentProjection[] = []
  let reject = true
  const board = new ConversationAgentBoard((value) => {
    if (reject) throw Error('delivery failed')
    emitted.push(value)
  })
  const running = turnTrace('parent', [agentSummary()])
  assert.throws(() => board.trace(running, anchorOf), /delivery failed/)
  reject = false
  board.trace(running, anchorOf)
  assert.equal(emitted.length, 1)
  const completed = turnTrace('parent', [agentSummary({ status: 'completed' })])
  reject = true
  assert.throws(() => board.trace(completed, anchorOf), /delivery failed/)
  reject = false
  board.trace(completed, anchorOf)
  assert.equal(emitted.length, 2)
  assert.equal(emitted[1]!.status, 'completed')
})

void test('failed child history publication preserves the read cursor and retries settled history', async () => {
  const emitted: ConversationAgentProjection[] = []
  let reject = false
  const board = new ConversationAgentBoard((value) => {
    if (reject) throw Error('history delivery failed')
    emitted.push(value)
  })
  board.trace(turnTrace('parent', [agentSummary({ status: 'completed' })]), anchorOf)
  let reads = 0
  const read = async (query: { after?: number } = {}) => {
    reads++
    assert.equal(query.after, 0)
    return {
      turns: [
        {
          runId: 'child-run',
          turnId: 'child-turn',
          agents: [],
          request: { sequence: 2 },
          invocations: [],
          observation: {},
          executions: [
            {
              executionId: 'child-execution',
              position: 0,
              status: 'succeeded',
              source: '// 保存结果\nconsole.log(42)',
              failure: null,
              durationMs: 10,
            },
          ],
          records: [
            { title: 'act:event', body: JSON.stringify({ type: 'accepted', text: '完成' }) },
          ],
        },
      ],
      nextAfter: null,
    } as never
  }
  reject = true
  await assert.rejects(board.refresh(read), /history delivery failed/)
  reject = false
  await board.refresh(read)
  assert.equal(reads, 2)
  assert.equal(emitted.length, 2)
  assert.equal(emitted[1]!.activity!.length, 2)
  await board.refresh(async () => {
    throw Error('settled history must not be read again')
  })
})

void test('a later child history page failure publishes the partial history and retries without losing it', async () => {
  const { board, emitted } = createBoard()
  board.trace(turnTrace('parent', [agentSummary()]), anchorOf)
  const trace = (index: number) => ({
    runId: `child-run-${index}`,
    turnId: `child-turn-${index}`,
    agents: [],
    request: { sequence: index * 32 + 2 },
    invocations: [],
    observation: {},
    executions: [],
    records: [
      { title: 'act:event', body: JSON.stringify({ type: 'accepted', text: `page ${index}` }) },
    ],
  })
  let reject = true
  const cursors: number[] = []
  const read = async (query: { after?: number } = {}) => {
    const after = query.after ?? 0
    cursors.push(after)
    if (after === 32 && reject) throw Error('page unavailable')
    return { turns: [trace(after / 32)], nextAfter: after === 0 ? 32 : null } as never
  }
  await assert.rejects(board.refresh(read), /page unavailable/)
  assert.equal(emitted.length, 2)
  assert.equal(emitted[1]!.activity!.length, 1)
  reject = false
  await board.refresh(read)
  assert.deepEqual(cursors, [0, 32, 0, 32])
  assert.equal(emitted.length, 3)
  assert.equal(emitted[2]!.activity!.length, 2)
})

void test('usage retries failed delivery for parent and descendants without double counting', async () => {
  const usage: Array<{
    requestId?: string
    agentRole?: string
    inputTokens: number | null
  }> = []
  let failNextUsage = true
  const board = new ConversationAgentBoard(
    () => {},
    () => 'provider/model',
    (value) => {
      if (failNextUsage) {
        failNextUsage = false
        throw Error('usage delivery failed')
      }
      usage.push(value)
    }
  )
  const accounting = {
    status: 'settled',
    outcome: 'accepted',
    finishReason: 'stop',
    error: null,
    usage: {
      coverage: 'known',
      inputTokens: 100,
      outputTokens: 5,
      cacheReadTokens: 80,
      cacheWriteTokens: null,
    },
  }
  const trace = (sessionId: string, children: ActAgentSummary[]) =>
    ({
      sessionId,
      runId: `${sessionId}-run`,
      turnId: `${sessionId}-turn`,
      turn: 1,
      request: { sequence: 2, createdAt: '2026-10-31T00:00:00Z' },
      requestSummary: { model: 'provider/model' },
      modelAccounting: accounting,
      agents: children,
      executions: [],
      invocations: [],
      records: [],
      observation: {},
    }) as unknown as ActTurnTrace
  const root = trace('root', [agentSummary()])
  assert.throws(() => board.trace(root, anchorOf), /usage delivery failed/)
  board.trace(root, anchorOf)
  const child = trace('job-1-session', [agentSummary({ sessionId: 'grandchild' })])
  const grandchild = trace('grandchild', [])
  const read = async (query?: { sessionId?: string }) =>
    ({
      turns: [query?.sessionId === 'grandchild' ? grandchild : child],
      nextAfter: null,
    }) as never
  failNextUsage = true
  await assert.rejects(board.refresh(read), /usage delivery failed/)
  await board.refresh(read)
  board.trace(root, anchorOf)
  await board.refresh(read)
  assert.equal(usage.length, 3)
  assert.equal(usage.filter((value) => value.agentRole === 'child').length, 2)
  assert.equal(
    usage.reduce((sum, value) => sum + (value.inputTokens ?? 0), 0),
    300
  )
})
