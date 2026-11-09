import { totalmem } from 'node:os'
import { resolve } from 'node:path'
import { isMainThread, Worker } from 'node:worker_threads'

import { AppError, type SerializedError } from '@velaros-ai/velaros/core/error'

import type { WorkbenchLanguageServiceDiagnostic } from '@shared/contracts/workbench'

import { computeWorkbenchLanguageWorkerHeapLimitMb } from './LanguageServiceMemoryGuard'
import { getWorkbenchLanguageServiceRequestTimeoutMs } from './LanguageServiceWorkerProtocol'
import { finishProjectToolRun } from './ProjectToolWorkerEndpoint'

async function withinProjectToolDeadline<T>(pending: Promise<T>, deadlineAt: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const result = await Promise.race([
      pending,
      new Promise<never>((_accept, reject) => {
        timer = setTimeout(
          () => reject(new AppError('TIMEOUT', 'Project tool request timed out')),
          Math.max(0, deadlineAt - Date.now())
        )
      }),
    ])
    if (Date.now() >= deadlineAt)
      throw new AppError('TIMEOUT', 'Project tool request timed out')
    return result
  } finally {
    clearTimeout(timer)
  }
}

export interface ProjectToolOperationMap {
  lint: {
    input: { projectRoot: string; absolutePath: string; relativePath: string; content: string }
    result: WorkbenchLanguageServiceDiagnostic[]
  }
  format: {
    input: { projectRoot: string; absolutePath: string; content: string }
    result: string | null
  }
}

export type ProjectToolLanguageOperation = 'getDiagnostics' | 'getFormat'

export interface ProjectToolOperations {
  lint(
    input: ProjectToolOperationMap['lint']['input']
  ): Promise<ProjectToolOperationMap['lint']['result']>
  format(
    input: ProjectToolOperationMap['format']['input']
  ): Promise<ProjectToolOperationMap['format']['result']>
}

/** 一组只归一个 Services/语言 worker owner；run 不把工具模块或已结算结果留到下次请求。 */
export interface ProjectToolRunner {
  run<T>(
    operation: ProjectToolLanguageOperation,
    projectRoot: string,
    body: (tools: ProjectToolOperations) => Promise<T>
  ): Promise<T>
  close(deadlineAt: number): Promise<void>
}

export type ProjectToolWorkerRequest = {
  [TOperation in keyof ProjectToolOperationMap]: {
    id: number
    operation: TOperation
    input: ProjectToolOperationMap[TOperation]['input']
  }
}[keyof ProjectToolOperationMap]

export interface ProjectToolWorkerResponse {
  id: number
  result?: ProjectToolOperationMap[keyof ProjectToolOperationMap]['result']
  error?: SerializedError
}

export type ProjectToolEndpointRequest =
  | { control: 'project-tools'; id: number; action: 'close'; requestId?: number }
  | { control: 'project-tools'; id: number; action: 'finish'; requestId: number }
  | ({ control: 'project-tools'; requestId: number; action: 'invoke' } & ProjectToolWorkerRequest)

export interface ProjectToolEndpointResponse {
  control: 'project-tools-result'
  id: number
  result?: ProjectToolWorkerResponse['result']
  error?: SerializedError
}

interface ToolThread {
  worker: Worker
  exited: Promise<number>
  exitCode?: number
  termination?: Promise<void>
  calls: Map<
    number,
    { resolve(value: ProjectToolWorkerResponse['result']): void; reject(error: Error): void }
  >
}

/** main 持有的单次真实请求；body 完成不等于物理线程已退出。 */
export class ProjectToolRequest {
  public readonly operations: ProjectToolOperations
  public thread?: ToolThread
  public starting?: Promise<ToolThread>
  public closing?: Promise<void>
  public failure?: AppError
  public stopReason?: AppError
  public readonly stopped: Promise<void>
  private stop!: () => void

  public constructor(
    private readonly host: ProjectToolWorkerHost,
    public readonly owner: object,
    public readonly id: number,
    public readonly projectRoot: string,
    public readonly deadlineAt: number
  ) {
    this.stopped = new Promise((accept) => {
      this.stop = accept
    })
    this.operations = {
      lint: (input) => host.invoke(this, 'lint', input),
      format: (input) => host.invoke(this, 'format', input),
    }
  }

