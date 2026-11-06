import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'

import { describe, test } from 'bun:test'

import {
  getWorkbenchLanguageServiceRequestTimeoutMs,
  WorkbenchLanguageServiceWorkerClient,
  type WorkbenchLanguageServiceWorkerFactoryOptions,
  type WorkbenchLanguageServiceWorkerPort,
} from '../src/main/workspace/language/LanguageServiceWorkerClient'
import {
  isWorkbenchLanguageServiceRequestCancelled,
  isWorkbenchLanguageServiceWorkerControl,
  type WorkbenchLanguageServiceWorkerMessage,
  type WorkbenchLanguageServiceWorkerRequest,
  type WorkbenchLanguageServiceWorkerResponse,
} from '../src/main/workspace/language/LanguageServiceWorkerProtocol'

type FakeWorkerMode = 'respond' | 'silent' | 'alive-but-slow'

/**
 * `respond`：每个请求都立刻答复；`silent`：什么都不答（卡死）；`alive-but-slow`：请求不答，但探活照答
 * （worker 还活着，只是这个请求慢）。
 */
class FakeLanguageServiceWorker implements WorkbenchLanguageServiceWorkerPort {
  private readonly events = new EventEmitter()
  public readonly requests: WorkbenchLanguageServiceWorkerRequest[] = []
  public readonly controls: Array<{ control: string; id: number }> = []
  public terminated = false
  public cancellation: Nullable<Int32Array> = null

  public constructor(
    private readonly mode: FakeWorkerMode,
    options?: WorkbenchLanguageServiceWorkerFactoryOptions
  ) {
    if (options) this.cancellation = new Int32Array(options.cancellation)
  }

  public postMessage(message: WorkbenchLanguageServiceWorkerMessage): void {
    if (isWorkbenchLanguageServiceWorkerControl(message)) {
      this.controls.push(message)
      if (message.control === 'ping' && this.mode !== 'silent')
        queueMicrotask(() => this.events.emit('message', { control: 'pong', id: message.id }))
      return
    }
    this.requests.push(message)
    if (this.mode === 'respond' || message.operation === 'shutdown') this.reply(message)
  }

  public reply(message: WorkbenchLanguageServiceWorkerRequest): void {
    queueMicrotask(() => {
      const response: WorkbenchLanguageServiceWorkerResponse = {
        id: message.id,
        result:
          message.operation === 'getDefinition' || message.operation === 'getCompletions'
            ? { projectRoot: '/project', path: 'src/index.ts', locations: [], items: [] }
            : undefined,
      }
      this.events.emit('message', response)
    })
  }

  public crash(): void {
    this.events.emit('error', new Error('worker crashed'))
  }

  public replyToPing(): void {
    const ping = this.controls.findLast((control) => control.control === 'ping')
    if (ping) this.events.emit('message', { control: 'pong', id: ping.id })
  }

  public on(event: 'message' | 'error' | 'exit', listener: (...args: never[]) => void): this {
    this.events.on(event, listener)
    return this
  }

  public async terminate(): Promise<number> {
    this.terminated = true
    return 0
  }
}

