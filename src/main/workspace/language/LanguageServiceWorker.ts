import * as v8 from 'node:v8'
import { parentPort } from 'node:worker_threads'

import { AppError } from '@velaros-ai/core/error'

import { VelarWorkbenchLanguageService } from '@shared/contributions/velar/service'
import { registerWorkbenchLanguageService } from '@shared/language/workbenchLanguageServices'

import { PathResolver } from '../PathResolver'

import {
  decideWorkbenchLanguageMemoryAction,
  type WorkbenchLanguageMemoryAction,
  type WorkbenchLanguageMemoryNotification,
} from './LanguageServiceMemoryGuard'
import { WorkbenchLanguageServices } from './LanguageServices'
import type {
  WorkbenchLanguageServiceWorkerRequest,
  WorkbenchLanguageServiceWorkerResponse,
} from './LanguageServiceWorkerProtocol'
import { getWorkbenchLanguageServiceWorkerPriority } from './LanguageServiceWorkerProtocol'
import { configureTypeScriptProjectPool } from './TypeScriptProjectHost'

const port = (() => {
  if (!parentPort) throw new AppError('INVARIANT', 'Workbench 语言服务 worker 缺少消息端口。')
  return parentPort
})()

registerWorkbenchLanguageService(VelarWorkbenchLanguageService)
configureTypeScriptProjectPool(v8.getHeapStatistics().heap_size_limit)
const languageServices = new WorkbenchLanguageServices(new PathResolver())

async function dispatch(request: WorkbenchLanguageServiceWorkerRequest): Promise<unknown> {
  switch (request.operation) {
    case 'shutdown':
      return languageServices.dispose()
    case 'synchronizeProjectFile':
      return languageServices.synchronizeProjectFile(request.request)
    case 'invalidateProject':
      return languageServices.invalidateProject(request.request)
    case 'projectFilesChanged':
      return languageServices.projectFilesChanged(request.request)
    case 'requestExtension':
      return languageServices.requestExtension(request.request)
    case 'resolveLanguageService':
      return languageServices.resolveLanguageService(request.request)
    case 'getDefinition':
      return languageServices.getDefinition(request.request)
    case 'getCompletions':
      return languageServices.getCompletions(request.request)
    case 'getDiagnostics':
      return languageServices.getDiagnostics(request.request)
    case 'getRename':
      return languageServices.getRename(request.request)
    case 'getHover':
      return languageServices.getHover(request.request)
    case 'getReferences':
      return languageServices.getReferences(request.request)
    case 'getSignatureHelp':
      return languageServices.getSignatureHelp(request.request)
    case 'getFormat':
      return languageServices.getFormat(request.request)
    case 'getDocumentSymbols':
      return languageServices.getDocumentSymbols(request.request)
    case 'getDocumentHighlights':
      return languageServices.getDocumentHighlights(request.request)
    case 'getInlayHints':
      return languageServices.getInlayHints(request.request)
    case 'getSemanticTokens':
      return languageServices.getSemanticTokens(request.request)
    case 'getCodeActions':
      return languageServices.getCodeActions(request.request)
  }
}

async function handleRequest(request: WorkbenchLanguageServiceWorkerRequest): Promise<void> {
  let response: WorkbenchLanguageServiceWorkerResponse
  try {
    response = { id: request.id, result: await dispatch(request) }
  } catch (error) {
    response = { id: request.id, error: AppError.from(error).toJSON() }
  }
  port.postMessage(response)
}

// 单 worker 仍然串行执行：TypeScript LanguageService 的 overlay/cache 是可变状态。
// 但生命周期与交互请求必须越过诊断/语义着色等后台积压，否则恢复大量标签或缩放触发
// 后台刷新时，悬浮说明和补全会看起来一起“失效”。
const lifecycleRequests: WorkbenchLanguageServiceWorkerRequest[] = []
const interactiveRequests: WorkbenchLanguageServiceWorkerRequest[] = []
const backgroundRequests: WorkbenchLanguageServiceWorkerRequest[] = []
let drainingRequests = false

function enqueueRequest(request: WorkbenchLanguageServiceWorkerRequest): void {
  const priority = getWorkbenchLanguageServiceWorkerPriority(request.operation)
  if (priority === 'lifecycle') lifecycleRequests.push(request)
  else if (priority === 'interactive') interactiveRequests.push(request)
  else backgroundRequests.push(request)
  void drainRequests()
}

async function drainRequests(): Promise<void> {
  if (drainingRequests) return
  drainingRequests = true
  try {
    while (
      lifecycleRequests.length > 0 ||
      interactiveRequests.length > 0 ||
      backgroundRequests.length > 0
    ) {
      const request = lifecycleRequests.shift()
        ?? interactiveRequests.shift()
        ?? backgroundRequests.shift()
      if (request) await handleRequest(request)
    }
  } finally {
    drainingRequests = false
    if (
      lifecycleRequests.length > 0 ||
      interactiveRequests.length > 0 ||
      backgroundRequests.length > 0
    ) void drainRequests()
  }
}

port.on('message', (request: WorkbenchLanguageServiceWorkerRequest) => {
  lastRequestAt = Date.now()
  idleTrimDone = 'none'
  enqueueRequest(request)
})

// ── 内存看守：逼近堆上限先自己减负，长时间空闲把大块缓存放掉；每次动作与定期心跳报给主进程记日志。
const MemoryCheckIntervalMs = 15_000
const MemoryHeartbeatIntervalMs = 10 * 60 * 1_000
let lastRequestAt = Date.now()
let idleTrimDone: WorkbenchLanguageMemoryAction = 'none'
let lastHeartbeatAt = Date.now()

function reportMemory(
  action: WorkbenchLanguageMemoryAction,
  reason: WorkbenchLanguageMemoryNotification['reason']
): void {
  const heap = v8.getHeapStatistics()
  const summary = languageServices.describeMemory()
  const notification: WorkbenchLanguageMemoryNotification = {
    notification: 'memory',
    heapUsedMb: Math.round(heap.used_heap_size / 1024 / 1024),
    heapLimitMb: Math.round(heap.heap_size_limit / 1024 / 1024),
    rssMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
    projects: summary.projects,
    files: summary.files,
    eslintInstances: summary.eslintInstances,
    action,
    reason,
  }
  port.postMessage(notification)
}

function guardMemory(): void {
  // 正在处理请求时不动手：服务正在用。
  if (drainingRequests) return
  const heap = v8.getHeapStatistics()
  const idleMs = Date.now() - lastRequestAt
  const action = decideWorkbenchLanguageMemoryAction({
    heapUsedBytes: heap.used_heap_size,
    heapLimitBytes: heap.heap_size_limit,
    idleMs,
    idleTrimDone,
  })
  if (action !== 'none') {
    const pressure = heap.used_heap_size / heap.heap_size_limit
    const reason = pressure >= 0.6 ? 'pressure' : 'idle'
    languageServices.trimMemory(action)
    if (reason === 'idle') idleTrimDone = action
    lastHeartbeatAt = Date.now()
    reportMemory(action, reason)
    return
  }
  if (Date.now() - lastHeartbeatAt >= MemoryHeartbeatIntervalMs) {
    lastHeartbeatAt = Date.now()
    reportMemory('none', 'heartbeat')
  }
}

const memoryGuard = setInterval(guardMemory, MemoryCheckIntervalMs)
memoryGuard.unref()

port.on('close', () => {
  clearInterval(memoryGuard)
  void languageServices.dispose()
})
