import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, test } from 'bun:test'

import {
  computeWorkbenchLanguageWorkerHeapLimitMb,
  decideWorkbenchLanguageMemoryAction,
  IdleDropAllMs,
  IdleSemanticTrimMs,
} from '../src/main/workspace/language/LanguageServiceMemoryGuard'
import {
  WorkbenchLanguageServiceWorkerClient,
  type WorkbenchLanguageServiceWorkerPort,
} from '../src/main/workspace/language/LanguageServiceWorkerClient'
import type {
  WorkbenchLanguageServiceWorkerRequest,
  WorkbenchLanguageServiceWorkerResponse,
} from '../src/main/workspace/language/LanguageServiceWorkerProtocol'
import {
  acquireTypeScriptLanguageService,
  clearTypeScriptProjectCache,
  configureTypeScriptProjectPool,
  describeTypeScriptProjects,
  MaxPooledTypeScriptProjects,
  trimTypeScriptProjects,
} from '../src/main/workspace/language/TypeScriptProjectHost'

const GiB = 1024 * 1024 * 1024

async function createPackageProject(root: string, name: string): Promise<string> {
  const dir = join(root, name)
  await mkdir(join(dir, 'src'), { recursive: true })
  await writeFile(
    join(dir, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: { module: 'ESNext', moduleResolution: 'bundler', target: 'ESNext', strict: true },
      include: ['src/**/*.ts'],
    }),
    'utf8'
  )
  const main = join(dir, 'src', 'main.ts')
  await writeFile(main, `export const ${name.replace(/-/gu, '_')} = 1\n`, 'utf8')
  return main
}

void describe('language worker memory guard', () => {
  void test('mirrors the V8 default heap limit but keeps it inside a sane band', () => {
    assert.equal(computeWorkbenchLanguageWorkerHeapLimitMb(16 * GiB), 4096)
    assert.equal(computeWorkbenchLanguageWorkerHeapLimitMb(8 * GiB), 2048)
    assert.equal(computeWorkbenchLanguageWorkerHeapLimitMb(2 * GiB), 1024)
    assert.equal(computeWorkbenchLanguageWorkerHeapLimitMb(64 * GiB), 4096)
  })

  void test('trims under heap pressure before the limit and drops caches after long idle periods', () => {
    const limit = 4096 * 1024 * 1024
    const sample = (used: number, idleMs = 0, idleTrimDone: 'none' | 'semantic' | 'inactive' | 'all' = 'none') =>
      decideWorkbenchLanguageMemoryAction({ heapUsedBytes: used, heapLimitBytes: limit, idleMs, idleTrimDone })

    assert.equal(sample(limit * 0.3), 'none')
    assert.equal(sample(limit * 0.61), 'inactive')
    assert.equal(sample(limit * 0.85), 'all')
    assert.equal(sample(limit * 0.3, IdleSemanticTrimMs), 'semantic')
    assert.equal(sample(limit * 0.3, IdleSemanticTrimMs, 'semantic'), 'none')
    assert.equal(sample(limit * 0.3, IdleDropAllMs, 'semantic'), 'all')
    assert.equal(sample(limit * 0.3, IdleDropAllMs, 'all'), 'none')
    // 压力优先于空闲判断。
    assert.equal(sample(limit * 0.7, IdleDropAllMs, 'all'), 'inactive')
  })

  void test('sizes the service pool from the worker heap limit', () => {
    assert.equal(configureTypeScriptProjectPool(4096 * 1024 * 1024), 5)
    assert.equal(configureTypeScriptProjectPool(2048 * 1024 * 1024), 2)
    assert.equal(configureTypeScriptProjectPool(64 * GiB), 6)
    assert.equal(configureTypeScriptProjectPool(MaxPooledTypeScriptProjects * 700 * 1024 * 1024), MaxPooledTypeScriptProjects)
  })

  void test('keeps only the most recently used TypeScript services and shares parsed library files', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'workbench-language-memory-')))
    try {
      const mains: string[] = []
      for (let index = 0; index < MaxPooledTypeScriptProjects + 1; index += 1) {
        mains.push(await createPackageProject(root, `pkg-${index}`))
      }
      const acquire = (main: string) =>
        acquireTypeScriptLanguageService(root, main, [main], new Map([[main, `export const value = ${main.length}\n`]]))

      const first = acquire(mains[0]!)
      const second = acquire(mains[1]!)
      const libPath = first.service.getProgram()?.getSourceFiles().find((file) => /lib\.[^/]+\.d\.ts$/u.test(file.fileName))?.fileName
      assert.ok(libPath, 'a lib file should be part of the program')
      assert.equal(
        first.service.getProgram()?.getSourceFile(libPath!),
        second.service.getProgram()?.getSourceFile(libPath!),
        'identical compiler options must share one parsed lib.d.ts through the document registry'
      )

      for (const main of mains.slice(2)) acquire(main)
      assert.equal(describeTypeScriptProjects().projects, MaxPooledTypeScriptProjects)
      // 最早的那个被淘汰了：再要它就是重建出来的新服务。
      assert.notEqual(acquire(mains[0]!).service, first.service)
      // 刚用过的第二个还活着（它在淘汰第一个之前被重新触碰过）。
      assert.equal(describeTypeScriptProjects().projects, MaxPooledTypeScriptProjects)

      assert.equal(trimTypeScriptProjects('semantic'), 0)
      assert.equal(describeTypeScriptProjects().projects, MaxPooledTypeScriptProjects)
      assert.equal(trimTypeScriptProjects('inactive'), MaxPooledTypeScriptProjects - 1)
      assert.equal(describeTypeScriptProjects().projects, 1)
      assert.equal(trimTypeScriptProjects('all'), 1)
      assert.deepEqual(describeTypeScriptProjects(), { projects: 0, files: 0 })
    } finally {
      clearTypeScriptProjectCache(root)
      await rm(root, { recursive: true, force: true })
    }
  })

})