  public close(deadlineAt = this.deadlineAt, reason?: AppError): Promise<void> {
    if (this.closing) return this.closing
    const stopReason = reason ?? new AppError('CLOSED', 'Project tool request is closed')
    this.stopReason = stopReason
    this.stop()
    for (const call of this.thread?.calls.values() ?? []) call.reject(this.failure ?? stopReason)
    this.thread?.calls.clear()
    const releaseUnstarted = (): void => {
      if (!this.thread) this.host.release(this)
    }
    // 排队撤销/构造失败没有物理资源；即使原 close 已超时，真实准备结束后也释放登记。
    void (this.starting ?? Promise.resolve()).then(releaseUnstarted, releaseUnstarted)
    const until = Math.min(deadlineAt, this.deadlineAt)
    this.closing = (async () => {
      await withinProjectToolDeadline(
        this.starting?.then(() => undefined, () => undefined) ?? Promise.resolve(),
        until
      )
      const thread = this.thread
      if (thread) {
        if (!thread.termination) {
          thread.termination =
            thread.exitCode !== undefined
              ? Promise.resolve()
              : (async () => {
                  await thread.worker.terminate()
                  await thread.exited
                })()
        }
        await withinProjectToolDeadline(thread.termination, until)
      }
      this.host.release(this)
      if (this.failure) throw this.failure
    })()
    return this.closing
  }
}

/**
 * main 唯一物理 Tools Worker owner。所有请求排同一个实际线程槽，exit 前不创建后继；
 * 额外短命 isolate 使用既有 H 堆限额，H 不是两个 isolate 的聚合上限。
 */
export class ProjectToolWorkerHost implements ProjectToolRunner {
  private readonly requests = new Map<object, Map<number, ProjectToolRequest>>()
  private readonly ownerClosings = new WeakMap<object, Promise<void>>()
  private active?: ToolThread
  private nextRequest = 1
  private nextCall = 1
  private closing?: Promise<void>

  public constructor(private readonly workerPath: string | URL) {
    if (!isMainThread) throw new AppError('INVARIANT', 'Project tool workers belong to main')
  }

  public createRequest(
    owner: object,
    id: number,
    projectRoot: string,
    deadlineAt: number
  ): ProjectToolRequest {
    if (this.closing || this.ownerClosings.has(owner))
      throw new AppError('CLOSED', 'Project tool owner is closed')
    let requests = this.requests.get(owner)
    if (!requests) {
      requests = new Map()
      this.requests.set(owner, requests)
    }
    if (requests.has(id)) throw new AppError('CONFLICT', 'Project tool request already exists')
    const request = new ProjectToolRequest(this, owner, id, resolve(projectRoot), deadlineAt)
    requests.set(id, request)
    return request
  }

  public async run<T>(
    operation: ProjectToolLanguageOperation,
    projectRoot: string,
    body: (tools: ProjectToolOperations) => Promise<T>
  ): Promise<T> {
    const request = this.createRequest(
      this,
      this.nextRequest++,
      projectRoot,
      Date.now() + getWorkbenchLanguageServiceRequestTimeoutMs(operation)
    )
    return finishProjectToolRun(
      () =>
        withinProjectToolDeadline(
          Promise.resolve().then(() => body(request.operations)),
          request.deadlineAt
        ),
      async () => {
        const interrupted = request.stopReason
        await request.close()
        if (interrupted) throw interrupted
      }
    )
  }

  private assertActive(request: ProjectToolRequest): void {
    if (request.failure) throw request.failure
    if (request.stopReason) throw request.stopReason
    if (this.closing || this.ownerClosings.has(request.owner))
      throw new AppError('CLOSED', 'Project tool owner is closed')
    if (Date.now() >= request.deadlineAt)
      throw new AppError('TIMEOUT', 'Project tool request timed out')
  }

