import { totalmem } from 'node:os'
import { resolve } from 'node:path'
import { MessageChannel, type MessagePort, Worker } from 'node:worker_threads'

import { type AppLocale } from '@velaros-ai/ui/conversation/contracts'
import { Log } from '@velaros-ai/velaros/core'
import { AppError } from '@velaros-ai/velaros/core/error'

import {
  type WorkbenchLanguageServiceCallHierarchyRequest,
  type WorkbenchLanguageServiceCodeActionResolveRequest,
  type WorkbenchLanguageServiceCodeActionsRequest,
  type WorkbenchLanguageServiceCompletionResolveRequest,
  type WorkbenchLanguageServiceExtensionRequest,
  type WorkbenchLanguageServiceFileRenameEditsRequest,
  type WorkbenchLanguageServiceInlayHintsRequest,
  type WorkbenchLanguageServicePositionRequest,
  type WorkbenchLanguageServiceProjectDiagnosticsRequest,
  type WorkbenchLanguageServiceRenameRequest,
  type WorkbenchLanguageServiceRequest,
} from '@shared/contracts/workbench'

import {
  getWorkbenchMainLocale,
  onWorkbenchMainLocaleChanged,
} from '../../i18n/workbenchMainLocale'
import { workbenchMainText } from '../../i18n/workbenchMainMessages'

import {
  ExternalLspProcessHost,
  type ExternalLspWorkerProcessScope,
} from './ExternalLspProcessHost'
import {
  type ExternalLspProjectLease,
  ExternalLspTerminationReserveMs,
  withinLspDeadline,
} from './ExternalLspTransport'
import {
  computeWorkbenchLanguageWorkerHeapLimitMb,
  isWorkbenchLanguageMemoryNotification,
} from './LanguageServiceMemoryGuard'
import {
  createWorkbenchLanguageServiceCancellationBuffer,
  getWorkbenchLanguageServiceRequestTimeoutMs,
  markWorkbenchLanguageServiceRequestCancelled,
  type WorkbenchLanguageServiceProjectFilesChangedRequest,
  type WorkbenchLanguageServiceProjectRequest,
  type WorkbenchLanguageServiceWorkerLocale,
  type WorkbenchLanguageServiceWorkerMessage,
  type WorkbenchLanguageServiceWorkerOperation,
  type WorkbenchLanguageServiceWorkerOperationMap,
  type WorkbenchLanguageServiceWorkerResponse,
} from './LanguageServiceWorkerProtocol'
import {
  type ProjectToolEndpointRequest,
  type ProjectToolEndpointResponse,
  type ProjectToolRequest,
  ProjectToolWorkerHost,
} from './ProjectToolWorkerHost'

export interface WorkbenchLanguageServiceWorkerPort {
  postMessage(
    message:
      | WorkbenchLanguageServiceWorkerMessage
      | WorkbenchLanguageServiceWorkerLocale
      | ProjectToolEndpointResponse
  ): void
  on(event: 'message', listener: (message: unknown) => void): this
  on(event: 'error', listener: (error: Error) => void): this
  on(event: 'exit', listener: (exitCode: number) => void): this
  terminate(): Promise<number>
}

export interface WorkbenchLanguageServiceWorkerFactoryOptions {
  /** Electron's resourcesPath is not inherited by Node worker threads. */
  resourcesPath?: string
  /** 真实 LSP 管道端点；ChildProcess 始终由 main 持有。 */
  processPort: MessagePort
  /** 取消缓冲：worker 陷在同步计算里收不到消息时，也能从这里读到自己的请求已被取消。 */
  cancellation: SharedArrayBuffer
  /** 创建时的界面语言，worker 里给用户看的提示按它出。 */
  locale: AppLocale
}

type WorkbenchLanguageServiceWorkerFactory = (
  options: WorkbenchLanguageServiceWorkerFactoryOptions
) => WorkbenchLanguageServiceWorkerPort

