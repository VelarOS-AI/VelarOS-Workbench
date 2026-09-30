import * as v8 from 'node:v8'
import { parentPort, workerData } from 'node:worker_threads'

import { AppError } from '@velaros-ai/core/error'

import { VelarWorkbenchLanguageService } from '@shared/contributions/velar/service'
import { registerWorkbenchLanguageService } from '@shared/language/workbenchLanguageServices'

import { isWorkbenchAppLocale, setWorkbenchMainLocale } from '../../i18n/workbenchMainLocale'
import { PathResolver } from '../PathResolver'

import {
  decideWorkbenchLanguageMemoryAction,
  type WorkbenchLanguageMemoryAction,
  type WorkbenchLanguageMemoryNotification,
} from './LanguageServiceMemoryGuard'
import { WorkbenchLanguageServices } from './LanguageServices'
import {
  isWorkbenchLanguageServiceWorkerControl,
  isWorkbenchLanguageServiceWorkerLocale,
  type WorkbenchLanguageServiceWorkerLocale,
  type WorkbenchLanguageServiceWorkerMessage,
  type WorkbenchLanguageServiceWorkerRequest,
} from './LanguageServiceWorkerProtocol'
import { WorkbenchLanguageServiceWorkerScheduler } from './LanguageServiceWorkerScheduler'
import { configureTypeScriptCancellation, configureTypeScriptProjectPool } from './TypeScriptProjectHost'

const port = (() => {
  if (!parentPort) throw new AppError('INVARIANT', 'Workbench 语言服务 worker 缺少消息端口。')
  return parentPort
})()

registerWorkbenchLanguageService(VelarWorkbenchLanguageService)
configureTypeScriptProjectPool(v8.getHeapStatistics().heap_size_limit)
const languageServices = new WorkbenchLanguageServices(new PathResolver())

async function dispatch(
  request: WorkbenchLanguageServiceWorkerRequest,
  signal: AbortSignal
): Promise<unknown> {
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
      return languageServices.getCompletions(request.request, signal)
    case 'resolveCompletion':
      return languageServices.resolveCompletion(request.request)
    case 'getDiagnostics':
      return languageServices.getDiagnostics(request.request)
    case 'getProjectDiagnostics':
      return languageServices.getProjectDiagnostics(request.request)
    case 'getRename':
      return languageServices.getRename(request.request)
    case 'getHover':
      return languageServices.getHover(request.request, signal)
    case 'getReferences':
      return languageServices.getReferences(request.request)
    case 'getSignatureHelp':
      return languageServices.getSignatureHelp(request.request, signal)
    case 'getFormat':
      return languageServices.getFormat(request.request)
    case 'getDocumentSymbols':
      return languageServices.getDocumentSymbols(request.request)
    case 'getDocumentHighlights':
      return languageServices.getDocumentHighlights(request.request, signal)
    case 'getInlayHints':
      return languageServices.getInlayHints(request.request, signal)
    case 'getSemanticTokens':
      return languageServices.getSemanticTokens(request.request, signal)
    case 'getCodeActions':
      return languageServices.getCodeActions(request.request)
    case 'resolveCodeAction':
      return languageServices.resolveCodeAction(request.request)
    case 'getOrganizeImports':
      return languageServices.getOrganizeImports(request.request)
    case 'getFileRenameEdits':
      return languageServices.getFileRenameEdits(request.request)
  }
}

const cancellation = workerData?.cancellation instanceof SharedArrayBuffer
  ? new Int32Array(workerData.cancellation)
  : undefined
const scheduler = new WorkbenchLanguageServiceWorkerScheduler({
  dispatch,
  post: (message) => port.postMessage(message),
  cancellation,
})
// 被新请求顶掉的补全、悬浮、语义着色：TypeScript 在自己的检查点抛出取消，不再算完。
configureTypeScriptCancellation(() => scheduler.isRunningRequestCancelled())

if (isWorkbenchAppLocale(workerData?.locale)) setWorkbenchMainLocale(workerData.locale)

port.on('message', (message: WorkbenchLanguageServiceWorkerMessage | WorkbenchLanguageServiceWorkerLocale) => {
  if (isWorkbenchLanguageServiceWorkerLocale(message)) {
    if (isWorkbenchAppLocale(message.locale)) setWorkbenchMainLocale(message.locale)
    return
  }
  if (!isWorkbenchLanguageServiceWorkerControl(message)) {
    lastRequestAt = Date.now()
    idleTrimDone = 'none'
  }
  scheduler.receive(message)
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
  if (scheduler.busy) return
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
