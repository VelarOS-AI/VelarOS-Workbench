import type { WorkbenchProjectKernelPort } from '../../host'
import { workbenchHost,type WorkbenchHostRuntime } from '../../host'

type WorkbenchLanguageServiceCompletionsPayload = Parameters<
  WorkbenchProjectKernelPort['getWorkbenchLanguageServiceCompletions']
>[0]
type WorkbenchLanguageServiceDefinitionPayload = Parameters<
  WorkbenchProjectKernelPort['getWorkbenchLanguageServiceDefinition']
>[0]
type WorkbenchLanguageServiceDiagnosticsPayload = Parameters<
  WorkbenchProjectKernelPort['getWorkbenchLanguageServiceDiagnostics']
>[0]
type WorkbenchLanguageServiceRenamePayload = Parameters<
  WorkbenchProjectKernelPort['getWorkbenchLanguageServiceRename']
>[0]
type WorkbenchLanguageServiceHoverPayload = Parameters<
  WorkbenchProjectKernelPort['getWorkbenchLanguageServiceHover']
>[0]
type WorkbenchLanguageServiceReferencesPayload = Parameters<
  WorkbenchProjectKernelPort['getWorkbenchLanguageServiceReferences']
>[0]
type WorkbenchLanguageServiceSignatureHelpPayload = Parameters<
  WorkbenchProjectKernelPort['getWorkbenchLanguageServiceSignatureHelp']
>[0]
type WorkbenchLanguageServiceFormatPayload = Parameters<
  WorkbenchProjectKernelPort['getWorkbenchLanguageServiceFormat']
>[0]
type WorkbenchLanguageServiceDocumentSymbolsPayload = Parameters<
  WorkbenchProjectKernelPort['getWorkbenchLanguageServiceDocumentSymbols']
>[0]
type WorkbenchLanguageServiceDocumentHighlightsPayload = Parameters<
  WorkbenchProjectKernelPort['getWorkbenchLanguageServiceDocumentHighlights']
>[0]
type WorkbenchLanguageServiceInlayHintsPayload = Parameters<
  WorkbenchProjectKernelPort['getWorkbenchLanguageServiceInlayHints']
>[0]

type WorkbenchInlineCompletionPayload = Parameters<
  WorkbenchProjectKernelPort['getWorkbenchInlineCompletion']
>[0]

export function getWorkbenchLanguageServiceCompletions(
  payload: WorkbenchLanguageServiceCompletionsPayload,
  runtime: WorkbenchHostRuntime = workbenchHost
): ReturnType<WorkbenchProjectKernelPort['getWorkbenchLanguageServiceCompletions']> {
  return runtime.kernel.project.getWorkbenchLanguageServiceCompletions(payload)
}

export function getWorkbenchInlineCompletion(
  payload: WorkbenchInlineCompletionPayload,
  runtime: WorkbenchHostRuntime = workbenchHost
): ReturnType<WorkbenchProjectKernelPort['getWorkbenchInlineCompletion']> {
  return runtime.kernel.project.getWorkbenchInlineCompletion(payload)
}

export function getWorkbenchLanguageServiceDefinition(
  payload: WorkbenchLanguageServiceDefinitionPayload,
  runtime: WorkbenchHostRuntime = workbenchHost
): ReturnType<WorkbenchProjectKernelPort['getWorkbenchLanguageServiceDefinition']> {
  return runtime.kernel.project.getWorkbenchLanguageServiceDefinition(payload)
}

export function getWorkbenchLanguageServiceDiagnostics(
  payload: WorkbenchLanguageServiceDiagnosticsPayload,
  runtime: WorkbenchHostRuntime = workbenchHost
): ReturnType<WorkbenchProjectKernelPort['getWorkbenchLanguageServiceDiagnostics']> {
  return runtime.kernel.project.getWorkbenchLanguageServiceDiagnostics(payload)
}

export function getWorkbenchLanguageServiceRename(
  payload: WorkbenchLanguageServiceRenamePayload,
  runtime: WorkbenchHostRuntime = workbenchHost
): ReturnType<WorkbenchProjectKernelPort['getWorkbenchLanguageServiceRename']> {
  return runtime.kernel.project.getWorkbenchLanguageServiceRename(payload)
}

export function getWorkbenchLanguageServiceHover(
  payload: WorkbenchLanguageServiceHoverPayload,
  runtime: WorkbenchHostRuntime = workbenchHost
): ReturnType<WorkbenchProjectKernelPort['getWorkbenchLanguageServiceHover']> {
  return runtime.kernel.project.getWorkbenchLanguageServiceHover(payload)
}

export function getWorkbenchLanguageServiceReferences(
  payload: WorkbenchLanguageServiceReferencesPayload,
  runtime: WorkbenchHostRuntime = workbenchHost
): ReturnType<WorkbenchProjectKernelPort['getWorkbenchLanguageServiceReferences']> {
  return runtime.kernel.project.getWorkbenchLanguageServiceReferences(payload)
}

export function getWorkbenchLanguageServiceSignatureHelp(
  payload: WorkbenchLanguageServiceSignatureHelpPayload,
  runtime: WorkbenchHostRuntime = workbenchHost
): ReturnType<WorkbenchProjectKernelPort['getWorkbenchLanguageServiceSignatureHelp']> {
  return runtime.kernel.project.getWorkbenchLanguageServiceSignatureHelp(payload)
}

export function getWorkbenchLanguageServiceFormat(
  payload: WorkbenchLanguageServiceFormatPayload,
  runtime: WorkbenchHostRuntime = workbenchHost
): ReturnType<WorkbenchProjectKernelPort['getWorkbenchLanguageServiceFormat']> {
  return runtime.kernel.project.getWorkbenchLanguageServiceFormat(payload)
}

export function getWorkbenchLanguageServiceDocumentSymbols(
  payload: WorkbenchLanguageServiceDocumentSymbolsPayload,
  runtime: WorkbenchHostRuntime = workbenchHost
): ReturnType<WorkbenchProjectKernelPort['getWorkbenchLanguageServiceDocumentSymbols']> {
  return runtime.kernel.project.getWorkbenchLanguageServiceDocumentSymbols(payload)
}

export function getWorkbenchLanguageServiceDocumentHighlights(
  payload: WorkbenchLanguageServiceDocumentHighlightsPayload,
  runtime: WorkbenchHostRuntime = workbenchHost
): ReturnType<WorkbenchProjectKernelPort['getWorkbenchLanguageServiceDocumentHighlights']> {
  return runtime.kernel.project.getWorkbenchLanguageServiceDocumentHighlights(payload)
}

export function getWorkbenchLanguageServiceInlayHints(
  payload: WorkbenchLanguageServiceInlayHintsPayload,
  runtime: WorkbenchHostRuntime = workbenchHost
): ReturnType<WorkbenchProjectKernelPort['getWorkbenchLanguageServiceInlayHints']> {
  return runtime.kernel.project.getWorkbenchLanguageServiceInlayHints(payload)
}
