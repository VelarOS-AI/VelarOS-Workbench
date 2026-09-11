import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { describe, test } from 'bun:test'

import {
  createCoalescedChatPersistence,
  isSameIdentityList,
} from '../src/renderer/src/runtime/standaloneChatPersistence'
import {
  applyStandaloneWorkerThreadEvent,
  createEmptyWorkerThreadProjection,
  type StandaloneWorkerThreadProjection,
} from '../src/renderer/src/runtime/standaloneWorkbenchWorkerThreads'

const Thread = 'subagent:forge'
const Activation = 'subagent:forge:activation:1'

function workerEvent(fields: Record<string, unknown>): Record<string, unknown> {
  return {
    kind: 'worker-thread',
    threadId: Thread,
    activationId: Activation,
    title: '审计 Project 事务核心',
    agentName: 'Forge',
    timestamp: 1_000,
    ...fields,
  }
}

function apply(
  events: ReadonlyArray<Record<string, unknown>>,
  projection: StandaloneWorkerThreadProjection = createEmptyWorkerThreadProjection()
): StandaloneWorkerThreadProjection {
  return events.reduce(applyStandaloneWorkerThreadEvent, projection)
}

function timelineBlocks(projection: StandaloneWorkerThreadProjection, index = 0): unknown[] {
  return projection.threads[index]!.messages.flatMap((message) => message.blocks)
}

void describe('Workbench sub-agent thread projection', () => {
  void test('streams text deltas into one growing answer instead of showing only the latest token', () => {
    const projection = apply([
      workerEvent({ event: 'status', status: 'running', input: 'audit the core', summary: '审计' }),
      workerEvent({ event: 'delta', text: '## 结论' }),
      // 单独的换行也是正文：丢掉它 markdown 段落就粘在一起。
      workerEvent({ event: 'delta', text: '\n\n' }),
      workerEvent({ event: 'delta', text: '事务状态机缺少幂等键。' }),
    ])

    const [thread] = projection.threads
    assert.equal(thread?.output, '## 结论\n\n事务状态机缺少幂等键。')
    assert.deepEqual(timelineBlocks(projection), [
      { type: 'text', text: '## 结论\n\n事务状态机缺少幂等键。' },
    ])
    assert.equal(thread?.input, 'audit the core')
  })

  void test('lays out thinking, tool calls and text in arrival order, updating tools in place', () => {
    const projection = apply([
      workerEvent({ event: 'chat-event', chatEvent: { type: 'reasoning-delta', id: 'r1', text: '先看' } }),
      workerEvent({ event: 'chat-event', chatEvent: { type: 'reasoning-delta', id: 'r1', text: '目录' } }),
      workerEvent({
        event: 'chat-event',
        timestamp: 1_100,
        chatEvent: {
          type: 'tool-start',
          toolCallId: 'call-1',
          toolName: 'project:read',
          args: { path: 'src/core/project-kernel.ts' },
          categoryId: 'project-files',
        },
      }),
      workerEvent({ event: 'chat-event', chatEvent: { type: 'tool-progress', toolCallId: 'call-1', chunk: 'reading' } }),
      workerEvent({
        event: 'chat-event',
        timestamp: 1_200,
        chatEvent: { type: 'tool-done', toolCallId: 'call-1', result: { lines: 420 } },
      }),
      workerEvent({ event: 'delta', text: '读完了。' }),
    ])

    assert.deepEqual(timelineBlocks(projection), [
      { type: 'thinking', text: '先看目录', streamId: 'r1' },
      {
        type: 'tool-call',
        toolCallId: 'call-1',
        toolName: 'project:read',
        args: { path: 'src/core/project-kernel.ts' },
        categoryId: 'project-files',
        isRunning: false,
        startedAt: 1_100,
        progress: 'reading',
        result: { lines: 420 },
        effects: {},
        finishedAt: 1_200,
      },
      { type: 'text', text: '读完了。' },
    ])
  })

  void test('a resumed thread gets its own card; events without an activation id stay on the latest one', () => {
    const projection = apply([
      workerEvent({ event: 'delta', text: 'first pass' }),
      workerEvent({ event: 'status', status: 'completed' }),
      workerEvent({ activationId: 'subagent:forge:activation:2', event: 'status', status: 'running' }),
      { kind: 'worker-thread', threadId: Thread, title: 'x', event: 'delta', text: 'follow-up', timestamp: 2_000 },
    ])

    assert.deepEqual(
      projection.threads.map((thread) => [thread.activationId, thread.status, thread.output]),
      [
        [Activation, 'completed', 'first pass'],
        ['subagent:forge:activation:2', 'running', 'follow-up'],
      ]
    )
  })

  void test('status events keep the streamed answer and bring the final summary', () => {
    const projection = apply([
      workerEvent({ event: 'delta', text: '完整结论' }),
      workerEvent({
        event: 'status',
        status: 'completed',
        result: { summary: '三处高风险' },
      }),
    ])

    assert.equal(projection.threads[0]?.output, '完整结论')
    assert.equal(projection.threads[0]?.summary, '三处高风险')
  })

  void test('the same retry error in a row is recorded once', () => {
    const projection = apply([
      workerEvent({ event: 'status', status: 'running', error: 'rate limited' }),
      workerEvent({ event: 'status', status: 'running', error: 'rate limited' }),
      workerEvent({ event: 'status', status: 'failed', error: 'gave up' }),
    ])

    assert.deepEqual(timelineBlocks(projection), [
      { type: 'text', text: 'rate limited', tone: 'error' },
      { type: 'text', text: 'gave up', tone: 'error' },
    ])
  })

  void test('an event that changes nothing returns the same projection so the chat can skip a render', () => {
    const projection = apply([workerEvent({ event: 'status', status: 'running', summary: 's' })])
    const again = applyStandaloneWorkerThreadEvent(
      projection,
      workerEvent({ event: 'status', status: 'running', summary: 's', timestamp: 1_000 })
    )
    assert.equal(again, projection)
    assert.equal(applyStandaloneWorkerThreadEvent(projection, { kind: 'notice' }), projection)
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

    assert.match(persistState, /chatPersistence\.schedule\(/u)
    assert.doesNotMatch(persistState, /JSON\.stringify|localStorage/u)
    assert.match(adapter, /if \(terminalKind\) flushChatPersistence\(\)/u)
    assert.match(adapter, /window\.addEventListener\('pagehide', settleBeforeLeaving\)/u)
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

    assert.match(projectRuntime, /readStandaloneProjectRuntimeView\(normalizedRoot, providerId\)/u)
    assert.doesNotMatch(projectRuntime, /useStandaloneChatState/u)
    // 视图只认会话级字段：消息条数有没有、运行起止、运行标记——不认消息内容。
    assert.doesNotMatch(viewFields, /state\.messages,|state\.revision/u)
  })

  void test('sub-agent cards render their timeline with the chat transcript', () => {
    const panel = readSource('src/renderer/src/runtime/conversation/WorkbenchWorkerThreadPanel.tsx')
    const slots = readSource('src/renderer/src/runtime/conversation/standaloneWorkbenchConversationRenderSlots.tsx')

    assert.match(panel, /<ChatTranscript\n\s*messages=\{thread\.messages\}/u)
    assert.match(slots, /<WorkbenchWorkerThreadPanel threads=\{threads\} sessionId=\{sessionId\} \/>/u)
  })
})