export interface WorkbenchLanguageServiceWorkerHealthOptions {
  /** 请求超时后发探活；worker 这么久还不回 `pong` 才算卡死、重启。 */
  hangTimeoutMs: number
  /** 崩溃或卡死后重建 worker 的退避：首次立即，之后从这个值起翻倍。 */
  restartBackoffMs: number
  restartBackoffMaxMs: number
  /** worker 平稳跑过这么久才崩，不算接连失败，退避从头算。 */
  restartBackoffResetMs: number
}

const GracefulWorkerShutdownTimeoutMs = 8_000
const DefaultWorkerHealth: WorkbenchLanguageServiceWorkerHealthOptions = {
  hangTimeoutMs: 20_000,
  restartBackoffMs: 1_000,
  restartBackoffMaxMs: 30_000,
  restartBackoffResetMs: 60_000,
}

type WorkbenchLanguageServiceRequestTimeout = (
  operation: WorkbenchLanguageServiceWorkerOperation,
  initializingProject?: boolean
) => number

interface LanguageServiceWorkerInstance {
  readyProjects: Set<string>
  processes: ExternalLspWorkerProcessScope
  processPort: MessagePort
  port: WorkbenchLanguageServiceWorkerPort
  cancellation: Int32Array
  startedAt: number
  /** 在等 `pong` 的探活。 */
  probe: Nullable<{ id: number; timer: ReturnType<typeof setTimeout> }>
}

interface PendingLanguageServiceRequest {
  projectLease?: ExternalLspProjectLease
  tools?: ProjectToolRequest
  id: number
  operation: WorkbenchLanguageServiceWorkerOperation
  request: unknown
  /** 已经发给了哪个 worker；null 表示还在等重启退避结束。 */
  worker: Nullable<LanguageServiceWorkerInstance>
  supersedeKey?: string
  resolve: (result: unknown) => void
  reject: (error: AppError) => void
  timeout: Nullable<ReturnType<typeof setTimeout>>
  /** 实际发给 worker 后的截止时间，供探活避开仍在预算内的同步诊断。 */
  deadlineAt: Nullable<number>
}

interface InFlightDiagnosticsRequest {
  request: WorkbenchLanguageServiceRequest
  promise: Promise<WorkbenchLanguageServiceWorkerOperationMap['getDiagnostics']['result']>
}

/** 跟着光标走的请求按「窗口 + 文件」互相顶替：同一处的新请求一到，旧的取消。 */
export interface WorkbenchLanguageServiceSupersedeScope {
  /** 发请求的窗口（IPC sender）；省略时不做顶替。 */
  scope?: string
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

function isWorkerPong(value: unknown): value is { control: 'pong'; id: number } {
  if (typeof value !== 'object' || value === null) return false
  const { control, id } = value as { control?: unknown; id?: unknown }
  return control === 'pong' && typeof id === 'number'
}

const log = Log.tag('WorkbenchLanguageService')
const WorkerOutOfMemoryCode = 'ERR_WORKER_OUT_OF_MEMORY'

function createDefaultLanguageServiceWorker({
  processPort,
  cancellation,
  locale,
  resourcesPath,
}: WorkbenchLanguageServiceWorkerFactoryOptions): WorkbenchLanguageServiceWorkerPort {
  // 显式的堆上限让 OOM 变成可恢复的 worker 终止（error 事件），而不是 Node 直接 abort 整个主进程。
  return new Worker(resolve(__dirname, 'workbench-language-worker.js'), {
    resourceLimits: {
      maxOldGenerationSizeMb: computeWorkbenchLanguageWorkerHeapLimitMb(totalmem()),
    },
    workerData: { cancellation, locale, processPort, resourcesPath },
    transferList: [processPort],
  })
}

function isWorkerOutOfMemory(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === WorkerOutOfMemoryCode
}

/**
 * TypeScript 建图、诊断和符号分析都可能持续数秒；这些任务必须留在 worker，
 * 否则一次首文件诊断就会阻塞 Electron 主进程和所有窗口交互。
 *
 * 一个请求超时只让它自己失败（并通知 worker 放弃它），TypeScript 的项目状态与外部语言服务器会话都留着；
 * 只有 worker 真崩了，或超时后连探活都答不上（卡死），才换一个新 worker，接连失败时按退避间隔重建。
 */
export class WorkbenchLanguageServiceWorkerClient {
  private worker: Nullable<LanguageServiceWorkerInstance> = null
  private disposed = false
  private disposal?: Promise<void>
  private readonly processes = new ExternalLspProcessHost()
  private readonly tools = new ProjectToolWorkerHost(
    resolve(__dirname, 'workbench-project-tools-worker.js')
  )
  private readonly retiring = new Map<
    LanguageServiceWorkerInstance | ExternalLspWorkerProcessScope,
    Promise<unknown>
  >()
  private nextRequestId = 1
  private readonly pending = new Map<number, PendingLanguageServiceRequest>()
  private readonly supersedable = new Map<string, number>()
  private readonly inFlightDiagnostics: InFlightDiagnosticsRequest[] = []
  private readonly health: WorkbenchLanguageServiceWorkerHealthOptions
  /** 界面语言换了就告诉 worker；关闭时取消。 */
  private readonly stopFollowingLocale: () => void
  private consecutiveFailures = 0
  private restartNotBefore = 0
  private restartTimer: Nullable<ReturnType<typeof setTimeout>> = null

