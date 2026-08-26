/**
 * 独立 Workbench 应用「语言智能」的 main ↔ renderer IPC 契约（应用私有）。
 *
 * 这是 `WorkbenchHost.kernel.project` 端口 13 个语言服务动词在独立应用侧的实装传输面：
 * 请求/结果形状直接复用 `@shared/contracts` 的 Workbench Kernel contracts（单源，不另造
 * 镜像），本文件只补通道名与桥面。错误信封复用 `WorkbenchFsCallResult`（main 侧异常降为
 * 数据，renderer 侧再升回 Result）。主进程把这些请求转发给串行执行的语言服务 worker
 * 线程（tsserver 建图/诊断/符号可能耗时数秒，必须离开主线程）。
 *
 * 与文件系统面（workbenchFs.ts）拆成两个桥：文件系统面是同步落盘/目录读写，语言智能面
 * 是 worker 转发的代码分析——两者生命周期、错误面与调用节奏都不同。
 */
import type { ModelSelection } from '@velaros-ai/model/contracts'

import type {
  WorkbenchInlineCompletionRequest,
  WorkbenchInlineCompletionResult,
  WorkbenchLanguageServiceCodeActionsRequest,
  WorkbenchLanguageServiceCodeActionsResult,
  WorkbenchLanguageServiceCompletionResult,
  WorkbenchLanguageServiceDefinitionResult,
  WorkbenchLanguageServiceDiagnosticsResult,
  WorkbenchLanguageServiceDocumentHighlightsResult,
  WorkbenchLanguageServiceDocumentSymbolsResult,
  WorkbenchLanguageServiceFormatResult,
  WorkbenchLanguageServiceHoverQueryResult,
  WorkbenchLanguageServiceInlayHintsRequest,
  WorkbenchLanguageServiceInlayHintsResult,
  WorkbenchLanguageServicePositionRequest,
  WorkbenchLanguageServiceReferencesResult,
  WorkbenchLanguageServiceRenameRequest,
  WorkbenchLanguageServiceRenameResult,
  WorkbenchLanguageServiceRequest,
  WorkbenchLanguageServiceSemanticTokensResult,
  WorkbenchLanguageServiceSignatureHelpQueryResult,
} from '@shared/contracts'

import type { WorkbenchFsCallResult } from './workbenchFs'

export const WorkbenchLanguageChannels = {
  definition: 'workbench-app:ls:definition',
  completions: 'workbench-app:ls:completions',
  diagnostics: 'workbench-app:ls:diagnostics',
  rename: 'workbench-app:ls:rename',
  hover: 'workbench-app:ls:hover',
  references: 'workbench-app:ls:references',
  signatureHelp: 'workbench-app:ls:signature-help',
  format: 'workbench-app:ls:format',
  documentSymbols: 'workbench-app:ls:document-symbols',
  documentHighlights: 'workbench-app:ls:document-highlights',
  inlayHints: 'workbench-app:ls:inlay-hints',
  semanticTokens: 'workbench-app:ls:semantic-tokens',
  codeActions: 'workbench-app:ls:code-actions',
  inlineCompletion: 'workbench-app:ls:inline-completion',
} as const

export interface WorkbenchInlineCompletionBridgeRequest extends WorkbenchInlineCompletionRequest {
  modelSelection: ModelSelection
}

/** preload 通过 contextBridge 暴露给 renderer 的语言智能与 AI 内联补全桥面。 */
export interface WorkbenchLanguageBridge {
  getDefinition: (
    request: WorkbenchLanguageServicePositionRequest
  ) => Promise<WorkbenchFsCallResult<WorkbenchLanguageServiceDefinitionResult>>
  getCompletions: (
    request: WorkbenchLanguageServicePositionRequest
  ) => Promise<WorkbenchFsCallResult<WorkbenchLanguageServiceCompletionResult>>
  getDiagnostics: (
    request: WorkbenchLanguageServiceRequest
  ) => Promise<WorkbenchFsCallResult<WorkbenchLanguageServiceDiagnosticsResult>>
  getRename: (
    request: WorkbenchLanguageServiceRenameRequest
  ) => Promise<WorkbenchFsCallResult<WorkbenchLanguageServiceRenameResult>>
  getHover: (
    request: WorkbenchLanguageServicePositionRequest
  ) => Promise<WorkbenchFsCallResult<WorkbenchLanguageServiceHoverQueryResult>>
  getReferences: (
    request: WorkbenchLanguageServicePositionRequest
  ) => Promise<WorkbenchFsCallResult<WorkbenchLanguageServiceReferencesResult>>
  getSignatureHelp: (
    request: WorkbenchLanguageServicePositionRequest
  ) => Promise<WorkbenchFsCallResult<WorkbenchLanguageServiceSignatureHelpQueryResult>>
  getFormat: (
    request: WorkbenchLanguageServiceRequest
  ) => Promise<WorkbenchFsCallResult<WorkbenchLanguageServiceFormatResult>>
  getDocumentSymbols: (
    request: WorkbenchLanguageServiceRequest
  ) => Promise<WorkbenchFsCallResult<WorkbenchLanguageServiceDocumentSymbolsResult>>
  getDocumentHighlights: (
    request: WorkbenchLanguageServicePositionRequest
  ) => Promise<WorkbenchFsCallResult<WorkbenchLanguageServiceDocumentHighlightsResult>>
  getInlayHints: (
    request: WorkbenchLanguageServiceInlayHintsRequest
  ) => Promise<WorkbenchFsCallResult<WorkbenchLanguageServiceInlayHintsResult>>
  getSemanticTokens: (
    request: WorkbenchLanguageServiceRequest
  ) => Promise<WorkbenchFsCallResult<WorkbenchLanguageServiceSemanticTokensResult>>
  getCodeActions: (
    request: WorkbenchLanguageServiceCodeActionsRequest
  ) => Promise<WorkbenchFsCallResult<WorkbenchLanguageServiceCodeActionsResult>>
  getInlineCompletion: (
    request: WorkbenchInlineCompletionBridgeRequest
  ) => Promise<WorkbenchFsCallResult<WorkbenchInlineCompletionResult>>
}
