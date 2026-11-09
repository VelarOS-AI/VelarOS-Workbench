import assert from 'node:assert/strict'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'

import { describe, test } from 'bun:test'

import { ExternalLspProcessHost } from '../src/main/workspace/language/ExternalLspProcessHost'
import { WorkbenchLanguageServices } from '../src/main/workspace/language/LanguageServices'
import {
  createWorkbenchLanguageServiceCancellationBuffer,
  markWorkbenchLanguageServiceRequestCancelled,
  type WorkbenchLanguageServiceWorkerPong,
  type WorkbenchLanguageServiceWorkerRequest,
  type WorkbenchLanguageServiceWorkerResponse,
} from '../src/main/workspace/language/LanguageServiceWorkerProtocol'
import { WorkbenchLanguageServiceWorkerScheduler } from '../src/main/workspace/language/LanguageServiceWorkerScheduler'
import {
  clearTypeScriptProjectCache,
  configureTypeScriptCancellation,
} from '../src/main/workspace/language/TypeScriptProjectHost'

type Posted = WorkbenchLanguageServiceWorkerResponse | WorkbenchLanguageServiceWorkerPong

function positionRequest(id: number, operation: 'getCompletions' | 'getHover' | 'getDefinition') {
  return {
    id,
    operation,
    request: { projectRoot: '/p', path: 'a.ts', position: { line: 1, column: 1 } },
  } as WorkbenchLanguageServiceWorkerRequest
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

function isInside(projectRoot: string, absolutePath: string): boolean {
  const value = relative(projectRoot, absolutePath)
  return value === '' || (!value.startsWith('..') && !isAbsolute(value))
}

const languagePathResolver = {
  async resolveProjectRoot(input: string): Promise<string> {
    return realpath(resolve(input))
  },
  assertAllowedProjectPath(projectRoot: string, absolutePath: string, inputPath: string): void {
    if (!isInside(projectRoot, absolutePath)) throw new Error(`Language path escapes the project: ${inputPath}`)
  },
  isAllowedProjectPath(projectRoot: string, absolutePath: string): boolean {
    return isInside(projectRoot, absolutePath)
  },
  toProjectRelativePath(projectRoot: string, absolutePath: string): string {
    return (relative(projectRoot, absolutePath) || '.').replaceAll('\\', '/')
  },
}

void describe('language worker scheduler', () => {
  void test('drops a cancelled request that is still queued and runs interactive work first', async () => {
    const started: string[] = []
    const gate = deferred()
    const posted: Posted[] = []
    const scheduler = new WorkbenchLanguageServiceWorkerScheduler({
      dispatch: async (request) => {
        started.push(`${request.operation}:${request.id}`)
        if (request.id === 1) await gate.promise
        return request.id
      },
      post: (message) => posted.push(message),
    })

    scheduler.receive({ id: 1, operation: 'getDiagnostics', request: { projectRoot: '/p', path: 'a.ts' } })
    scheduler.receive({ id: 2, operation: 'getDiagnostics', request: { projectRoot: '/p', path: 'b.ts' } })
    scheduler.receive(positionRequest(3, 'getCompletions'))
    scheduler.receive(positionRequest(4, 'getHover'))
    scheduler.receive({ control: 'cancel', id: 3 })
    // 探活不排队：前面的请求还在算，照样立刻回 pong。
    scheduler.receive({ control: 'ping', id: 99 })
    assert.deepEqual(posted, [{ control: 'pong', id: 99 }])

    gate.resolve()
    await new Promise((settle) => setTimeout(settle, 0))
    assert.deepEqual(started, ['getDiagnostics:1', 'getHover:4', 'getDiagnostics:2'])
    assert.deepEqual(
      posted.filter((message) => 'result' in message).map((message) => message.id),
      [1, 4, 2]
    )
  })

  void test('aborts the running request when it is cancelled and answers with a cancellation', async () => {
    const posted: Posted[] = []
    let aborted = false
    const scheduler = new WorkbenchLanguageServiceWorkerScheduler({
      dispatch: (_request, signal) => new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          aborted = true
          reject(new Error('aborted by signal'))
        })
      }),
      post: (message) => posted.push(message),
    })

    scheduler.receive(positionRequest(7, 'getCompletions'))
    await new Promise((settle) => setTimeout(settle, 0))
    scheduler.receive({ control: 'cancel', id: 7 })
    await new Promise((settle) => setTimeout(settle, 0))

    assert.equal(aborted, true)
    assert.equal(posted.length, 1)
    assert.equal((posted[0] as WorkbenchLanguageServiceWorkerResponse).error?.code, 'CANCELLED')
  })

  void test('reads cancellations from the shared buffer while the worker is busy', async () => {
    const buffer = new Int32Array(createWorkbenchLanguageServiceCancellationBuffer())
    const checks: boolean[] = []
    const scheduler: WorkbenchLanguageServiceWorkerScheduler = new WorkbenchLanguageServiceWorkerScheduler({
      dispatch: async (request) => {
        checks.push(scheduler.isRunningRequestCancelled())
        // 主进程在 worker 算到一半时写入取消：同步代码里也能读到。
        markWorkbenchLanguageServiceRequestCancelled(buffer, request.id)
        checks.push(scheduler.isRunningRequestCancelled())
        return null
      },
      post: () => undefined,
      cancellation: buffer,
    })

    scheduler.receive(positionRequest(11, 'getCompletions'))
    // 诊断、跳转定义这类请求从不中途放弃。
    scheduler.receive(positionRequest(12, 'getDefinition'))
    await new Promise((settle) => setTimeout(settle, 0))
    assert.deepEqual(checks, [false, true, false, false])
  })

  void test('stops a superseded TypeScript semantic pass at its next checkpoint', async () => {
    const projectRoot = await realpath(await mkdtemp(join(tmpdir(), 'workbench-ts-cancel-')))
    const services = new WorkbenchLanguageServices(languagePathResolver, new ExternalLspProcessHost())
    const buffer = new Int32Array(createWorkbenchLanguageServiceCancellationBuffer())
    const content = 'export function greet(name: string) { return name }\nexport class Box {}\n'
    await writeFile(join(projectRoot, 'main.ts'), content)
    const posted: WorkbenchLanguageServiceWorkerResponse[] = []
    const scheduler = new WorkbenchLanguageServiceWorkerScheduler({
      dispatch: async (request) => {
        // 模拟请求算到一半时被新请求顶掉。
        markWorkbenchLanguageServiceRequestCancelled(buffer, request.id)
        return request.operation === 'getSemanticTokens'
          ? services.getSemanticTokens(request.request)
          : services.getDiagnostics(request.request as { projectRoot: string; path: string })
      },
      post: (message) => posted.push(message as WorkbenchLanguageServiceWorkerResponse),
      cancellation: buffer,
    })
    configureTypeScriptCancellation(() => scheduler.isRunningRequestCancelled())

    try {
      scheduler.receive({ id: 21, operation: 'getSemanticTokens', request: { projectRoot, path: 'main.ts', content } })
      scheduler.receive({ id: 22, operation: 'getDiagnostics', request: { projectRoot, path: 'main.ts', content } })
      for (let attempt = 0; attempt < 200 && posted.length < 2; attempt += 1)
        await new Promise((settle) => setTimeout(settle, 10))

      assert.equal(posted[0]?.id, 21)
      assert.equal(posted[0]?.error?.code, 'CANCELLED')
      // 诊断不参与顶替：照常算完。
      assert.equal(posted[1]?.id, 22)
      assert.equal(posted[1]?.error, undefined)
      assert.deepEqual((posted[1]?.result as { diagnostics: unknown[] }).diagnostics, [])

      // 没被取消的语义着色照常出结果（同一个服务还能用）。
      configureTypeScriptCancellation(() => false)
      const tokens = await services.getSemanticTokens({ projectRoot, path: 'main.ts', content })
      assert.ok(tokens.tokens.length > 0)
    } finally {
      configureTypeScriptCancellation(() => false)
      await services.dispose()
      clearTypeScriptProjectCache(projectRoot)
      await rm(projectRoot, { recursive: true, force: true })
    }
  })
})
