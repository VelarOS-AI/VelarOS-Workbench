import { resolve } from 'node:path'
import { Worker } from 'node:worker_threads'

import { AppError } from '@velaros-ai/core/error'

import type {
  WorkbenchLanguageServiceCodeActionsRequest,
  WorkbenchLanguageServiceExtensionRequest,
  WorkbenchLanguageServiceInlayHintsRequest,
  WorkbenchLanguageServicePositionRequest,
  WorkbenchLanguageServiceRenameRequest,
  WorkbenchLanguageServiceRequest,
} from '@shared/contracts'

import type {
  WorkbenchLanguageServiceProjectFileRequest,
  WorkbenchLanguageServiceProjectFilesChangedRequest,
  WorkbenchLanguageServiceProjectRequest,
  WorkbenchLanguageServiceWorkerOperation,
  WorkbenchLanguageServiceWorkerOperationMap,
  WorkbenchLanguageServiceWorkerRequest,
  WorkbenchLanguageServiceWorkerResponse,
} from './LanguageServiceWorkerProtocol'

export interface WorkbenchLanguageServiceWorkerPort {
  postMessage(message: WorkbenchLanguageServiceWorkerRequest): void
  on(event: 'message', listener: (message: unknown) => void): this
  on(event: 'error', listener: (error: Error) => void): this
  on(event: 'exit', listener: (exitCode: number) => void): this
  terminate(): Promise<number>
}

type WorkbenchLanguageServiceWorkerFactory = () => WorkbenchLanguageServiceWorkerPort

const GracefulWorkerShutdownTimeoutMs = 8_000

interface PendingLanguageServiceRequest {
  resolve: (result: unknown) => void
  reject: (error: AppError) => void
}

interface InFlightDiagnosticsRequest {
  request: WorkbenchLanguageServiceRequest
  promise: Promise<WorkbenchLanguageServiceWorkerOperationMap['getDiagnostics']['result']>
}

function isSameOpenFiles(
  left: WorkbenchLanguageServiceRequest['openFiles'],
  right: WorkbenchLanguageServiceRequest['openFiles']
): boolean {
  if (left === right) return true
  if (!left || !right || left.length !== right.length) return false

  return left.every(
    (file, index) => file.path === right[index]?.path && file.content === right[index]?.content
  )
}

function isSameDiagnosticsRequest(
  left: WorkbenchLanguageServiceRequest,
  right: WorkbenchLanguageServiceRequest
): boolean {
  return (
    left.projectRoot === right.projectRoot &&
    left.path === right.path &&
    left.language === right.language &&
    left.content === right.content &&
    isSameOpenFiles(left.openFiles, right.openFiles)
  )
}

function isWorkerResponse(value: unknown): value is WorkbenchLanguageServiceWorkerResponse {
  if (typeof value !== 'object' || value === null) return false

  return typeof (value as { id?: unknown }).id === 'number'
}

function createDefaultLanguageServiceWorker(): WorkbenchLanguageServiceWorkerPort {
  return new Worker(resolve(__dirname, 'workbench-language-worker.js'))
}

/**
 * TypeScript 建图、诊断和符号分析都可能持续数秒；这些任务必须留在 worker，
 * 否则一次首文件诊断就会阻塞 Electron 主进程和所有窗口交互。
 */
export class WorkbenchLanguageServiceWorkerClient {
  private worker: Nullable<WorkbenchLanguageServiceWorkerPort> = null
  private disposed = false
  private nextRequestId = 1
  private readonly pending = new Map<number, PendingLanguageServiceRequest>()
  private readonly inFlightDiagnostics: InFlightDiagnosticsRequest[] = []

  constructor(
    private readonly createWorker: WorkbenchLanguageServiceWorkerFactory = createDefaultLanguageServiceWorker
  ) {}

  public synchronizeProjectFile(
    request: WorkbenchLanguageServiceProjectFileRequest
  ): Promise<void> {
    if (!this.worker) return Promise.resolve()
    return this.call('synchronizeProjectFile', request)
  }

  public invalidateProject(request: WorkbenchLanguageServiceProjectRequest): Promise<void> {
    if (!this.worker) return Promise.resolve()
    return this.call('invalidateProject', request)
  }

  public projectFilesChanged(
    request: WorkbenchLanguageServiceProjectFilesChangedRequest
  ): Promise<void> {
    if (!this.worker) return Promise.resolve()
    return this.call('projectFilesChanged', request)
  }

  public requestExtension(request: WorkbenchLanguageServiceExtensionRequest) {
    return this.call('requestExtension', request)
  }

  public resolveLanguageService(request: WorkbenchLanguageServiceRequest) {
    return this.call('resolveLanguageService', request)
  }

  public getDefinition(request: WorkbenchLanguageServicePositionRequest) {
    return this.call('getDefinition', request)
  }

  public getCompletions(request: WorkbenchLanguageServicePositionRequest) {
    return this.call('getCompletions', request)
  }

  public getDiagnostics(request: WorkbenchLanguageServiceRequest) {
    return this.call('getDiagnostics', request)
  }

  public getRename(request: WorkbenchLanguageServiceRenameRequest) {
    return this.call('getRename', request)
  }

  public getHover(request: WorkbenchLanguageServicePositionRequest) {
    return this.call('getHover', request)
  }

  public getReferences(request: WorkbenchLanguageServicePositionRequest) {
    return this.call('getReferences', request)
  }

  public getSignatureHelp(request: WorkbenchLanguageServicePositionRequest) {
    return this.call('getSignatureHelp', request)
  }

  public getFormat(request: WorkbenchLanguageServiceRequest) {
    return this.call('getFormat', request)
  }

