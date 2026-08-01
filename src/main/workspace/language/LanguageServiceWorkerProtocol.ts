import type { SerializedError } from '@velaros-ai/core/error'

import type {
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
  WorkbenchLanguageServiceResolveResult,
  WorkbenchLanguageServiceSignatureHelpQueryResult,
} from '@shared/contracts'

export interface WorkbenchLanguageServiceProjectRequest {
  projectRoot: string
}

export interface WorkbenchLanguageServiceProjectFileRequest extends WorkbenchLanguageServiceProjectRequest {
  path: string
  content: Nullable<string>
}

export interface WorkbenchLanguageServiceWorkerOperationMap {
  synchronizeProjectFile: {
    request: WorkbenchLanguageServiceProjectFileRequest
    result: void
  }
  invalidateProject: {
    request: WorkbenchLanguageServiceProjectRequest
    result: void
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
}

export type WorkbenchLanguageServiceWorkerOperation =
  keyof WorkbenchLanguageServiceWorkerOperationMap

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
