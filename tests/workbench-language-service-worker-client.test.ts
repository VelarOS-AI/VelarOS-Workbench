import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { test } from 'node:test'

import {
  getWorkbenchLanguageServiceRequestTimeoutMs,
  WorkbenchLanguageServiceWorkerClient,
  type WorkbenchLanguageServiceWorkerPort,
} from '../src/main/workspace/language/LanguageServiceWorkerClient'
import type {
  WorkbenchLanguageServiceWorkerRequest,
  WorkbenchLanguageServiceWorkerResponse,
} from '../src/main/workspace/language/LanguageServiceWorkerProtocol'

class FakeLanguageServiceWorker implements WorkbenchLanguageServiceWorkerPort {
  private readonly events = new EventEmitter()
  public readonly messages: WorkbenchLanguageServiceWorkerRequest[] = []
  public terminated = false

  public constructor(private readonly respond: boolean) {}

  public postMessage(message: WorkbenchLanguageServiceWorkerRequest): void {
    this.messages.push(message)
    if (!this.respond) return

    queueMicrotask(() => {
      const response: WorkbenchLanguageServiceWorkerResponse = {
        id: message.id,
        result: message.operation === 'getDefinition'
          ? { projectRoot: '/project', path: 'src/index.ts', locations: [] }
          : undefined,
      }
      this.events.emit('message', response)
    })
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

void test('language worker timeouts keep interactive requests bounded', () => {
  assert.equal(getWorkbenchLanguageServiceRequestTimeoutMs('getDefinition'), 12_000)
  assert.equal(getWorkbenchLanguageServiceRequestTimeoutMs('getDiagnostics'), 30_000)
  assert.equal(getWorkbenchLanguageServiceRequestTimeoutMs('projectFilesChanged'), 15_000)
})

void test('a stuck language request times out, terminates the worker, and recovers lazily', async () => {
  const stuckWorker = new FakeLanguageServiceWorker(false)
  const recoveredWorker = new FakeLanguageServiceWorker(true)
  const workers = [stuckWorker, recoveredWorker]
  const client = new WorkbenchLanguageServiceWorkerClient(
    () => workers.shift() ?? recoveredWorker,
    () => 20
  )
  const request = {
    projectRoot: '/project',
    path: 'src/index.ts',
    language: 'typescript',
    content: 'const value = 1\n',
    position: { line: 1, column: 7 },
  }

  await assert.rejects(client.getDefinition(request), /请求超时.*已自动重启/u)
  assert.equal(stuckWorker.terminated, true)

  const result = await client.getDefinition(request)
  assert.deepEqual(result.locations, [])
  assert.equal(recoveredWorker.messages[0]?.operation, 'getDefinition')

  await client.dispose()
})
