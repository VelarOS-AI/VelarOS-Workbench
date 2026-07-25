import type { WorkbenchLanguageServiceDiagnostic } from '@velaros-ai/core/types'

export interface WorkbenchFileDiagnosticView {
  diagnostics: readonly WorkbenchLanguageServiceDiagnostic[]
  isPending: boolean
}

export function omitWorkbenchPendingDiagnostics(
  diagnosticsByPath: ReadonlyMap<string, readonly WorkbenchLanguageServiceDiagnostic[]>,
  diagnosticsPendingPaths: ReadonlySet<string>
): ReadonlyMap<string, readonly WorkbenchLanguageServiceDiagnostic[]> {
  if (!diagnosticsPendingPaths.size) return diagnosticsByPath

  const nextDiagnostics = new Map(diagnosticsByPath)
  for (const path of diagnosticsPendingPaths) {
    nextDiagnostics.delete(path)
  }

  return nextDiagnostics
}

export function getWorkbenchFileDiagnosticView({
  path,
  diagnosticsByPath,
  diagnosticsPendingPaths,
}: {
  path: Nullable<string>
  diagnosticsByPath: ReadonlyMap<string, readonly WorkbenchLanguageServiceDiagnostic[]>
  diagnosticsPendingPaths: ReadonlySet<string>
}): WorkbenchFileDiagnosticView {
  if (!path)
    return {
      diagnostics: [],
      isPending: false,
    }

  const isPending = diagnosticsPendingPaths.has(path)

  return {
    diagnostics: isPending ? [] : (diagnosticsByPath.get(path) ?? []),
    isPending,
  }
}
