/**
 * 主进程这边的搜索 worker（跑的活见 ContentSearchTask）：一次搜索、一次替换请求各开一个会话，会话里的请求
 * 一个接一个发给同一个 worker，会话结束就结束 worker。
 *
 * - 取消（搜索被新的顶掉、窗口关了）就结束 worker：卡在正则里的 worker 收不到别的消息，只能整个结束。
 * - worker 接下请求以后久没有动静（进度、结果、心跳都没有，默认 10 秒）就算卡在正则里，结束它，报告卡在
 *   哪个文件上；等读盘时 worker 照样报心跳，不会被当成卡住。同一会话后面的请求再开新的 worker。
 * - worker 设了堆上限：真把内存吃光时是 worker 出错退出，不是整个主进程崩掉。
 * - worker 与主进程不共用模块状态：界面语言随每个请求带过去，worker 里出的文字才跟着界面走。
 */
import { resolve } from 'node:path'
import { Worker } from 'node:worker_threads'

import { AppError } from '@velaros-ai/core/error'

import type { WorkbenchSearchContentBatch } from '@shared/contracts'

import { getWorkbenchMainLocale } from '../i18n/workbenchMainLocale'
import { workbenchMainText } from '../i18n/workbenchMainMessages'

import type {
  WorkbenchContentReplaceTask,
  WorkbenchContentReplaceTaskResult,
  WorkbenchContentSearchTask,
  WorkbenchContentSearchTaskResult,
  WorkbenchContentSearchWorkerRequest,
  WorkbenchContentSearchWorkerResponse,
} from './ContentSearchTask'

export interface WorkbenchContentSearchWorkerPort {
  postMessage(message: WorkbenchContentSearchWorkerRequest): void
  on(event: 'message', listener: (message: unknown) => void): this
  on(event: 'error', listener: (error: Error) => void): this
  on(event: 'exit', listener: (exitCode: number) => void): this
  terminate(): Promise<number>
}

export type WorkbenchContentSearchWorkerFactory = () => WorkbenchContentSearchWorkerPort

/** 内容搜索 worker 的设置（createWorkbenchAppParts 的 searchWorker）。 */
export interface WorkbenchContentSearchWorkerOptions {
  /** 起一个 worker；默认起构建产物里的 `workbench-search-worker.js`。 */
  createWorker?: WorkbenchContentSearchWorkerFactory
  /** worker 接下请求以后这么久没有动静就算卡住，结束它（默认 10 秒）。 */
  stallTimeoutMs?: number
}

/** 开一个会话：一次搜索，或一次替换涉及的所有文件。 */
export type OpenWorkbenchContentSearchSession = () => WorkbenchContentSearchWorkerSession

const WorkerHeapLimitMb = 512
const DefaultStallTimeoutMs = 10_000
/** 发出请求后，worker 起来并接下它最多等这么久。 */
const StartTimeoutMs = 10_000

/** 构建产物里与主进程入口同目录的 `workbench-search-worker.js`（见 electron.vite.config.ts）。 */
export function createDefaultWorkbenchContentSearchWorker(): WorkbenchContentSearchWorkerPort {
  return new Worker(resolve(__dirname, 'workbench-search-worker.js'), {
    resourceLimits: { maxOldGenerationSizeMb: WorkerHeapLimitMb },
  })
}

export function createWorkbenchContentSearchSessionOpener(
  options: WorkbenchContentSearchWorkerOptions = {}
): OpenWorkbenchContentSearchSession {
  const createWorker = options.createWorker ?? createDefaultWorkbenchContentSearchWorker
  return () => new WorkbenchContentSearchWorkerSession(createWorker, options.stallTimeoutMs)
}

interface PendingRequest {
  id: number
  resolve: (result: unknown) => void
  reject: (error: AppError) => void
  onBatch?: (batch: WorkbenchSearchContentBatch) => void
  /** worker 正在搜的文件，卡住时报给用户。 */
  currentPath: Nullable<string>
  timer: ReturnType<typeof setTimeout>
}

export class WorkbenchContentSearchWorkerSession {
  private worker: Nullable<WorkbenchContentSearchWorkerPort> = null
  private pending: Nullable<PendingRequest> = null
  private nextRequestId = 1

  public constructor(
    private readonly createWorker: WorkbenchContentSearchWorkerFactory,
    private readonly stallTimeoutMs = DefaultStallTimeoutMs
  ) {}

