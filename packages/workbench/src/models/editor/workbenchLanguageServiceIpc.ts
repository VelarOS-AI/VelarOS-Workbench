import { workbenchHost } from '../../host'

type WorkbenchLanguageServiceCompletionsPayload = Parameters<
  typeof workbenchHost.kernel.project.getWorkbenchLanguageServiceCompletions
>[0]
type WorkbenchLanguageServiceDefinitionPayload = Parameters<
  typeof workbenchHost.kernel.project.getWorkbenchLanguageServiceDefinition
>[0]
type WorkbenchLanguageServiceDiagnosticsPayload = Parameters<
  typeof workbenchHost.kernel.project.getWorkbenchLanguageServiceDiagnostics
>[0]
type WorkbenchLanguageServiceRenamePayload = Parameters<
  typeof workbenchHost.kernel.project.getWorkbenchLanguageServiceRename
>[0]
type WorkbenchLanguageServiceHoverPayload = Parameters<
  typeof workbenchHost.kernel.project.getWorkbenchLanguageServiceHover
>[0]
type WorkbenchLanguageServiceReferencesPayload = Parameters<
  typeof workbenchHost.kernel.project.getWorkbenchLanguageServiceReferences
>[0]
type WorkbenchLanguageServiceSignatureHelpPayload = Parameters<
  typeof workbenchHost.kernel.project.getWorkbenchLanguageServiceSignatureHelp
>[0]
type WorkbenchLanguageServiceFormatPayload = Parameters<
  typeof workbenchHost.kernel.project.getWorkbenchLanguageServiceFormat
>[0]
type WorkbenchLanguageServiceDocumentSymbolsPayload = Parameters<
  typeof workbenchHost.kernel.project.getWorkbenchLanguageServiceDocumentSymbols
>[0]
type WorkbenchLanguageServiceDocumentHighlightsPayload = Parameters<
  typeof workbenchHost.kernel.project.getWorkbenchLanguageServiceDocumentHighlights
>[0]
type WorkbenchLanguageServiceInlayHintsPayload = Parameters<
  typeof workbenchHost.kernel.project.getWorkbenchLanguageServiceInlayHints
>[0]

type WorkbenchInlineCompletionPayload = Parameters<
  typeof workbenchHost.kernel.project.getWorkbenchInlineCompletion
>[0]

export function getWorkbenchLanguageServiceCompletions(
  payload: WorkbenchLanguageServiceCompletionsPayload
): ReturnType<typeof workbenchHost.kernel.project.getWorkbenchLanguageServiceCompletions> {
  return workbenchHost.kernel.project.getWorkbenchLanguageServiceCompletions(payload)
}

export function getWorkbenchInlineCompletion(
  payload: WorkbenchInlineCompletionPayload
): ReturnType<typeof workbenchHost.kernel.project.getWorkbenchInlineCompletion> {
  return workbenchHost.kernel.project.getWorkbenchInlineCompletion(payload)
}

export function getWorkbenchLanguageServiceDefinition(
  payload: WorkbenchLanguageServiceDefinitionPayload
): ReturnType<typeof workbenchHost.kernel.project.getWorkbenchLanguageServiceDefinition> {
  return workbenchHost.kernel.project.getWorkbenchLanguageServiceDefinition(payload)
}

export function getWorkbenchLanguageServiceDiagnostics(
  payload: WorkbenchLanguageServiceDiagnosticsPayload
): ReturnType<typeof workbenchHost.kernel.project.getWorkbenchLanguageServiceDiagnostics> {
  return workbenchHost.kernel.project.getWorkbenchLanguageServiceDiagnostics(payload)
}

export function getWorkbenchLanguageServiceRename(
  payload: WorkbenchLanguageServiceRenamePayload
): ReturnType<typeof workbenchHost.kernel.project.getWorkbenchLanguageServiceRename> {
  return workbenchHost.kernel.project.getWorkbenchLanguageServiceRename(payload)
}

export function getWorkbenchLanguageServiceHover(
  payload: WorkbenchLanguageServiceHoverPayload
): ReturnType<typeof workbenchHost.kernel.project.getWorkbenchLanguageServiceHover> {
  return workbenchHost.kernel.project.getWorkbenchLanguageServiceHover(payload)
}

export function getWorkbenchLanguageServiceReferences(
  payload: WorkbenchLanguageServiceReferencesPayload
): ReturnType<typeof workbenchHost.kernel.project.getWorkbenchLanguageServiceReferences> {
  return workbenchHost.kernel.project.getWorkbenchLanguageServiceReferences(payload)
}

export function getWorkbenchLanguageServiceSignatureHelp(
  payload: WorkbenchLanguageServiceSignatureHelpPayload
): ReturnType<typeof workbenchHost.kernel.project.getWorkbenchLanguageServiceSignatureHelp> {
  return workbenchHost.kernel.project.getWorkbenchLanguageServiceSignatureHelp(payload)
}

export function getWorkbenchLanguageServiceFormat(
  payload: WorkbenchLanguageServiceFormatPayload
): ReturnType<typeof workbenchHost.kernel.project.getWorkbenchLanguageServiceFormat> {
  return workbenchHost.kernel.project.getWorkbenchLanguageServiceFormat(payload)
}

export function getWorkbenchLanguageServiceDocumentSymbols(
  payload: WorkbenchLanguageServiceDocumentSymbolsPayload
): ReturnType<typeof workbenchHost.kernel.project.getWorkbenchLanguageServiceDocumentSymbols> {
  return workbenchHost.kernel.project.getWorkbenchLanguageServiceDocumentSymbols(payload)
}

export function getWorkbenchLanguageServiceDocumentHighlights(
  payload: WorkbenchLanguageServiceDocumentHighlightsPayload
): ReturnType<typeof workbenchHost.kernel.project.getWorkbenchLanguageServiceDocumentHighlights> {
  return workbenchHost.kernel.project.getWorkbenchLanguageServiceDocumentHighlights(payload)
}

export function getWorkbenchLanguageServiceInlayHints(
  payload: WorkbenchLanguageServiceInlayHintsPayload
): ReturnType<typeof workbenchHost.kernel.project.getWorkbenchLanguageServiceInlayHints> {
  return workbenchHost.kernel.project.getWorkbenchLanguageServiceInlayHints(payload)
}
