import { AsyncLocalStorage } from 'node:async_hooks'

import { AppError } from '@velaros-ai/velaros/core/error'

import type { WorkbenchLanguageServiceWorkerRequest } from './LanguageServiceWorkerProtocol'
import type {
  ProjectToolEndpointRequest,
  ProjectToolEndpointResponse,
  ProjectToolLanguageOperation,
  ProjectToolOperationMap,
  ProjectToolOperations,
  ProjectToolRunner,
} from './ProjectToolWorkerHost'

export async function finishProjectToolRun<T>(
  body: () => Promise<T>,
  finish: () => Promise<void>
): Promise<T> {
  const result = await Promise.resolve()
    .then(body)
    .then(
      (value) => ({ status: 'fulfilled' as const, value }),
      (reason: unknown) => ({ status: 'rejected' as const, reason })
    )
  try {
    await finish()
  } catch (error) {
    if (result.status === 'rejected' && result.reason === error) throw error
    if (result.status === 'rejected')
      throw new AggregateError([result.reason, error], 'Project tool request and close failed')
    throw error
  }
  if (result.status === 'rejected') throw result.reason
  return result.value
}

/** 只做语言 worker 已登记请求的结构化 RPC；不创建线程，不本地加载项目工具。 */
export class ProjectToolWorkerEndpoint implements ProjectToolRunner {
  private readonly context = new AsyncLocalStorage<WorkbenchLanguageServiceWorkerRequest>()
  private readonly pending = new Map<
    number,
    { resolve(value: ProjectToolEndpointResponse['result']): void; reject(error: Error): void }
  >()
  private nextCall = 1
  private failure?: AppError
  private closing?: Promise<void>

  public constructor(private readonly post: (message: ProjectToolEndpointRequest) => void) {}

  public withRequest<T>(request: WorkbenchLanguageServiceWorkerRequest, body: () => T): T {
    return this.context.run(request, body)
  }

  public async run<T>(
    operation: ProjectToolLanguageOperation,
    projectRoot: string,
    body: (tools: ProjectToolOperations) => Promise<T>
  ): Promise<T> {
    if (this.failure) throw this.failure
    if (this.closing) throw new AppError('CLOSED', 'Project tool endpoint is closed')
    const request = this.context.getStore()
    if (
      !request ||
      request.operation !== operation ||
      !('projectRoot' in request.request) ||
      request.request.projectRoot !== projectRoot
    )
      throw new AppError('INVARIANT', 'Project tool execution needs its language request')
    let used = false
    const invoke = <TOperation extends keyof ProjectToolOperationMap>(
      tool: TOperation,
      input: ProjectToolOperationMap[TOperation]['input']
    ): Promise<ProjectToolOperationMap[TOperation]['result']> => {
      used = true
      return this.send({
        control: 'project-tools',
        id: this.nextCall++,
        action: 'invoke',
        requestId: request.id,
        operation: tool,
        input,
      } as ProjectToolEndpointRequest) as Promise<ProjectToolOperationMap[TOperation]['result']>
    }
    return finishProjectToolRun(
      () =>
        Promise.resolve().then(() =>
          body({
            lint: (input) => invoke('lint', input),
            format: (input) => invoke('format', input),
          })
        ),
      async () => {
        if (used)
          await this.send({
            control: 'project-tools',
            id: this.nextCall++,
            action: 'finish',
            requestId: request.id,
          })
        if (this.failure) throw this.failure
        if (this.closing) throw new AppError('CLOSED', 'Project tool endpoint is closed')
      }
    )
  }

  private send(
    message: ProjectToolEndpointRequest
  ): Promise<ProjectToolEndpointResponse['result']> {
    if (this.failure) return Promise.reject(this.failure)
    return new Promise((resolve, reject) => {
      this.pending.set(message.id, { resolve, reject })
      try {
        this.post(message)
      } catch (error) {
        this.lose(AppError.from(error, 'IPC'))
      }
    })
  }

  public receive(message: unknown): message is ProjectToolEndpointResponse {
    if (
      typeof message !== 'object' ||
      message === null ||
      !('control' in message) ||
      message.control !== 'project-tools-result'
    )
      return false
    const response = message as ProjectToolEndpointResponse
    const pending = this.pending.get(response.id)
    if (pending) {
      this.pending.delete(response.id)
      if (response.error) pending.reject(AppError.fromJSON(response.error))
      else pending.resolve(response.result)
    }
    return true
  }

  public lose(error: AppError): void {
    this.failure ??= error
    for (const pending of this.pending.values()) pending.reject(this.failure)
    this.pending.clear()
  }

  public close(_deadlineAt: number): Promise<void> {
    if (!this.closing)
      this.closing = this.send({
        control: 'project-tools',
        id: this.nextCall++,
        action: 'close',
        requestId: this.context.getStore()?.id,
      }).then(() => undefined)
    return this.closing
  }
}
