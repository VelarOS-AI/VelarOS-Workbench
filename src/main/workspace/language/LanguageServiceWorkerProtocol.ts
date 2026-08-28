import type { SerializedError } from '@velaros-ai/core/error'

import type {
  WorkbenchLanguageServiceCodeActionsRequest,
  WorkbenchLanguageServiceCodeActionsResult,
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
  getDiagnostics: {
    request: WorkbenchLanguageServiceRequest
    result: WorkbenchLanguageServiceDiagnosticsResult
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
}

export type WorkbenchLanguageServiceWorkerOperation =
  keyof WorkbenchLanguageServiceWorkerOperationMap

export type WorkbenchLanguageServiceWorkerPriority =
  | 'lifecycle'
  | 'interactive'
  | 'background'

const BackgroundLanguageServiceOperations = new Set<WorkbenchLanguageServiceWorkerOperation>([
  'getDiagnostics',
  'getDocumentSymbols',
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

export type WorkbenchLanguageServiceWorkerRequest = {
  [TOperation in WorkbenchLanguageServiceWorkerOperation]: {
    id: number
    operation: TOperation
    request: WorkbenchLanguageServiceWorkerOperationMap[TOperation]['request']
  }
}[WorkbenchLanguageServiceWorkerOperation]

export interface WorkbenchLanguageServiceWorkerResponse {
  id: number
  result?: unknown
  error?: SerializedError
}
