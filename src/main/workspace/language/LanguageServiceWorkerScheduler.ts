import { AppError } from '@velaros-ai/velaros/core/error'

import { workbenchMainText } from '../../i18n/workbenchMainMessages'

import {
  getWorkbenchLanguageServiceWorkerPriority,
  isWorkbenchLanguageServiceOperationSuperseded,
  isWorkbenchLanguageServiceRequestCancelled,
  isWorkbenchLanguageServiceWorkerControl,
  type WorkbenchLanguageServiceWorkerControl,
  type WorkbenchLanguageServiceWorkerMessage,
  type WorkbenchLanguageServiceWorkerPong,
  type WorkbenchLanguageServiceWorkerPriority,
  type WorkbenchLanguageServiceWorkerRequest,
  type WorkbenchLanguageServiceWorkerResponse,
} from './LanguageServiceWorkerProtocol'

export interface WorkbenchLanguageServiceWorkerSchedulerOptions {
  dispatch: (
    request: WorkbenchLanguageServiceWorkerRequest,
    signal: AbortSignal
  ) => Promise<unknown>
  post: (
    message: WorkbenchLanguageServiceWorkerResponse | WorkbenchLanguageServiceWorkerPong
  ) => void
  /** 与主进程共享的取消缓冲（见 markWorkbenchLanguageServiceRequestCancelled）。 */
  cancellation?: Int32Array
}

interface RunningLanguageServiceRequest {
  request: WorkbenchLanguageServiceWorkerRequest
  controller: AbortController
  cancelled: boolean
}

/**
 * worker 里的请求调度：同一时刻只算一个请求（TypeScript LanguageService 的 overlay 与缓存是可变状态），
 * 生命周期与交互请求越过诊断、语义着色这类后台积压先算。控制消息不排队：`ping` 立刻回 `pong`，
 * `cancel` 把排队的请求丢掉、让正在算的尽快放弃。
 */
export class WorkbenchLanguageServiceWorkerScheduler {
  private readonly queues: Record<
    WorkbenchLanguageServiceWorkerPriority,
    WorkbenchLanguageServiceWorkerRequest[]
  > = {
    lifecycle: [],
    interactive: [],
    background: [],
  }
  private running: Nullable<RunningLanguageServiceRequest> = null
  private draining = false

  public constructor(private readonly options: WorkbenchLanguageServiceWorkerSchedulerOptions) {}

  /** 正在处理请求（内存看守此时不动手）。 */
  public get busy(): boolean {
    return this.draining
  }

  public receive(message: WorkbenchLanguageServiceWorkerMessage): void {
    if (isWorkbenchLanguageServiceWorkerControl(message)) {
      this.control(message)
      return
    }
    this.queues[getWorkbenchLanguageServiceWorkerPriority(message.operation)].push(message)
    void this.drain()
  }

  /**
   * 正在算的请求已被新请求顶掉。TypeScript 在同步计算里的取消检查点调用它：那时收不到消息，只能读共享缓冲。
   * 只有跟着光标走的请求会被顶掉；诊断这类请求中途放弃会让 TypeScript 丢掉整个类型检查器，从不取消。
   */
  public isRunningRequestCancelled(): boolean {
    const running = this.running
    if (!running || !isWorkbenchLanguageServiceOperationSuperseded(running.request.operation))
      return false
    if (!running.cancelled && this.options.cancellation)
      running.cancelled = isWorkbenchLanguageServiceRequestCancelled(
        this.options.cancellation,
        running.request.id
      )
    return running.cancelled
  }

  private control(message: WorkbenchLanguageServiceWorkerControl): void {
    if (message.control === 'ping') {
      this.options.post({ control: 'pong', id: message.id })
      return
    }
    // 还在排队：直接丢掉，主进程那边已经不等它的答复了。
    for (const queue of Object.values(this.queues)) {
      const index = queue.findIndex((request) => request.id === message.id)
      if (index < 0) continue
      queue.splice(index, 1)
      return
    }
    const running = this.running
    if (running?.request.id !== message.id) return
    running.cancelled = true
    running.controller.abort()
  }

  private next(): WorkbenchLanguageServiceWorkerRequest | undefined {
    return (
      this.queues.lifecycle.shift() ??
      this.queues.interactive.shift() ??
      this.queues.background.shift()
    )
  }

  private async drain(): Promise<void> {
    if (this.draining) return
    this.draining = true
    try {
      for (let request = this.next(); request; request = this.next()) await this.handle(request)
    } finally {
      this.draining = false
    }
  }

  private async handle(request: WorkbenchLanguageServiceWorkerRequest): Promise<void> {
    const running: RunningLanguageServiceRequest = {
      request,
      controller: new AbortController(),
      cancelled: false,
    }
    this.running = running
    let response: WorkbenchLanguageServiceWorkerResponse
    try {
      // 排队时就被顶掉了（取消消息还没轮到处理，共享缓冲里已经有它）：不必再算。
      if (this.isRunningRequestCancelled())
        throw new AppError('CANCELLED', workbenchMainText('language.requestCancelledPlain'))
      response = {
        id: request.id,
        result: await this.options.dispatch(request, running.controller.signal),
      }
    } catch (error) {
      // 取消后抛出的任何东西（TypeScript 的取消异常、被中止的外部请求）都按取消答复。
      response = {
        id: request.id,
        error: (running.cancelled
          ? new AppError(
              'CANCELLED',
              workbenchMainText('language.serviceRequestCancelled', {
                operation: request.operation,
              })
            )
          : AppError.from(error)
        ).toJSON(),
      }
    } finally {
      this.running = null
    }
    this.options.post(response)
  }
}