  public getDocumentSymbols(request: WorkbenchLanguageServiceRequest) {
    return this.call('getDocumentSymbols', request)
  }

  public getDocumentHighlights(request: WorkbenchLanguageServicePositionRequest) {
    return this.call('getDocumentHighlights', request)
  }

  public getInlayHints(request: WorkbenchLanguageServiceInlayHintsRequest) {
    return this.call('getInlayHints', request)
  }

  public getSemanticTokens(request: WorkbenchLanguageServiceRequest) {
    return this.call('getSemanticTokens', request)
  }

  public getCodeActions(request: WorkbenchLanguageServiceCodeActionsRequest) {
    return this.call('getCodeActions', request)
  }

  public async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    const worker = this.worker
    if (!worker) {
      this.rejectPending(new AppError('IPC', 'Workbench 语言服务已关闭。'))
      return
    }

    let timeout: Nullable<ReturnType<typeof setTimeout>> = null
    try {
      const gracefulShutdown = this.sendToWorker(worker, 'shutdown', {})
      await Promise.race([
        gracefulShutdown,
        new Promise<void>((_resolve, reject) => {
          timeout = setTimeout(() => {
            reject(new AppError('IPC', 'Workbench 语言服务关闭超时。'))
          }, GracefulWorkerShutdownTimeoutMs)
        }),
      ])
    } catch {
      // worker 已异常或服务端无响应时仍需继续退出；terminate 是最终兜底。
    } finally {
      if (timeout) clearTimeout(timeout)
      if (this.worker === worker) this.worker = null
      this.rejectPending(new AppError('IPC', 'Workbench 语言服务已关闭。'))
      await worker.terminate().catch(() => 0)
    }
  }

  private call<TOperation extends WorkbenchLanguageServiceWorkerOperation>(
    operation: TOperation,
    request: WorkbenchLanguageServiceWorkerOperationMap[TOperation]['request']
  ): Promise<WorkbenchLanguageServiceWorkerOperationMap[TOperation]['result']> {
    if (operation !== 'getDiagnostics') return this.send(operation, request)

    const diagnosticsRequest = request as WorkbenchLanguageServiceRequest
    const current = this.inFlightDiagnostics.find((item) =>
      isSameDiagnosticsRequest(item.request, diagnosticsRequest)
    )
    if (current)
      return current.promise as Promise<
        WorkbenchLanguageServiceWorkerOperationMap[TOperation]['result']
      >

    const promise = this.send(operation, request)
    const inFlight = {
      request: diagnosticsRequest,
      promise: promise as Promise<
        WorkbenchLanguageServiceWorkerOperationMap['getDiagnostics']['result']
      >,
    }
    this.inFlightDiagnostics.push(inFlight)
    const removeInFlight = (): void => {
      const index = this.inFlightDiagnostics.indexOf(inFlight)
      if (index >= 0) this.inFlightDiagnostics.splice(index, 1)
    }
    void promise.then(removeInFlight, removeInFlight)
    return promise
  }

  private send<TOperation extends WorkbenchLanguageServiceWorkerOperation>(
    operation: TOperation,
    request: WorkbenchLanguageServiceWorkerOperationMap[TOperation]['request']
  ): Promise<WorkbenchLanguageServiceWorkerOperationMap[TOperation]['result']> {
    const worker = this.ensureWorker()
    return this.sendToWorker(worker, operation, request)
  }

  private sendToWorker<TOperation extends WorkbenchLanguageServiceWorkerOperation>(
    worker: WorkbenchLanguageServiceWorkerPort,
    operation: TOperation,
    request: WorkbenchLanguageServiceWorkerOperationMap[TOperation]['request']
  ): Promise<WorkbenchLanguageServiceWorkerOperationMap[TOperation]['result']> {
    const id = this.nextRequestId++

    return new Promise((resolvePromise, reject) => {
      this.pending.set(id, {
        resolve: (result) =>
          resolvePromise(
            result as WorkbenchLanguageServiceWorkerOperationMap[TOperation]['result']
          ),
        reject,
      })

      try {
        worker.postMessage({ id, operation, request } as WorkbenchLanguageServiceWorkerRequest)
      } catch (error) {
        this.pending.delete(id)
        reject(AppError.from(error, 'IPC'))
      }
    })
  }

  private ensureWorker(): WorkbenchLanguageServiceWorkerPort {
    if (this.disposed) throw new AppError('IPC', 'Workbench 语言服务已关闭。')
    if (this.worker) return this.worker

    const worker = this.createWorker()
    this.worker = worker
    worker.on('message', (message) => this.handleWorkerMessage(message))
    worker.on('error', (error) => this.handleWorkerFailure(worker, error))
    worker.on('exit', (exitCode) => {
      if (this.worker !== worker) return
      this.handleWorkerFailure(
        worker,
        new AppError('IPC', `Workbench 语言服务 worker 已退出（${exitCode}）。`)
      )
    })
    return worker
  }

  private handleWorkerMessage(message: unknown): void {
    if (!isWorkerResponse(message)) return

    const pending = this.pending.get(message.id)
    if (!pending) return

    this.pending.delete(message.id)
    if (message.error) {
      pending.reject(AppError.fromJSON(message.error))
      return
    }
    pending.resolve(message.result)
  }

  private handleWorkerFailure(worker: WorkbenchLanguageServiceWorkerPort, error: unknown): void {
    if (this.worker !== worker) return

    this.worker = null
    this.rejectPending(AppError.from(error, 'IPC'))
  }

  private rejectPending(error: AppError): void {
    for (const pending of this.pending.values()) pending.reject(error)
    this.pending.clear()
    this.inFlightDiagnostics.splice(0)
  }
}