  /** 在一组文件里搜；给了 signal 且被取消时结束 worker，返回 null。 */
  public async search(
    task: WorkbenchContentSearchTask,
    options: { signal?: AbortSignal; onBatch?: (batch: WorkbenchSearchContentBatch) => void } = {}
  ): Promise<Nullable<WorkbenchContentSearchTaskResult>> {
    const { signal } = options
    if (signal?.aborted) return null

    const cancelled = Symbol('cancelled')
    let abort: () => void = () => undefined
    const aborted = new Promise<typeof cancelled>((resolveAborted) => {
      abort = () => {
        this.discard(new AppError('CANCELLED', workbenchMainText('search.cancelled')))
        resolveAborted(cancelled)
      }
      signal?.addEventListener('abort', abort, { once: true })
    })
    const searching = this.request<WorkbenchContentSearchTaskResult>(
      { kind: 'search', task, stream: !!options.onBatch },
      { onBatch: options.onBatch }
    )
    try {
      const result = await Promise.race([searching, aborted])
      return result === cancelled ? null : result
    } catch (error) {
      if (signal?.aborted) return null
      throw error
    } finally {
      signal?.removeEventListener('abort', abort)
    }
  }

  /** 算一个文件替换后的正文；path 是这个文件，卡住时报给用户。 */
  public replace(
    task: WorkbenchContentReplaceTask,
    path: string
  ): Promise<WorkbenchContentReplaceTaskResult> {
    return this.request<WorkbenchContentReplaceTaskResult>(
      { kind: 'replace', task },
      { currentPath: path }
    )
  }

  /** 会话结束：结束 worker（还在跑的请求按取消处理）。 */
  public close(): void {
    this.discard(new AppError('CANCELLED', workbenchMainText('search.ended')))
  }

  private request<T>(
    message:
      | Omit<Extract<WorkbenchContentSearchWorkerRequest, { kind: 'search' }>, 'id' | 'locale'>
      | Omit<Extract<WorkbenchContentSearchWorkerRequest, { kind: 'replace' }>, 'id' | 'locale'>,
    options: { onBatch?: (batch: WorkbenchSearchContentBatch) => void; currentPath?: string }
  ): Promise<T> {
    if (this.pending)
      return Promise.reject(new AppError('INVARIANT', '搜索 worker 同一时间只处理一个请求。'))

    const worker = this.ensureWorker()
    const id = this.nextRequestId
    this.nextRequestId += 1
    return new Promise<T>((resolvePromise, rejectPromise) => {
      this.pending = {
        id,
        resolve: resolvePromise as (result: unknown) => void,
        reject: rejectPromise,
        onBatch: options.onBatch,
        currentPath: options.currentPath ?? null,
        timer: setTimeout(() => this.stall(), StartTimeoutMs),
      }
      worker.postMessage({
        ...message,
        id,
        locale: getWorkbenchMainLocale(),
      } as WorkbenchContentSearchWorkerRequest)
    })
  }

  private ensureWorker(): WorkbenchContentSearchWorkerPort {
    if (this.worker) return this.worker

    const worker = this.createWorker()
    this.worker = worker
    worker.on('message', (message) => {
      if (this.worker === worker) this.receive(message as WorkbenchContentSearchWorkerResponse)
    })
    worker.on('error', (error) => {
      if (this.worker === worker) this.discard(toWorkerFailure(error))
    })
    worker.on('exit', () => {
      if (this.worker === worker)
        this.discard(new AppError('CLOSED', workbenchMainText('search.workerExited')))
    })
    return worker
  }

  private receive(message: WorkbenchContentSearchWorkerResponse): void {
    const pending = this.pending
    if (!pending || message.id !== pending.id) return

    clearTimeout(pending.timer)
    pending.timer = setTimeout(() => this.stall(), this.stallTimeoutMs)
    switch (message.kind) {
      case 'started':
        return
      case 'file':
        pending.currentPath = message.path
        return
      case 'heartbeat':
        // 报得出心跳，说明上一个文件已经搜完，在等读盘。
        pending.currentPath = null
        return
      case 'batch':
        pending.onBatch?.(message.batch)
        return
      case 'result':
        this.settle()
        pending.resolve(message.result)
        return
      case 'error':
        this.settle()
        pending.reject(new AppError(message.code ?? 'UNKNOWN', message.message))
    }
  }

  /** 久没有动静：多半卡在正则的回溯里，结束 worker。 */
  private stall(): void {
    const path = this.pending?.currentPath
    this.discard(
      new AppError(
        'TIMEOUT',
        path
          ? workbenchMainText('search.stalledOnFile', { path })
          : workbenchMainText('search.stalled')
      )
    )
  }

  private settle(): void {
    if (this.pending) clearTimeout(this.pending.timer)
    this.pending = null
  }

  /** 结束 worker；还在等的请求以 error 结束。 */
  private discard(error: AppError): void {
    const pending = this.pending
    this.settle()
    const worker = this.worker
    this.worker = null
    if (worker) void worker.terminate().catch(() => undefined)
    pending?.reject(error)
  }
}

/** worker 出错退出的原因；撞到堆上限的说成人话。 */
function toWorkerFailure(error: Error): AppError {
  return (error as { code?: string }).code === 'ERR_WORKER_OUT_OF_MEMORY'
    ? new AppError('LIMIT', workbenchMainText('search.outOfMemory'), error)
    : AppError.from(error)
}