  private start(request: ProjectToolRequest): Promise<ToolThread> {
    if (request.starting) return request.starting
    request.starting = (async () => {
      this.assertActive(request)
      while (this.active) {
        await withinProjectToolDeadline(
          Promise.race([this.active.exited, request.stopped]),
          request.deadlineAt
        )
        this.assertActive(request)
      }
      // request 已在 main 登记；构造和真实 Worker/回执接纳间没有 await。
      const worker = new Worker(this.workerPath, {
        resourceLimits: {
          maxOldGenerationSizeMb: computeWorkbenchLanguageWorkerHeapLimitMb(totalmem()),
        },
      })
      let resolveExit!: (code: number) => void
      const thread: ToolThread = {
        worker,
        exited: new Promise((accept) => {
          resolveExit = accept
        }),
        calls: new Map(),
      }
      request.thread = thread
      this.active = thread
      const fail = (error: AppError): void => {
        request.failure ??= error
        for (const call of thread.calls.values()) call.reject(error)
        thread.calls.clear()
      }
      worker.on('message', (message: ProjectToolWorkerResponse) => {
        const call = thread.calls.get(message.id)
        if (!call) return
        thread.calls.delete(message.id)
        if (message.error) call.reject(AppError.fromJSON(message.error))
        else call.resolve(message.result)
      })
      worker.on('error', (error) => fail(AppError.from(error, 'PLATFORM')))
      worker.on('messageerror', (error) => fail(AppError.from(error, 'IPC')))
      worker.on('exit', (code) => {
        thread.exitCode = code
        if (this.active === thread) this.active = undefined
        if (!request.closing) fail(new AppError('PLATFORM', `Project tool worker exited (${code})`))
        resolveExit(code)
        // 保留原超时/终止失败 Promise；实际 exit 后不再强持已关闭的线程/请求。
        if (request.stopReason) this.release(request)
      })
      return thread
    })()
    return request.starting
  }

  public async invoke<TOperation extends keyof ProjectToolOperationMap>(
    request: ProjectToolRequest,
    operation: TOperation,
    input: ProjectToolOperationMap[TOperation]['input']
  ): Promise<ProjectToolOperationMap[TOperation]['result']> {
    this.assertActive(request)
    if (resolve(input.projectRoot) !== request.projectRoot)
      throw new AppError('CONFLICT', 'Project tool request changed project')
    const thread = await this.start(request)
    this.assertActive(request)
    const id = this.nextCall++
    const result = new Promise<ProjectToolWorkerResponse['result']>((accept, reject) => {
      thread.calls.set(id, { resolve: accept, reject })
      try {
        thread.worker.postMessage({ id, operation, input } as ProjectToolWorkerRequest)
      } catch (error) {
        thread.calls.delete(id)
        reject(AppError.from(error, 'IPC'))
      }
    })
    return (await withinProjectToolDeadline(
      result,
      request.deadlineAt
    )) as ProjectToolOperationMap[TOperation]['result']
  }

  public release(request: ProjectToolRequest): void {
    const requests = this.requests.get(request.owner)
    if (requests?.get(request.id) === request) requests.delete(request.id)
    if (requests?.size === 0) this.requests.delete(request.owner)
  }

  public finishRequest(owner: object, id: number): Promise<void> {
    return this.requests.get(owner)?.get(id)?.close() ?? Promise.resolve()
  }

  public closeOwner(owner: object, deadlineAt: number): Promise<void> {
    const current = this.ownerClosings.get(owner)
    if (current) return current
    const requests = [...(this.requests.get(owner)?.values() ?? [])]
    const closing = Promise.resolve().then(() => this.closeRequests(requests, deadlineAt))
    this.ownerClosings.set(owner, closing)
    for (const request of requests) void request.close(deadlineAt).catch(() => {})
    return closing
  }

  public closeProject(projectRoot: string, deadlineAt: number): Promise<void> {
    const root = resolve(projectRoot)
    const requests = [...this.requests.values()]
      .flatMap((group) => [...group.values()])
      .filter((request) => request.projectRoot === root)
    for (const request of requests)
      void request
        .close(deadlineAt, new AppError('CANCELLED', 'Language project was released'))
        .catch(() => {})
    return this.closeRequests(requests, deadlineAt)
  }

  private async closeRequests(requests: ProjectToolRequest[], deadlineAt: number): Promise<void> {
    const results = await withinProjectToolDeadline(
      Promise.allSettled(requests.map((request) => request.close(deadlineAt))),
      deadlineAt
    )
    const failures = results.flatMap((result) =>
      result.status === 'rejected' ? [result.reason] : []
    )
    if (failures.length) throw new AggregateError(failures, 'Project tool workers did not close')
  }

  public close(deadlineAt: number): Promise<void> {
    if (this.closing) return this.closing
    const requests = [...this.requests.values()].flatMap((group) => [...group.values()])
    this.closing = Promise.resolve().then(() => this.closeRequests(requests, deadlineAt))
    for (const request of requests) void request.close(deadlineAt).catch(() => {})
    return this.closing
  }
}
