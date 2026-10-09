import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { describe, jest, test } from 'bun:test'

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

/** 从源码里截出一个函数：从声明行到与它同样缩进的收尾大括号。 */
function readFunction(source: string, declaration: string): string {
  const start = source.indexOf(declaration)
  assert.ok(start >= 0, `missing ${declaration}`)
  const indent = /^\s*/u.exec(declaration)?.[0] ?? ''
  const end = source.indexOf(`\n${indent}}\n`, start)
  assert.ok(end > start, `unterminated ${declaration}`)
  return source.slice(start, end + indent.length + 2)
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
    jest.useFakeTimers()
    const stub = createCaptureStub()
    try {
      // 固定写入节奏，不让 Windows CI 的定时器调度延迟改变连续写入场景。
      for (let elapsed = 0; elapsed < MaxDelayMs * 3.5; elapsed += DelayMs / 4) {
        stub.capture.request()
        jest.advanceTimersByTime(DelayMs / 4)
        if (stub.calls > stub.delivered.length) stub.resolveNext(`live-${stub.calls}`)
        // 等待采集结果与 finally 清理，再进入下一段时间。
        await Promise.resolve()
        await Promise.resolve()
        await Promise.resolve()
      }
      assert.equal(stub.calls, 3)
      assert.deepEqual(stub.delivered, ['live-1', 'live-2', 'live-3'])
    } finally {
      stub.capture.finish()
      jest.useRealTimers()
    }
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

  void test('every ending path, including a stop timeout or a send failure, settles through finish', () => {
    const adapter = readSource('src/renderer/src/runtime/standaloneWorkbenchChatAdapter.tsx')
    const finishRun = readFunction(adapter, 'function finishRun(')
    // 一轮只了结一次：已经不是在跑的那一轮就什么都不做；了结时「本轮改动」当场落定或撤下。
    assert.match(finishRun, /if \(activeRuns\.get\(key\) !== run\) return\n/u)
    assert.match(finishRun, /activeRuns\.delete\(key\)[\s\S]*run\.runChangeCapture\?\.finish\(\)\n\}$/u)
    // 交接准备可能在取消后才返回检查点；finish 的幂等性由上面的行为测试核验。

    // 主进程推来的终态、停止超时 / 取消失败、发送没被接纳：都经 finishRun 收尾，不等别的回音。
    assert.match(
      readFunction(adapter, 'function applyConversationState('),
      /const terminalKind = readStandaloneTerminalKind\(runtime\)\n\s*if \(terminalKind\) \{\n\s*finishRun\(run, runtime\)/u
    )
    assert.match(
      readFunction(adapter, '  async function stop('),
      /finishRun\(run, \{\n\s*kind: 'error',\n\s*message:\s*settlement\.kind === 'request-error'/u
    )
    assert.match(
      readFunction(adapter, '  async function submit('),
      /if \(!result\.ok && findActiveRun\(projectRoot, sessionId\) === run\)\n\s*finishRun\(run, \{\s*kind: 'error'/u
    )

    // Agent 改项目的时间窗一结束就按节奏采一次；最终采集只有一个入口：收尾交给 finish，由它调 captureRunChanges。
    assert.match(adapter, /event\.kind === ConversationProjectActivityNotice\) \{[\s\S]*?run\.runChangeCapture\?\.request\(\)/u)
    assert.match(adapter, /settle: \(\) => captureRunChanges\(projectRoot, sessionId, checkpoint\)/u)
    assert.equal(adapter.match(/captureRunChanges\(/gu)?.length, 2)
  })
})
