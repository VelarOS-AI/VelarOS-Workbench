import assert from 'node:assert/strict'

import { describe, test } from 'bun:test'

import { createStandaloneRunChangeCapture } from '../src/renderer/src/runtime/standaloneWorkbenchRunChangeCapture'

const DebounceMs = 20

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function toolStart(toolCallId: string, toolName: string): Record<string, unknown> {
  return { type: 'tool-start', toolCallId, toolName, args: {} }
}

function toolDone(toolCallId: string): Record<string, unknown> {
  return { type: 'tool-done', toolCallId, result: {} }
}

/** 采集桩：每次调用记一笔，由测试决定什么时候回来、带回什么。 */
function createCaptureStub(): {
  calls: number
  delivered: string[]
  resolveNext: (value: string | null) => void
  capture: ReturnType<typeof createStandaloneRunChangeCapture>
} {
  const pending: Array<(value: string | null) => void> = []
  const stub = {
    calls: 0,
    delivered: [] as string[],
    resolveNext: (value: string | null) => pending.shift()?.(value),
    capture: createStandaloneRunChangeCapture<string>({
      debounceMs: DebounceMs,
      capture: () => {
        stub.calls += 1
        return new Promise((resolve) => pending.push(resolve))
      },
      onCaptured: (value) => stub.delivered.push(value),
    }),
  }
  return stub
}

void describe('Standalone Workbench live run-change capture', () => {
  void test('captures once after a burst of project writes, ignoring reads and unfinished calls', async () => {
    const stub = createCaptureStub()
    stub.capture.observe(toolStart('read-1', 'project:read'))
    stub.capture.observe(toolDone('read-1'))
    stub.capture.observe(toolStart('edit-1', 'project:edit'))
    await sleep(DebounceMs * 3)
    // 读工具不改工作区；写工具还没出结果也不算。
    assert.equal(stub.calls, 0)

    stub.capture.observe(toolDone('edit-1'))
    stub.capture.observe(toolStart('write-1', 'project:write'))
    stub.capture.observe(toolDone('write-1'))
    stub.capture.observe(toolStart('run-1', 'project:run'))
    stub.capture.observe(toolDone('run-1'))
    await sleep(DebounceMs * 3)
    assert.equal(stub.calls, 1)

    stub.resolveNext('summary-1')
    await sleep(0)
    assert.deepEqual(stub.delivered, ['summary-1'])
  })

  void test('reacts to writes made by sub-agents inside worker-thread events', async () => {
    const stub = createCaptureStub()
    const workerEvent = (chatEvent: Record<string, unknown>): Record<string, unknown> => ({
      type: 'worker-thread',
      payload: { kind: 'worker-thread', event: 'chat-event', threadId: 't1', chatEvent },
    })
    stub.capture.observe(workerEvent(toolStart('sub-edit', 'project:edit')))
    stub.capture.observe(workerEvent(toolDone('sub-edit')))
    await sleep(DebounceMs * 3)
    assert.equal(stub.calls, 1)
  })

  void test('keeps one capture in flight and runs one more after it when writes kept coming', async () => {
    const stub = createCaptureStub()
    stub.capture.observe(toolStart('e1', 'project:edit'))
    stub.capture.observe(toolDone('e1'))
    await sleep(DebounceMs * 3)
    assert.equal(stub.calls, 1)

    // 采集还没回来又写了两次：不并发第二次，只记一笔。
    stub.capture.observe(toolStart('e2', 'project:edit'))
    stub.capture.observe(toolDone('e2'))
    await sleep(DebounceMs * 3)
    stub.capture.observe(toolStart('e3', 'project:rollback'))
    stub.capture.observe(toolDone('e3'))
    await sleep(DebounceMs * 3)
    assert.equal(stub.calls, 1)

    stub.resolveNext('first')
    await sleep(DebounceMs * 3)
    assert.equal(stub.calls, 2)
    stub.resolveNext('second')
    await sleep(0)
    assert.deepEqual(stub.delivered, ['first', 'second'])
  })

  void test('finish cancels the pending capture and drops results that come back afterwards', async () => {
    const pendingTimer = createCaptureStub()
    pendingTimer.capture.observe(toolStart('e1', 'project:edit'))
    pendingTimer.capture.observe(toolDone('e1'))
    pendingTimer.capture.finish()
    await sleep(DebounceMs * 3)
    assert.equal(pendingTimer.calls, 0)

    const inFlight = createCaptureStub()
    inFlight.capture.observe(toolStart('e1', 'project:edit'))
    inFlight.capture.observe(toolDone('e1'))
    await sleep(DebounceMs * 3)
    assert.equal(inFlight.calls, 1)
    inFlight.capture.observe(toolStart('e2', 'project:edit'))
    inFlight.capture.observe(toolDone('e2'))
    // 收尾：最终采集由调用方发出；在途那次晚到的结果不能再把「进行中」挂回去，挂着的那笔也作废。
    inFlight.capture.finish()
    inFlight.resolveNext('late')
    await sleep(DebounceMs * 3)
    assert.deepEqual(inFlight.delivered, [])
    assert.equal(inFlight.calls, 1)

    // 失败的一次什么都不交出，下一次写入照常再采。
    const failing = createCaptureStub()
    failing.capture.observe(toolStart('e1', 'project:write'))
    failing.capture.observe(toolDone('e1'))
    await sleep(DebounceMs * 3)
    failing.resolveNext(null)
    failing.capture.observe(toolStart('e2', 'project:write'))
    failing.capture.observe(toolDone('e2'))
    await sleep(DebounceMs * 3)
    failing.resolveNext('recovered')
    await sleep(0)
    assert.deepEqual(failing.delivered, ['recovered'])
  })
})
