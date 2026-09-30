import type { SerializedError } from '@velaros-ai/core/error'

import type { AppLocale } from '@shared/contracts'
import type {
  WorkbenchLanguageServiceCodeActionResolveRequest,
  WorkbenchLanguageServiceCodeActionResolveResult,
  WorkbenchLanguageServiceCodeActionsRequest,
  WorkbenchLanguageServiceCodeActionsResult,
  WorkbenchLanguageServiceCompletionResolveRequest,
  WorkbenchLanguageServiceCompletionResolveResult,
  WorkbenchLanguageServiceCompletionResult,
  WorkbenchLanguageServiceDefinitionResult,
  WorkbenchLanguageServiceDiagnosticsResult,
  WorkbenchLanguageServiceDocumentHighlightsResult,
  WorkbenchLanguageServiceDocumentSymbolsResult,
  WorkbenchLanguageServiceExtensionRequest,
  WorkbenchLanguageServiceExtensionResult,
  WorkbenchLanguageServiceFormatResult,
  WorkbenchLanguageServiceHoverQueryResult,
  WorkbenchLanguageServiceInlayHintsRequest,
  WorkbenchLanguageServiceInlayHintsResult,
  WorkbenchLanguageServicePositionRequest,
  WorkbenchLanguageServiceProjectDiagnosticsRequest,
  WorkbenchLanguageServiceProjectDiagnosticsResult,
  WorkbenchLanguageServiceReferencesResult,
  WorkbenchLanguageServiceRenameRequest,
  WorkbenchLanguageServiceRenameResult,
  WorkbenchLanguageServiceRequest,
  WorkbenchLanguageServiceResolveResult,
  WorkbenchLanguageServiceSemanticTokensResult,
  WorkbenchLanguageServiceSignatureHelpQueryResult,
} from '@shared/contracts'

export interface WorkbenchLanguageServiceProjectRequest {
  projectRoot: string
}

export interface WorkbenchLanguageServiceProjectFileRequest extends WorkbenchLanguageServiceProjectRequest {
  path: string
  content: Nullable<string>
}

export interface WorkbenchLanguageServiceProjectFilesChangedRequest
  extends WorkbenchLanguageServiceProjectRequest {
  paths: string[]
}

export interface WorkbenchLanguageServiceWorkerOperationMap {
  shutdown: {
    request: Record<string, never>
    result: void
  }
  synchronizeProjectFile: {
    request: WorkbenchLanguageServiceProjectFileRequest
    result: void
  }
  invalidateProject: {
    request: WorkbenchLanguageServiceProjectRequest
    result: void
  }
  projectFilesChanged: {
    request: WorkbenchLanguageServiceProjectFilesChangedRequest
    result: void
  }
  requestExtension: {
    request: WorkbenchLanguageServiceExtensionRequest
    result: WorkbenchLanguageServiceExtensionResult
  }
  resolveLanguageService: {
    request: WorkbenchLanguageServiceRequest
    result: WorkbenchLanguageServiceResolveResult
  }
  getDefinition: {
    request: WorkbenchLanguageServicePositionRequest
    result: WorkbenchLanguageServiceDefinitionResult
  }
  getCompletions: {
    request: WorkbenchLanguageServicePositionRequest
    result: WorkbenchLanguageServiceCompletionResult
  }
  resolveCompletion: {
    request: WorkbenchLanguageServiceCompletionResolveRequest
    result: WorkbenchLanguageServiceCompletionResolveResult
  }
  getDiagnostics: {
    request: WorkbenchLanguageServiceRequest
    result: WorkbenchLanguageServiceDiagnosticsResult
  }
  getProjectDiagnostics: {
    request: WorkbenchLanguageServiceProjectDiagnosticsRequest
    result: WorkbenchLanguageServiceProjectDiagnosticsResult
  }
  getRename: {
    request: WorkbenchLanguageServiceRenameRequest
    result: WorkbenchLanguageServiceRenameResult
  }
  getHover: {
    request: WorkbenchLanguageServicePositionRequest
    result: WorkbenchLanguageServiceHoverQueryResult
  }
  getReferences: {
    request: WorkbenchLanguageServicePositionRequest
    result: WorkbenchLanguageServiceReferencesResult
  }
  getSignatureHelp: {
    request: WorkbenchLanguageServicePositionRequest
    result: WorkbenchLanguageServiceSignatureHelpQueryResult
  }
  getFormat: {
    request: WorkbenchLanguageServiceRequest
    result: WorkbenchLanguageServiceFormatResult
  }
  getDocumentSymbols: {
    request: WorkbenchLanguageServiceRequest
    result: WorkbenchLanguageServiceDocumentSymbolsResult
  }
  getDocumentHighlights: {
    request: WorkbenchLanguageServicePositionRequest
    result: WorkbenchLanguageServiceDocumentHighlightsResult
  }
  getInlayHints: {
    request: WorkbenchLanguageServiceInlayHintsRequest
    result: WorkbenchLanguageServiceInlayHintsResult
  }
  getSemanticTokens: {
    request: WorkbenchLanguageServiceRequest
    result: WorkbenchLanguageServiceSemanticTokensResult
  }
  getCodeActions: {
    request: WorkbenchLanguageServiceCodeActionsRequest
    result: WorkbenchLanguageServiceCodeActionsResult
  }
  resolveCodeAction: {
    request: WorkbenchLanguageServiceCodeActionResolveRequest
    result: WorkbenchLanguageServiceCodeActionResolveResult
  }
}

