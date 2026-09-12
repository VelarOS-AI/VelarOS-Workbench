import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { describe, test } from 'bun:test'

import {
  createStandaloneRunChangeCapture,
  StandaloneRunChangeCaptureTiming,
} from '../src/renderer/src/runtime/standaloneWorkbenchRunChangeCapture'

const DelayMs = 20
const MaxDelayMs = 60

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function readSource(relativePath: string): string {
  return readFileSync(path.resolve(process.cwd(), relativePath), 'utf8')
}

/** 采集桩：每次调用记一笔，由测试决定什么时候回来、带回什么。 */
function createCaptureStub(): {
  calls: number
  settled: number
  delivered: string[]
  resolveNext: (value: string | null) => void
  capture: ReturnType<typeof createStandaloneRunChangeCapture>
} {
  const pending: Array<(value: string | null) => void> = []
  const stub = {
    calls: 0,
    settled: 0,
    delivered: [] as string[],
    resolveNext: (value: string | null) => pending.shift()?.(value),
    capture: createStandaloneRunChangeCapture<string>({
      timing: { delayMs: DelayMs, maxDelayMs: MaxDelayMs },
      capture: () => {
        stub.calls += 1
        return new Promise((resolve) => pending.push(resolve))
      },
      onCaptured: (value) => stub.delivered.push(value),
      settle: () => {
        stub.settled += 1
      },
    }),
  }
  return stub
}

void describe('Standalone Workbench live run-change capture', () => {
  void test('captures once after a burst of writes settles', async () => {
    const stub = createCaptureStub()
    stub.capture.request()
    stub.capture.request()
    stub.capture.request()
    await sleep(DelayMs / 2)
    assert.equal(stub.calls, 0)
    await sleep(DelayMs * 2)
    assert.equal(stub.calls, 1)

    stub.resolveNext('summary-1')
    await sleep(0)
    assert.deepEqual(stub.delivered, ['summary-1'])
  })

  void test('keeps capturing on the max-wait cadence while writes never pause', async () => {
    const stub = createCaptureStub()
    // 并行子 Agent 连着改：写入间隔一直短于静默窗口，只有尾沿防抖的话一次都不会采。
    const startedAt = Date.now()
    while (Date.now() - startedAt < MaxDelayMs * 3.5) {
      stub.capture.request()
      if (stub.calls > stub.delivered.length) stub.resolveNext(`live-${stub.calls}`)
      await sleep(DelayMs / 4)
    }
    assert.ok(stub.calls >= 2, `expected periodic captures during continuous writes, got ${stub.calls}`)
    assert.ok(stub.calls <= 4, `captures should follow the max-wait cadence, got ${stub.calls}`)
  })

  void test('the production cadence is an 800ms quiet window with a 3s ceiling', () => {
    assert.deepEqual(StandaloneRunChangeCaptureTiming, { delayMs: 800, maxDelayMs: 3_000 })
  })

  void test('keeps one capture in flight and runs one more after it when writes kept coming', async () => {
    const stub = createCaptureStub()
    stub.capture.request()
    await sleep(DelayMs * 2)
    assert.equal(stub.calls, 1)

    // 采集还没回来又写了两次：不并发第二次，只记一笔。
    stub.capture.request()
    await sleep(DelayMs * 2)
    stub.capture.request()
    await sleep(MaxDelayMs * 2)
    assert.equal(stub.calls, 1)

    stub.resolveNext('first')
    await sleep(DelayMs * 2)
    assert.equal(stub.calls, 2)
    stub.resolveNext('second')
    await sleep(0)
    assert.deepEqual(stub.delivered, ['first', 'second'])
  })

  void test('a failed capture delivers nothing and the next write tries again', async () => {
    const stub = createCaptureStub()
    stub.capture.request()
    await sleep(DelayMs * 2)
    stub.resolveNext(null)
    stub.capture.request()
    await sleep(DelayMs * 2)
    stub.resolveNext('recovered')
    await sleep(0)
    assert.deepEqual(stub.delivered, ['recovered'])
  })

  void test('finish settles exactly once, cancels the pending capture and drops late results', async () => {
    const pendingTimer = createCaptureStub()
    pendingTimer.capture.request()
    pendingTimer.capture.finish()
    await sleep(DelayMs * 3)
    assert.equal(pendingTimer.calls, 0)
    assert.equal(pendingTimer.settled, 1)

    const inFlight = createCaptureStub()
    inFlight.capture.request()
    await sleep(DelayMs * 2)
    assert.equal(inFlight.calls, 1)
    inFlight.capture.request()
    // 收尾：最终采集当场发出；在途那次晚到的结果不能再把「进行中」挂回去，挂着的那笔也作废。
    inFlight.capture.finish()
    assert.equal(inFlight.settled, 1)
    inFlight.resolveNext('late')
    await sleep(DelayMs * 3)
    assert.deepEqual(inFlight.delivered, [])
    assert.equal(inFlight.calls, 1)

    // 停止超时时会话面先了结一次，invoke 晚些返回再了结一次：第二次是空操作，也不再接写入。
    inFlight.capture.finish()
    inFlight.capture.request()
    await sleep(DelayMs * 3)
    assert.equal(inFlight.settled, 1)
    assert.equal(inFlight.calls, 1)
  })

  void test('every ending path, including a stop timeout or control failure, settles through finish', () => {
    const adapter = readSource('src/renderer/src/runtime/standaloneWorkbenchChatAdapter.tsx')
    const controlFailure = adapter.slice(
      adapter.indexOf('function settleActiveExecutionFromControlFailure('),
      adapter.indexOf('function resolveCurrentFileLabel(')
    )
    // 停止超时 / 控制失败：界面上这一轮已了结，「进行中」当场落定或撤下，不等 invoke 返回。
    assert.match(controlFailure, /finishWithError\([\s\S]*\}\)\n[\s\S]*execution\.runChangeCapture\?\.finish\(\)\n\}/u)
    assert.match(
      adapter,
      /settleActiveExecutionFromControlFailure\(\n\s*activeExecution,\n\s*settlement\.kind === 'request-error'/u
    )
    // 最终采集只有一个入口：收尾交给 finish，由它调 captureRunChanges。
    assert.match(adapter, /settle: \(\) => captureRunChanges\(sessionId, checkpoint\)/u)
    assert.equal(adapter.match(/captureRunChanges\(/gu)?.length, 2)
    assert.equal(adapter.match(/activeExecution\.runChangeCapture\?\.finish\(\)/gu)?.length, 5)
  })
})