  constructor(
    private readonly createWorker: WorkbenchLanguageServiceWorkerFactory = createDefaultLanguageServiceWorker,
    private readonly requestTimeoutMs: WorkbenchLanguageServiceRequestTimeout = getWorkbenchLanguageServiceRequestTimeoutMs,
    health: Partial<WorkbenchLanguageServiceWorkerHealthOptions> = {}
  ) {
    this.health = { ...DefaultWorkerHealth, ...health }
    this.stopFollowingLocale = onWorkbenchMainLocaleChanged(() =>
      this.worker?.port.postMessage({ locale: getWorkbenchMainLocale() })
    )
  }

  public invalidateProject(request: WorkbenchLanguageServiceProjectRequest): Promise<void> {
    const root = resolve(request.projectRoot)
    this.worker?.readyProjects.delete(root)
    for (const pending of [...this.pending.values()])
      if (pending.projectLease?.projectRoot === root)
        this.cancel(pending.id, new AppError('CANCELLED', 'Language project was released'))
    const deadlineAt = Date.now() + this.requestTimeoutMs('invalidateProject')
    return Promise.allSettled([
      this.processes.releaseProject(root, deadlineAt, () =>
        this.worker ? this.call('invalidateProject', request) : Promise.resolve()
      ),
      this.tools.closeProject(root, deadlineAt),
    ]).then((results) => {
      const failures = results.flatMap((result) =>
        result.status === 'rejected' ? [result.reason] : []
      )
      if (failures.length) throw new AggregateError(failures, 'Language project did not close')
    })
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

  public getDefinition(request: WorkbenchLanguageServicePositionRequest) {
    return this.call('getDefinition', request)
  }

  public getCompletions(
    request: WorkbenchLanguageServicePositionRequest,
    options: WorkbenchLanguageServiceSupersedeScope = {}
  ) {
    return this.call(
      'getCompletions',
      request,
      this.supersedeKey('getCompletions', request, options)
    )
  }

  /** 接受补全时要的附加改动：不参与顶替（选中另一项的预取不能把已接受那一项的导入取消掉）。 */
  public resolveCompletion(request: WorkbenchLanguageServiceCompletionResolveRequest) {
    return this.call('resolveCompletion', request)
  }

  public getDiagnostics(request: WorkbenchLanguageServiceRequest) {
    return this.call('getDiagnostics', request)
  }

  /** 整项目检查的一批（见 LanguageServices.getProjectDiagnostics）。 */
  public getProjectDiagnostics(request: WorkbenchLanguageServiceProjectDiagnosticsRequest) {
    return this.call('getProjectDiagnostics', request)
  }

  public getRename(request: WorkbenchLanguageServiceRenameRequest) {
    return this.call('getRename', request)
  }

  public getHover(
    request: WorkbenchLanguageServicePositionRequest,
    options: WorkbenchLanguageServiceSupersedeScope = {}
  ) {
    return this.call('getHover', request, this.supersedeKey('getHover', request, options))
  }

  public getReferences(request: WorkbenchLanguageServicePositionRequest) {
    return this.call('getReferences', request)
  }

  public getSignatureHelp(
    request: WorkbenchLanguageServicePositionRequest,
    options: WorkbenchLanguageServiceSupersedeScope = {}
  ) {
    return this.call(
      'getSignatureHelp',
      request,
      this.supersedeKey('getSignatureHelp', request, options)
    )
  }

  public getFormat(request: WorkbenchLanguageServiceRequest) {
    return this.call('getFormat', request)
  }

  public getDocumentSymbols(request: WorkbenchLanguageServiceRequest) {
    return this.call('getDocumentSymbols', request)
  }

  public getDocumentHighlights(
    request: WorkbenchLanguageServicePositionRequest,
    options: WorkbenchLanguageServiceSupersedeScope = {}
  ) {
    return this.call(
      'getDocumentHighlights',
      request,
      this.supersedeKey('getDocumentHighlights', request, options)
    )
  }

  public getInlayHints(
    request: WorkbenchLanguageServiceInlayHintsRequest,
    options: WorkbenchLanguageServiceSupersedeScope = {}
  ) {
    return this.call('getInlayHints', request, this.supersedeKey('getInlayHints', request, options))
  }

  public getSemanticTokens(
    request: WorkbenchLanguageServiceRequest,
    options: WorkbenchLanguageServiceSupersedeScope = {}
  ) {
    return this.call(
      'getSemanticTokens',
      request,
      this.supersedeKey('getSemanticTokens', request, options)
    )
  }

  public getCodeActions(request: WorkbenchLanguageServiceCodeActionsRequest) {
    return this.call('getCodeActions', request)
  }

  public resolveCodeAction(request: WorkbenchLanguageServiceCodeActionResolveRequest) {
    return this.call('resolveCodeAction', request)
  }

  public getOrganizeImports(request: WorkbenchLanguageServiceRequest) {
    return this.call('getOrganizeImports', request)
  }

  public getFileRenameEdits(request: WorkbenchLanguageServiceFileRenameEditsRequest) {
    return this.call('getFileRenameEdits', request)
  }

  public getCallHierarchy(request: WorkbenchLanguageServiceCallHierarchyRequest) {
    return this.call('getCallHierarchy', request)
  }

  public dispose(): Promise<void> {
    if (this.disposal) return this.disposal
    this.disposed = true
    this.stopFollowingLocale()
    if (this.restartTimer) clearTimeout(this.restartTimer)
    this.restartTimer = null
    const worker = this.worker
    const deadlineAt = Date.now() + GracefulWorkerShutdownTimeoutMs
    const closingProcesses = this.processes.close(deadlineAt)
    const closingTools = this.tools.close(deadlineAt)
    void Promise.allSettled([closingProcesses, closingTools])
    this.disposal = (async () => {
      try {
        if (worker) {
          const gracefulShutdown = new Promise<unknown>((accept, reject) => {
            this.post(this.createPending('shutdown', {}, accept, reject), worker)
          })
          // child 清理已并行开始并预留 force 窗口，不能 8 秒之后再补一轮完整 kill 等待。
          await withinLspDeadline(
            gracefulShutdown,
            deadlineAt - ExternalLspTerminationReserveMs
          ).catch(() => {})
        }
      } finally {
        if (worker) {
          this.clearProbe(worker)
          if (this.worker === worker) this.worker = null
          this.retire(worker, deadlineAt)
        }
        this.rejectPending(new AppError('CLOSED', workbenchMainText('language.serviceClosed')))
      }
      const results = await withinLspDeadline(
        Promise.allSettled([closingProcesses, closingTools, ...this.retiring.values()]),
        deadlineAt
      )
      const failures = results.flatMap((result) =>
        result.status === 'rejected' ? [result.reason] : []
      )
      if (failures.length)
        throw new AggregateError(failures, 'Language service resources did not close')
    })()
    return this.disposal
  }

  private supersedeKey(
    operation: WorkbenchLanguageServiceWorkerOperation,
    request: WorkbenchLanguageServiceRequest,
    { scope }: WorkbenchLanguageServiceSupersedeScope
  ): string | undefined {
    return scope === undefined
      ? undefined
      : JSON.stringify([scope, operation, request.projectRoot, request.path])
  }

  private call<TOperation extends WorkbenchLanguageServiceWorkerOperation>(
    operation: TOperation,
    request: WorkbenchLanguageServiceWorkerOperationMap[TOperation]['request'],
    supersedeKey?: string
  ): Promise<WorkbenchLanguageServiceWorkerOperationMap[TOperation]['result']> {
    if (operation !== 'getDiagnostics') {
      // 项目文件变了：还在飞的诊断是照旧文件算的，之后同样的请求不能再搭它的便车。
      if (operation === 'projectFilesChanged' || operation === 'invalidateProject')
        this.inFlightDiagnostics.splice(0)
      return this.send(operation, request, supersedeKey)
    }

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
    request: WorkbenchLanguageServiceWorkerOperationMap[TOperation]['request'],
    supersedeKey?: string
  ): Promise<WorkbenchLanguageServiceWorkerOperationMap[TOperation]['result']> {
    if (this.disposed)
      return Promise.reject(new AppError('CLOSED', workbenchMainText('language.serviceClosed')))

    return new Promise((resolvePromise, reject) => {
      const pending = this.createPending(
        operation,
        request,
        (result) =>
          resolvePromise(
            result as WorkbenchLanguageServiceWorkerOperationMap[TOperation]['result']
          ),
        reject
      )
      if (supersedeKey) {
        const previous = this.supersedable.get(supersedeKey)
        if (previous !== undefined) this.cancel(previous)
        pending.supersedeKey = supersedeKey
        this.supersedable.set(supersedeKey, pending.id)
      }

      // 重启退避期间先排着，到点建好 worker 一起发出去。
      if (!this.worker && Date.now() < this.restartNotBefore) {
        this.scheduleRestart()
        return
      }
      try {
        this.post(pending, this.ensureWorker())
      } catch (error) {
        this.settle(pending, AppError.from(error, 'IPC'))
      }
    })
  }

  private createPending(
    operation: WorkbenchLanguageServiceWorkerOperation,
    request: unknown,
    resolvePromise: (result: unknown) => void,
    reject: (error: AppError) => void
  ): PendingLanguageServiceRequest {
    const pending: PendingLanguageServiceRequest = {
      projectLease:
        operation === 'shutdown' || operation === 'invalidateProject'
          ? undefined
          : this.processes.captureProject(
              (request as WorkbenchLanguageServiceProjectRequest).projectRoot
            ),
      id: this.nextRequestId++,
      operation,
      request,
      worker: null,
      resolve: resolvePromise,
      reject,
      timeout: null,
      deadlineAt: null,
    }
    this.pending.set(pending.id, pending)
    return pending
  }

  private post(
    pending: PendingLanguageServiceRequest,
    worker: LanguageServiceWorkerInstance
  ): void {
    pending.worker = worker
    const initializingProject =
      !!pending.projectLease && !worker.readyProjects.has(pending.projectLease.projectRoot)
    const timeoutMs = Math.max(1, this.requestTimeoutMs(pending.operation, initializingProject))
    pending.deadlineAt = Date.now() + timeoutMs
    pending.timeout = setTimeout(() => this.handleRequestTimeout(pending), timeoutMs)
    try {
      if (pending.projectLease) worker.processes.bindProject(pending.projectLease)
      worker.port.postMessage({
        id: pending.id,
        operation: pending.operation,
        request: pending.request,
        projectLease: pending.projectLease,
      } as WorkbenchLanguageServiceWorkerMessage)
    } catch (error) {
      this.settle(pending, AppError.from(error, 'IPC'))
    }
  }

  /** 把请求从挂起表里拿掉并以错误结束；已经结束过的什么也不做。 */
  private settle(pending: PendingLanguageServiceRequest, error: AppError): void {
    if (this.pending.get(pending.id) !== pending) return
    this.pending.delete(pending.id)
    if (pending.timeout) clearTimeout(pending.timeout)
    if (pending.supersedeKey && this.supersedable.get(pending.supersedeKey) === pending.id)
      this.supersedable.delete(pending.supersedeKey)
    if (pending.tools) {
      void pending.tools.close(pending.deadlineAt ?? Date.now(), error).then(
        () => pending.reject(error),
        (closeError: unknown) =>
          pending.reject(
            AppError.from(
              new AggregateError([error, closeError], 'Language request and tool close failed')
            )
          )
      )
    } else pending.reject(error)
  }

  /** 取消一个请求：调用方立刻得到取消错误，worker 丢掉还在排队的它、放弃正在算的它。 */
  private cancel(
    id: number,
    error = new AppError('CANCELLED', workbenchMainText('language.requestSuperseded'))
  ): void {
    const pending = this.pending.get(id)
    if (!pending) return
    this.settle(pending, error)
    const worker = pending.worker
    if (!worker || worker !== this.worker) return
    markWorkbenchLanguageServiceRequestCancelled(worker.cancellation, id)
    try {
      worker.port.postMessage({ control: 'cancel', id })
    } catch {
      // worker 已经退出：退出处理会收拾剩下的请求。
    }
  }

  private handleRequestTimeout(pending: PendingLanguageServiceRequest): void {
    const worker = pending.worker
    this.cancel(
      pending.id,
      new AppError(
        'TIMEOUT',
        workbenchMainText('language.serviceRequestTimedOut', { operation: pending.operation })
      )
    )
    // 请求慢不等于 worker 死了：先探活，答不上来才重启。
    if (worker && worker === this.worker) this.probe(worker)
  }

  private probe(worker: LanguageServiceWorkerInstance): void {
    if (worker.probe) return
    // 首次建图、类型检查会同步占用 worker。排在它后面的生命周期请求可能先超时，
    // 此时没收到 pong 不等于线程死了；等已发出的分析用完自己的预算再判定。
    // 只在本次探活创建时计算，不让后来排队的请求无限推迟故障恢复。
    const now = Date.now()
    let analysisDeadline = now
    for (const pending of this.pending.values()) {
      if (pending.worker === worker)
        analysisDeadline = Math.max(analysisDeadline, pending.deadlineAt ?? now)
    }
    const hangTimeoutMs = Math.max(this.health.hangTimeoutMs, analysisDeadline - now)
    const id = this.nextRequestId++
    worker.probe = {
      id,
      timer: setTimeout(
        () => {
          if (this.worker !== worker || worker.probe?.id !== id) return
          worker.probe = null
          log.warn('language_worker_unresponsive', { hangTimeoutMs })
          this.replaceWorker(
            worker,
            new AppError('TIMEOUT', workbenchMainText('language.serviceRestartedUnresponsive'))
          )
        },
        Math.max(1, hangTimeoutMs)
      ),
    }
    try {
      worker.port.postMessage({ control: 'ping', id })
    } catch {
      // 发不出去说明 worker 已经没了：退出处理会接手。
    }
  }

  private clearProbe(worker: LanguageServiceWorkerInstance): void {
    if (worker.probe) clearTimeout(worker.probe.timer)
    worker.probe = null
  }

  private ensureWorker(): LanguageServiceWorkerInstance {
    if (this.disposed) throw new AppError('CLOSED', workbenchMainText('language.serviceClosed'))
    if (this.worker) return this.worker

    const buffer = createWorkbenchLanguageServiceCancellationBuffer()
    const channel = new MessageChannel()
    channel.port2.unref()
    const processes = this.processes.createWorkerScope(channel.port1)
    let port: WorkbenchLanguageServiceWorkerPort
    try {
      port = this.createWorker({
        resourcesPath: process.resourcesPath,
        cancellation: buffer,
        locale: getWorkbenchMainLocale(),
        processPort: channel.port2,
      })
    } catch (error) {
      channel.port2.close()
      this.followRetirement(
        processes,
        processes.close(Date.now() + ExternalLspTerminationReserveMs)
      )
      throw error
    }
    const worker: LanguageServiceWorkerInstance = {
      readyProjects: new Set(),
      processes,
      processPort: channel.port2,
      port,
      cancellation: new Int32Array(buffer),
      startedAt: Date.now(),
      probe: null,
    }
    this.worker = worker
    port.on('message', (message) => this.handleWorkerMessage(worker, message))
    port.on('error', (error) => this.handleWorkerFailure(worker, error))
    port.on('exit', (exitCode) => {
      this.retire(worker, Date.now() + ExternalLspTerminationReserveMs)
      if (this.worker !== worker) return
      this.handleWorkerFailure(
        worker,
        new AppError('IPC', workbenchMainText('language.serviceWorkerExited', { code: exitCode }))
      )
    })
    return worker
  }

  private handleWorkerMessage(worker: LanguageServiceWorkerInstance, message: unknown): void {
    if (
      typeof message === 'object' &&
      message !== null &&
      'control' in message &&
      message.control === 'project-tools'
    ) {
      void this.handleProjectTools(worker, message as ProjectToolEndpointRequest)
      return
    }
    if (isWorkbenchLanguageMemoryNotification(message)) {
      const { notification: _kind, ...fields } = message
      if (message.action === 'none') log.info('language_worker_memory', fields)
      else log.warn('language_worker_memory_trimmed', fields)
      return
    }
    if (isWorkerPong(message)) {
      if (worker.probe?.id === message.id) this.clearProbe(worker)
      return
    }
    if (!isWorkerResponse(message)) return

    const pending = this.pending.get(message.id)
    if (!pending || pending.worker !== worker) return

    if (
      !message.error &&
      pending.projectLease &&
      [
        'getHover',
        'getCompletions',
        'getDefinition',
        'getDiagnostics',
        'getInlayHints',
        'getSemanticTokens',
      ].includes(pending.operation)
    )
      worker.readyProjects.add(pending.projectLease.projectRoot)

    this.pending.delete(message.id)
    if (pending.timeout) clearTimeout(pending.timeout)
    if (pending.supersedeKey && this.supersedable.get(pending.supersedeKey) === pending.id)
      this.supersedable.delete(pending.supersedeKey)
    const deliver = (): void => {
      if (message.error) pending.reject(AppError.fromJSON(message.error))
      else pending.resolve(message.result)
    }
    if (pending.tools) {
      void pending.tools.close().then(deliver, (error: unknown) => {
        const failure = message.error
          ? new AggregateError(
              [AppError.fromJSON(message.error), error],
              'Language request and tool close failed'
            )
          : error
        pending.reject(AppError.from(failure))
      })
    } else deliver()
  }

  private async handleProjectTools(
    worker: LanguageServiceWorkerInstance,
    message: ProjectToolEndpointRequest
  ): Promise<void> {
    const response: ProjectToolEndpointResponse = {
      control: 'project-tools-result',
      id: message.id,
    }
    try {
      if (message.action === 'close') {
        const pending =
          message.requestId === undefined ? undefined : this.pending.get(message.requestId)
        const deadlineAt =
          pending &&
          pending.worker === worker &&
          pending.operation === 'shutdown' &&
          pending.deadlineAt !== null
            ? pending.deadlineAt
            : Date.now() + getWorkbenchLanguageServiceRequestTimeoutMs('shutdown')
        await this.tools.closeOwner(worker, deadlineAt)
      } else if (message.action === 'finish') {
        await this.tools.finishRequest(worker, message.requestId)
      } else {
        const pending = this.pending.get(message.requestId)
        if (
          this.disposed ||
          this.worker !== worker ||
          !pending ||
          pending.worker !== worker ||
          !pending.projectLease ||
          pending.deadlineAt === null
        )
          throw new AppError('CANCELLED', 'Project tool language request is no longer active')
        if (
          (message.operation === 'lint' && pending.operation !== 'getDiagnostics') ||
          (message.operation === 'format' && pending.operation !== 'getFormat')
        )
          throw new AppError('INVARIANT', 'Project tool does not belong to the language operation')
        this.processes.assertProject(pending.projectLease)
        pending.tools ??= this.tools.createRequest(
          worker,
          pending.id,
          pending.projectLease.projectRoot,
          pending.deadlineAt
        )
        response.result =
          message.operation === 'lint'
            ? await pending.tools.operations.lint(message.input)
            : await pending.tools.operations.format(message.input)
      }
    } catch (error) {
      response.error = AppError.from(error, 'IPC').toJSON()
    }
    try {
      worker.port.postMessage(response)
    } catch (error) {
      this.handleWorkerFailure(worker, error)
    }
  }

  private handleWorkerFailure(worker: LanguageServiceWorkerInstance, error: unknown): void {
    if (this.worker !== worker) return

    if (isWorkerOutOfMemory(error)) {
      // 项目太大把语言服务的堆用满了：只丢语言服务，编辑器与 Agent 都不受影响，下一次请求重建。
      log.warn('language_worker_out_of_memory', { message: String((error as Error).message) })
      this.replaceWorker(
        worker,
        new AppError('PLATFORM', workbenchMainText('language.serviceOutOfMemory'))
      )
      return
    }
    this.replaceWorker(worker, AppError.from(error, 'IPC'))
  }

  /** 丢掉崩溃或卡死的 worker：发给它的请求都以错误结束，下一个请求按退避重建。 */
  private replaceWorker(worker: LanguageServiceWorkerInstance, error: AppError): void {
    if (this.worker !== worker) return
    this.worker = null
    this.clearProbe(worker)
    for (const pending of [...this.pending.values()])
      if (pending.worker === worker) this.settle(pending, error)
    this.inFlightDiagnostics.splice(0)
    this.retire(worker, Date.now() + ExternalLspTerminationReserveMs)

    // 平稳跑过一阵才出事的不算接连失败；接连失败的重建间隔翻倍，免得反复拉起一个起不来的 worker。
    const now = Date.now()
    if (now - worker.startedAt >= this.health.restartBackoffResetMs) this.consecutiveFailures = 0
    const delay =
      this.consecutiveFailures === 0
        ? 0
        : Math.min(
            this.health.restartBackoffMaxMs,
            this.health.restartBackoffMs * 2 ** (this.consecutiveFailures - 1)
          )
    this.consecutiveFailures += 1
    this.restartNotBefore = now + delay
    // 退避期间排着的请求（上一次失败后来的）到点再发。
    if ([...this.pending.values()].some((pending) => !pending.worker)) this.scheduleRestart()
  }

  private scheduleRestart(): void {
    if (this.restartTimer || this.disposed) return
    this.restartTimer = setTimeout(
      () => {
        this.restartTimer = null
        if (this.disposed) return
        if (Date.now() < this.restartNotBefore) {
          this.scheduleRestart()
          return
        }
        const waiting = [...this.pending.values()].filter((pending) => !pending.worker)
        if (waiting.length === 0) return
        let worker: LanguageServiceWorkerInstance
        try {
          worker = this.ensureWorker()
        } catch (error) {
          const failure = AppError.from(error, 'IPC')
          for (const pending of waiting) this.settle(pending, failure)
          return
        }
        for (const pending of waiting) this.post(pending, worker)
      },
      Math.max(0, this.restartNotBefore - Date.now())
    )
  }

  private rejectPending(error: AppError): void {
    for (const pending of [...this.pending.values()]) this.settle(pending, error)
    this.pending.clear()
    this.supersedable.clear()
    this.inFlightDiagnostics.splice(0)
  }

  private retire(worker: LanguageServiceWorkerInstance, deadlineAt: number): void {
    if (this.retiring.has(worker)) return
    worker.processPort.close()
    this.followRetirement(
      worker,
      Promise.resolve().then(() =>
        withinLspDeadline(
          Promise.allSettled([
            worker.processes.close(deadlineAt),
            this.tools.closeOwner(worker, deadlineAt),
            worker.port.terminate(),
          ]).then((results) => {
            const failures = results.flatMap((result) =>
              result.status === 'rejected' ? [result.reason] : []
            )
            if (failures.length)
              throw new AggregateError(failures, 'Language worker resources did not close')
          }),
          deadlineAt
        )
      )
    )
  }

  private followRetirement(
    owner: LanguageServiceWorkerInstance | ExternalLspWorkerProcessScope,
    retirement: Promise<unknown>
  ): void {
    this.retiring.set(owner, retirement)
    void retirement.then(
      () => this.retiring.delete(owner),
      (error: unknown) => {
        log.warn('language_worker_resources_failed_to_close', { error })
      }
    )
  }
}