class FakeWorker implements WorkbenchLanguageServiceWorkerPort {
  private readonly events = new EventEmitter()
  public readonly messages: WorkbenchLanguageServiceWorkerRequest[] = []

  public postMessage(message: WorkbenchLanguageServiceWorkerRequest): void {
    this.messages.push(message)
    if (message.operation === 'shutdown') this.reply(message.id)
  }

  public on(event: 'message' | 'error' | 'exit', listener: (...args: never[]) => void): this {
    this.events.on(event, listener)
    return this
  }

  public async terminate(): Promise<number> {
    return 0
  }

  public reply(id: number): void {
    const response: WorkbenchLanguageServiceWorkerResponse = { id, result: { projectRoot: '/p', path: 'a.ts', locations: [] } }
    this.events.emit('message', response)
  }

  public notify(message: unknown): void {
    this.events.emit('message', message)
  }

  public fail(error: Error): void {
    this.events.emit('error', error)
  }
}

void describe('language worker client under memory failures', () => {
  void test('an out-of-memory worker termination fails pending requests with a clear platform error and restarts lazily', async () => {
    const workers: FakeWorker[] = []
    const client = new WorkbenchLanguageServiceWorkerClient(() => {
      const worker = new FakeWorker()
      workers.push(worker)
      return worker
    }, () => 5_000)
    const request = { projectRoot: '/p', path: 'a.ts', language: 'typescript', content: '', position: { line: 1, column: 1 } }

    const pending = client.getDefinition(request)
    // 内存通报不是答复：只记日志，不影响挂起的请求。
    workers[0]!.notify({ notification: 'memory', heapUsedMb: 3000, heapLimitMb: 4096, rssMb: 3500, projects: 4, files: 1200, action: 'inactive', reason: 'pressure' })
    const oom = Object.assign(new Error('Worker terminated due to reaching memory limit: JS heap out of memory'), { code: 'ERR_WORKER_OUT_OF_MEMORY' })
    workers[0]!.fail(oom)
    await assert.rejects(pending, (error: { code?: string; message: string }) =>
      error.code === 'PLATFORM' && /内存不足/u.test(error.message))

    const recovered = client.getDefinition(request)
    assert.equal(workers.length, 2, 'the next request must spawn a fresh worker')
    workers[1]!.reply(workers[1]!.messages[0]!.id)
    assert.deepEqual((await recovered).locations, [])
    await client.dispose()
  })
})