export type WorkbenchLanguageServiceWorkerOperation =
  keyof WorkbenchLanguageServiceWorkerOperationMap

export type WorkbenchLanguageServiceWorkerPriority =
  | 'lifecycle'
  | 'interactive'
  | 'background'

const BackgroundLanguageServiceOperations = new Set<WorkbenchLanguageServiceWorkerOperation>([
  'getDiagnostics',
  'getProjectDiagnostics',
  'getDocumentSymbols',
  'getDocumentHighlights',
  'getInlayHints',
  'getSemanticTokens',
])

/**
 * 跟着光标、鼠标、输入走的请求：同一窗口同一文件的新请求一到，旧的就没用了——还在排队的直接丢掉，
 * 正在算的尽快放弃（TypeScript 在检查点抛出取消，外部语言服务器收到 `$/cancelRequest`）。
 */
const SupersededLanguageServiceOperations = new Set<WorkbenchLanguageServiceWorkerOperation>([
  'getCompletions',
  'getHover',
  'getSignatureHelp',
  'getDocumentHighlights',
  'getInlayHints',
  'getSemanticTokens',
])

export function getWorkbenchLanguageServiceWorkerPriority(
  operation: WorkbenchLanguageServiceWorkerOperation
): WorkbenchLanguageServiceWorkerPriority {
  if (operation === 'shutdown' || operation === 'projectFilesChanged') return 'lifecycle'
  return BackgroundLanguageServiceOperations.has(operation) ? 'background' : 'interactive'
}

export function isWorkbenchLanguageServiceOperationSuperseded(
  operation: WorkbenchLanguageServiceWorkerOperation
): boolean {
  return SupersededLanguageServiceOperations.has(operation)
}

export type WorkbenchLanguageServiceWorkerRequest = {
  [TOperation in WorkbenchLanguageServiceWorkerOperation]: {
    id: number
    operation: TOperation
    request: WorkbenchLanguageServiceWorkerOperationMap[TOperation]['request']
  }
}[WorkbenchLanguageServiceWorkerOperation]

/**
 * 不进请求队列、worker 收到就处理的控制消息：`cancel` 取消一个请求（排队的丢掉，在算的放弃），`ping` 探活
 * （worker 的事件循环还转就立刻回 `pong`）。
 */
export interface WorkbenchLanguageServiceWorkerControl {
  control: 'cancel' | 'ping'
  id: number
}

/**
 * 界面语言：worker 与主进程不共用模块状态，worker 里给用户看的提示（语言服务器不可用、超时……）要靠这条跟着换。
 * 创建 worker 时经 workerData 带上当时的语言，之后每次切换发一条。
 */
export interface WorkbenchLanguageServiceWorkerLocale {
  locale: AppLocale
}

export type WorkbenchLanguageServiceWorkerMessage =
  | WorkbenchLanguageServiceWorkerRequest
  | WorkbenchLanguageServiceWorkerControl

export function isWorkbenchLanguageServiceWorkerLocale(
  message: unknown
): message is WorkbenchLanguageServiceWorkerLocale {
  return typeof message === 'object' && message !== null && 'locale' in message
}

export interface WorkbenchLanguageServiceWorkerPong {
  control: 'pong'
  id: number
}

export interface WorkbenchLanguageServiceWorkerResponse {
  id: number
  result?: unknown
  error?: SerializedError
}

export function isWorkbenchLanguageServiceWorkerControl(
  message: unknown
): message is WorkbenchLanguageServiceWorkerControl {
  if (typeof message !== 'object' || message === null) return false
  const { control, id } = message as { control?: unknown; id?: unknown }
  return (control === 'cancel' || control === 'ping') && typeof id === 'number'
}

/**
 * 取消的请求号写进与 worker 共享的环形缓冲：worker 正陷在同步的 TypeScript 计算里、收不到消息时，
 * TypeScript 的取消检查点也能直接读到。第 0 格是写指针，后面是最近取消的请求号。
 */
export const WorkbenchLanguageServiceCancellationSlots = 16

export function createWorkbenchLanguageServiceCancellationBuffer(): SharedArrayBuffer {
  return new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * (WorkbenchLanguageServiceCancellationSlots + 1))
}

export function markWorkbenchLanguageServiceRequestCancelled(buffer: Int32Array, id: number): void {
  const slot = (Atomics.add(buffer, 0, 1) >>> 0) % WorkbenchLanguageServiceCancellationSlots
  Atomics.store(buffer, slot + 1, id)
}

export function isWorkbenchLanguageServiceRequestCancelled(buffer: Int32Array, id: number): boolean {
  for (let slot = 1; slot <= WorkbenchLanguageServiceCancellationSlots; slot += 1)
    if (Atomics.load(buffer, slot) === id) return true
  return false
}
