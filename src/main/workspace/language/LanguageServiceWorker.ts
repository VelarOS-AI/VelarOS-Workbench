import { parentPort } from 'node:worker_threads'

import { AppError } from '@velaros-ai/core/error'

import { VelarWorkbenchLanguageService } from '@shared/contributions/velar/service'
import { registerWorkbenchLanguageService } from '@shared/language/workbenchLanguageServices'

import { PathResolver } from '../PathResolver'

import { WorkbenchLanguageServices } from './LanguageServices'
import type {
  WorkbenchLanguageServiceWorkerRequest,
  WorkbenchLanguageServiceWorkerResponse,
} from './LanguageServiceWorkerProtocol'
import { getWorkbenchLanguageServiceWorkerPriority } from './LanguageServiceWorkerProtocol'

const port = (() => {
  if (!parentPort) throw new AppError('INVARIANT', 'Workbench 语言服务 worker 缺少消息端口。')
  return parentPort
})()

registerWorkbenchLanguageService(VelarWorkbenchLanguageService)
const languageServices = new WorkbenchLanguageServices(new PathResolver())

async function dispatch(request: WorkbenchLanguageServiceWorkerRequest): Promise<unknown> {
  switch (request.operation) {
    case 'shutdown':
      return languageServices.dispose()
    case 'synchronizeProjectFile':
      return languageServices.synchronizeProjectFile(request.request)
    case 'invalidateProject':
      return languageServices.invalidateProject(request.request)
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
  enqueueRequest(request)
})

port.on('close', () => {
  void languageServices.dispose()
})
