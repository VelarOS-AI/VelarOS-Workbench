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

const port = (() => {
  if (!parentPort) throw new AppError('INVARIANT', 'Workbench 语言服务 worker 缺少消息端口。')
  return parentPort
})()

registerWorkbenchLanguageService(VelarWorkbenchLanguageService)
const languageServices = new WorkbenchLanguageServices(new PathResolver())

async function dispatch(request: WorkbenchLanguageServiceWorkerRequest): Promise<unknown> {
  switch (request.operation) {
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

// 单 worker 串行执行请求：TypeScript LanguageService 的 overlay/cache 是可变状态，
// 串行还能避免诊断、符号和补全同时把 CPU 打满。
let requestQueue = Promise.resolve()
port.on('message', (request: WorkbenchLanguageServiceWorkerRequest) => {
  requestQueue = requestQueue.then(
    () => handleRequest(request),
    () => handleRequest(request)
  )
})

port.on('close', () => {
  void languageServices.dispose()
})
