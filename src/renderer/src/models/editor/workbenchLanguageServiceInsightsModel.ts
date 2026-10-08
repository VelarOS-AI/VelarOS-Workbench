import { type WorkbenchLanguageServiceDiagnostic } from '@shared/contracts/workbench'

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

/** 整项目检查的一批结果并进已有的：这一批查过的文件以新结果为准（没有问题的清掉），其余不动。 */
export function applyWorkbenchProjectDiagnosticsBatch(
  current: ReadonlyMap<string, readonly WorkbenchLanguageServiceDiagnostic[]>,
  batch: {
    checkedPaths: readonly string[]
    diagnostics: readonly WorkbenchLanguageServiceDiagnostic[]
  }
): ReadonlyMap<string, readonly WorkbenchLanguageServiceDiagnostic[]> {
  const next = new Map(current)
  for (const path of batch.checkedPaths) next.delete(path)
  for (const diagnostic of batch.diagnostics) {
    if (!batch.checkedPaths.includes(diagnostic.path)) continue
    next.set(diagnostic.path, [...(next.get(diagnostic.path) ?? []), diagnostic])
  }
  return next
}

/** 整项目检查查完一轮：这一轮没查到的文件（删掉了、不在项目里了）不再挂着旧问题。 */
export function retainWorkbenchProjectDiagnostics(
  current: ReadonlyMap<string, readonly WorkbenchLanguageServiceDiagnostic[]>,
  checkedPaths: ReadonlySet<string>
): ReadonlyMap<string, readonly WorkbenchLanguageServiceDiagnostic[]> {
  if ([...current.keys()].every((path) => checkedPaths.has(path))) return current
  return new Map([...current].filter(([path]) => checkedPaths.has(path)))
}

/**
 * 问题面板用的诊断：打开着、有语言服务的文件用它自己的实时诊断（跟着编辑缓冲走，含建议与 ESLint），其余文件用
 * 整项目检查的结果。
 */
export function mergeWorkbenchDiagnosticsByPath({
  openDiagnosticsByPath,
  projectDiagnosticsByPath,
  openPaths,
}: {
  openDiagnosticsByPath: ReadonlyMap<string, readonly WorkbenchLanguageServiceDiagnostic[]>
  projectDiagnosticsByPath: ReadonlyMap<string, readonly WorkbenchLanguageServiceDiagnostic[]>
  openPaths: ReadonlySet<string>
}): ReadonlyMap<string, readonly WorkbenchLanguageServiceDiagnostic[]> {
  if (projectDiagnosticsByPath.size === 0) return openDiagnosticsByPath

  const merged = new Map<string, readonly WorkbenchLanguageServiceDiagnostic[]>()
  for (const [path, diagnostics] of projectDiagnosticsByPath)
    if (!openPaths.has(path) && diagnostics.length > 0) merged.set(path, diagnostics)
  for (const [path, diagnostics] of openDiagnosticsByPath) merged.set(path, diagnostics)
  return merged
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
