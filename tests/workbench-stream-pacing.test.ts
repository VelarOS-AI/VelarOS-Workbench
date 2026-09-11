import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { describe, test } from 'bun:test'

import {
  classifyStandalonePacedStreamEvent,
  type StandalonePacedStreamEvent,
} from '../src/renderer/src/runtime/standaloneWorkbenchStreamPacer'

function agentEvent(payload: Record<string, unknown>): StandalonePacedStreamEvent {
  return { kind: 'envelope', channel: 'agent', payload }
}

function runtimeEvent(kind: string): StandalonePacedStreamEvent {
  return agentEvent({ type: 'runtime', payload: { kind } })
}

void describe('Workbench stream pacing classification', () => {
  void test('main-chain events map onto the shared pacing classes', () => {
    assert.deepEqual(
      classifyStandalonePacedStreamEvent(agentEvent({ type: 'reasoning-delta', id: 'r1', text: 'hm' })),
      { kind: 'reasoning', id: 'r1', text: 'hm' }
    )
    assert.deepEqual(
      classifyStandalonePacedStreamEvent(agentEvent({ type: 'tool-start', toolCallId: 't1', toolName: 'project:read' })),
      { kind: 'tool', toolCallId: 't1' }
    )
    assert.deepEqual(
      classifyStandalonePacedStreamEvent(agentEvent({ type: 'tool-done', toolCallId: 't1' })),
      { kind: 'tool', toolCallId: 't1' }
    )
    // 子 Agent 线程事件同一帧批量应用，不再逐帧积压。
    assert.deepEqual(
      classifyStandalonePacedStreamEvent(agentEvent({ type: 'worker-thread', payload: {} })),
      { kind: 'structural', batchKey: 'worker-thread' }
    )
    assert.deepEqual(
      classifyStandalonePacedStreamEvent({ kind: 'reasoning', id: 'r2', text: 'chunk' }),
      { kind: 'reasoning', id: 'r2', text: 'chunk' }
    )
  })

  void test('run states follow the same table as Desktop', () => {
    const kindOf = (event: StandalonePacedStreamEvent) => classifyStandalonePacedStreamEvent(event).kind

    assert.equal(kindOf(runtimeEvent('done')), 'terminal')
    assert.equal(kindOf(runtimeEvent('aborted')), 'immediate')
    assert.equal(kindOf(runtimeEvent('error')), 'immediate')
    assert.equal(kindOf(runtimeEvent('awaiting-confirmation')), 'immediate')
    assert.equal(kindOf(runtimeEvent('phase')), 'structural')
    // 其它通道上整个载荷就是状态（执行阶段等）。
    assert.equal(kindOf({ kind: 'envelope', channel: 'state', payload: { kind: 'phase' } }), 'structural')
    assert.equal(kindOf({ kind: 'envelope', channel: 'state', payload: { kind: 'done' } }), 'terminal')
  })
})

function readSource(relativePath: string): string {
  return readFileSync(path.resolve(process.cwd(), relativePath), 'utf8')
}

void describe('Workbench stream pacing wiring', () => {
  void test('text goes through the pacer and a run waits for it before wrapping up', () => {
    const adapter = readSource('src/renderer/src/runtime/standaloneWorkbenchChatAdapter.tsx')

    assert.match(
      adapter,
      /standaloneStreamPacer\.enqueueText\(activeExecution\.executionId, streamSequence, payload\.text\)/u
    )
    assert.match(adapter, /standaloneStreamPacer\.enqueueLiveEvent\(activeExecution\.executionId, streamSequence, \{/u)
    // main 跑完后等起搏器吐完、落地收尾，再了结这一轮；停止/失败直接排空。
    assert.match(adapter, /else await settleStreamPacing\(executionId\)/u)
    assert.match(adapter, /standaloneStreamPacer\.flushImmediate\(executionId\)\n\s*activeExecution\.settleTerminal\(stopped \? 'aborted' : 'error'\)/u)
    // 点停止时已收到的正文立刻落地；离开页面前先排空再落盘。
    assert.match(adapter, /standaloneStreamPacer\.drain\(activeExecution\.executionId\)/u)
    assert.match(adapter, /drainStreamPacing\(\)\n\s*flushChatPersistence\(\)/u)
  })

  void test('thinking continues only the block right before it, never an earlier step with the same id', () => {
    const adapter = readSource('src/renderer/src/runtime/standaloneWorkbenchChatAdapter.tsx')
    const append = /function appendAssistantReasoning\([\s\S]*?\n\}/u.exec(adapter)?.[0] ?? ''

    assert.match(append, /const last = blocks\.at\(-1\)\n\s*if \(last\?\.type !== 'thinking'\) return \[\.\.\.blocks, \{ type: 'thinking', streamId, text \}\]/u)
    assert.doesNotMatch(append, /findLastIndex/u)
  })
})
