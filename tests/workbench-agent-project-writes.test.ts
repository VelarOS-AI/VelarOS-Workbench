import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { describe, test } from 'bun:test'

import {
  createWorkbenchAgentProjectWriteTracker,
  publishWorkbenchAgentProjectWrite,
  subscribeWorkbenchAgentProjectWrites,
} from '../src/renderer/src/runtime/workbenchAgentProjectWrites'

function readSource(relativePath: string): string {
  return readFileSync(path.resolve(process.cwd(), relativePath), 'utf8')
}

function toolStart(toolCallId: string, toolName: string): Record<string, unknown> {
  return { type: 'tool-start', toolCallId, toolName, args: {} }
}

function toolDone(toolCallId: string, error?: string): Record<string, unknown> {
  return { type: 'tool-done', toolCallId, result: {}, error }
}

function workerEvent(chatEvent: Record<string, unknown>): Record<string, unknown> {
  return {
    type: 'worker-thread',
    payload: { kind: 'worker-thread', event: 'chat-event', threadId: 't1', chatEvent },
  }
}

void describe('Workbench agent project writes', () => {
  void test('recognizes the results of project writing tools, not reads or unfinished calls', () => {
    const tracker = createWorkbenchAgentProjectWriteTracker()
    assert.equal(tracker.observe(toolStart('read-1', 'project:read')), false)
    assert.equal(tracker.observe(toolDone('read-1')), false)
    // 写工具还没出结果不算。
    assert.equal(tracker.observe(toolStart('edit-1', 'project:edit')), false)
    assert.equal(tracker.observe({ type: 'tool-progress', toolCallId: 'edit-1', chunk: '…' }), false)

    assert.equal(tracker.observe(toolDone('edit-1')), true)
    // 同一个调用的结果只认一次。
    assert.equal(tracker.observe(toolDone('edit-1')), false)
    for (const [id, name] of [['w', 'project:write'], ['r', 'project:rollback'], ['c', 'project:run']]) {
      tracker.observe(toolStart(id, name))
      assert.equal(tracker.observe(toolDone(id)), true, name)
    }
    assert.equal(tracker.observe({ type: 'text-delta', text: 'hi' }), false)
  })

  void test('counts a failed write result too: a failing command may already have touched the disk', () => {
    const tracker = createWorkbenchAgentProjectWriteTracker()
    tracker.observe(toolStart('run-1', 'project:run'))
    assert.equal(tracker.observe(toolDone('run-1', 'exit code 1')), true)
  })

  void test('recognizes writes made by sub-agents inside worker-thread events', () => {
    const tracker = createWorkbenchAgentProjectWriteTracker()
    assert.equal(tracker.observe(workerEvent(toolStart('sub-edit', 'project:edit'))), false)
    assert.equal(tracker.observe(workerEvent(toolStart('sub-read', 'project:read'))), false)
    assert.equal(tracker.observe(workerEvent(toolDone('sub-read'))), false)
    assert.equal(tracker.observe(workerEvent(toolDone('sub-edit'))), true)
    assert.equal(tracker.observe(workerEvent({ type: 'text-delta', text: 'x' })), false)
  })

  void test('delivers a write to the subscribers of that project root only', () => {
    const received: string[] = []
    const stopA = subscribeWorkbenchAgentProjectWrites('/work/a/', () => received.push('a'))
    const stopB = subscribeWorkbenchAgentProjectWrites('/work/b', () => received.push('b'))

    publishWorkbenchAgentProjectWrite('/work/a')
    publishWorkbenchAgentProjectWrite('/work/c')
    assert.deepEqual(received, ['a'])

    stopA()
    publishWorkbenchAgentProjectWrite('/work/a')
    publishWorkbenchAgentProjectWrite('/work/b')
    assert.deepEqual(received, ['a', 'b'])
    stopB()
  })

  void test('one recognizer feeds both the live AI-changes capture and the Git refresh', () => {
    const adapter = readSource('src/renderer/src/runtime/standaloneWorkbenchChatAdapter.tsx')
    const gitState = readSource('src/renderer/src/hooks/useWorkbenchGitState.ts')
    const capture = readSource('src/renderer/src/runtime/standaloneWorkbenchRunChangeCapture.ts')

    assert.match(
      adapter,
      /if \(envelope\.channel === 'agent' && activeExecution\.projectWrites\.observe\(payload\)\) \{\n\s*activeExecution\.runChangeCapture\?\.request\(\)\n\s*publishWorkbenchAgentProjectWrite\(activeExecution\.projectRoot\)/u
    )
    assert.match(adapter, /projectWrites: createWorkbenchAgentProjectWriteTracker\(\)/u)
    assert.match(
      gitState,
      /subscribeWorkbenchAgentProjectWrites\(workspaceRoot, workspaceChangeRefresh\.schedule\)/u
    )
    // 没有第二套识别器：Git 状态不再自己解析执行事件流，实时采集也不再自己认工具事件。
    assert.doesNotMatch(gitState, /onAgentExecution|changedFiles|tool-done/u)
    assert.doesNotMatch(capture, /tool-done|tool-start|worker-thread/u)
  })
})