const request = {
  projectRoot: '/project',
  path: 'src/index.ts',
  language: 'typescript',
  content: 'const value = 1\n',
  position: { line: 1, column: 7 },
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

void describe('language worker client', () => {
  void test('language worker timeouts keep interactive requests bounded', () => {
    assert.equal(getWorkbenchLanguageServiceRequestTimeoutMs('getDefinition'), 12_000)
    assert.equal(getWorkbenchLanguageServiceRequestTimeoutMs('getDiagnostics'), 90_000)
    assert.equal(getWorkbenchLanguageServiceRequestTimeoutMs('getProjectDiagnostics'), 30_000)
    assert.equal(getWorkbenchLanguageServiceRequestTimeoutMs('projectFilesChanged'), 15_000)
  })

  void test('a queued interactive timeout preserves a worker still within its diagnostic budget', async () => {
    let worker!: FakeLanguageServiceWorker
    let created = 0
    const client = new WorkbenchLanguageServiceWorkerClient(
      (options) => {
        created++
        worker = new FakeLanguageServiceWorker('silent', options)
        return worker
      },
      (operation) => (operation === 'getDiagnostics' ? 200 : 15),
      { hangTimeoutMs: 20 }
    )
    const diagnostics = client.getDiagnostics(request)
    await assert.rejects(client.getDefinition(request), /请求超时/u)
    await sleep(45)
    assert.equal(worker.terminated, false, 'a busy diagnostic must not lose its warm project state')
    worker.reply(worker.requests[0]!)
    worker.replyToPing()
    await diagnostics
    const next = client.getDefinition(request)
    worker.reply(worker.requests.at(-1)!)
    await next
    assert.equal(created, 1)
    await client.dispose()
  })

  void test('a genuinely hung diagnostic is still restarted when its existing budget expires', async () => {
    let worker!: FakeLanguageServiceWorker
    const client = new WorkbenchLanguageServiceWorkerClient(
      (options) => (worker = new FakeLanguageServiceWorker('silent', options)),
      (operation) => (operation === 'getDiagnostics' ? 60 : 10),
      { hangTimeoutMs: 10 }
    )
    const diagnostics = assert.rejects(client.getDiagnostics(request), /请求超时|无响应/u)
    await assert.rejects(client.getDefinition(request), /请求超时/u)
    await diagnostics
    await sleep(35)
    assert.equal(worker.terminated, true)
    await client.dispose()
  })

  void test('a slow request times out on its own and a responsive worker keeps its state', async () => {
    const workers: FakeLanguageServiceWorker[] = []
    const client = new WorkbenchLanguageServiceWorkerClient(
      (options) => {
        const worker = new FakeLanguageServiceWorker('alive-but-slow', options)
        workers.push(worker)
        return worker
      },
      () => 20,
      { hangTimeoutMs: 200 }
    )

    await assert.rejects(
      client.getDefinition(request),
      (error: { code?: string; message: string }) =>
        error.code === 'TIMEOUT' && /请求超时（getDefinition）/u.test(error.message)
    )
    const [worker] = workers
    // worker 被告知放弃这个请求，并被探活；它答得上来，所以留着。
    assert.deepEqual(
      worker!.controls.map((control) => control.control),
      ['cancel', 'ping']
    )
    assert.equal(
      isWorkbenchLanguageServiceRequestCancelled(worker!.cancellation!, worker!.requests[0]!.id),
      true
    )
    await sleep(250)
    assert.equal(worker!.terminated, false)

    const next = client.getDefinition(request)
    assert.equal(workers.length, 1, 'the same worker keeps serving requests')
    worker!.reply(worker!.requests[1]!)
    assert.deepEqual((await next).locations, [])
    await client.dispose()
  })

  void test('a worker that stops answering is replaced after the hang timeout', async () => {
    const workers: FakeLanguageServiceWorker[] = []
    const client = new WorkbenchLanguageServiceWorkerClient(
      (options) => {
        const worker = new FakeLanguageServiceWorker(
          workers.length === 0 ? 'silent' : 'respond',
          options
        )
        workers.push(worker)
        return worker
      },
      () => 20,
      { hangTimeoutMs: 30 }
    )

    const stuck = client.getDefinition(request)
    const queuedBehind = client.getCompletions(request)
    await assert.rejects(stuck, /请求超时/u)
    // 探活没有回音：判定卡死，排在它后面的请求一并结束，worker 被换掉。
    await assert.rejects(queuedBehind, /无响应，已重启|请求超时/u)
    await sleep(60)
    assert.equal(workers[0]!.terminated, true)

    const recovered = client.getDefinition(request)
    assert.equal(workers.length, 2)
    assert.deepEqual((await recovered).locations, [])
    await client.dispose()
  })

  void test('repeated crashes back off before the worker is rebuilt', async () => {
    const workers: FakeLanguageServiceWorker[] = []
    const client = new WorkbenchLanguageServiceWorkerClient(
      (options) => {
        const worker = new FakeLanguageServiceWorker('alive-but-slow', options)
        workers.push(worker)
        return worker
      },
      () => 5_000,
      { restartBackoffMs: 40, restartBackoffMaxMs: 40, restartBackoffResetMs: 60_000 }
    )

    const first = client.getDefinition(request)
    workers[0]!.crash()
    await assert.rejects(first, /worker crashed/u)

    // 第一次崩溃立即重建。
    const second = client.getDefinition(request)
    assert.equal(workers.length, 2)
    workers[1]!.crash()
    await assert.rejects(second, /worker crashed/u)

    // 接连第二次：等退避结束才重建，请求先排着，到点再发。
    const third = client.getDefinition(request)
    assert.equal(workers.length, 2)
    await sleep(80)
    assert.equal(workers.length, 3)
    workers[2]!.reply(workers[2]!.requests[0]!)
    assert.deepEqual((await third).locations, [])
    await client.dispose()
  })

  void test('a newer completion or hover from the same window and file cancels the older one', async () => {
    const workers: FakeLanguageServiceWorker[] = []
    const client = new WorkbenchLanguageServiceWorkerClient(
      (options) => {
        const worker = new FakeLanguageServiceWorker('alive-but-slow', options)
        workers.push(worker)
        return worker
      },
      () => 5_000
    )
    const worker = (): FakeLanguageServiceWorker => workers[0]!

    const older = client.getCompletions(request, { scope: '1' })
    const otherWindow = client.getCompletions(request, { scope: '2' })
    const otherFile = client.getCompletions({ ...request, path: 'src/other.ts' }, { scope: '1' })
    const unscoped = client.getHover(request)
    const newer = client.getCompletions(
      { ...request, position: { line: 1, column: 8 } },
      { scope: '1' }
    )

    await assert.rejects(older, (error: { code?: string }) => error.code === 'CANCELLED')
    const olderId = worker().requests[0]!.id
    assert.deepEqual(worker().controls, [{ control: 'cancel', id: olderId }])
    assert.equal(isWorkbenchLanguageServiceRequestCancelled(worker().cancellation!, olderId), true)

    for (const message of worker().requests.slice(1)) worker().reply(message)
    await Promise.all([otherWindow, otherFile, unscoped, newer])
    await client.dispose()
  })
})
