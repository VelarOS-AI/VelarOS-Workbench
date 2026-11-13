import type { LintSource } from '@codemirror/lint'

import type { WorkbenchProjectKernelPort } from '../../host/WorkbenchHost'
import type { WorkbenchOpenEditorTab } from '../../types/workbenchTypes'

import { mapWorkbenchDiagnosticToCodeMirror } from './workbenchCodeMirrorDiagnostics'
import {
  buildWorkbenchLanguageServiceRequestBase,
  usesWorkbenchBuiltinLanguageService,
} from './workbenchCodeMirrorLanguageService'

interface WorkbenchLintSourceOptions {
  projectRoot: string
  path: Nullable<string>
  language: string
  getOpenTabs: () => readonly WorkbenchOpenEditorTab[]
  getActivePath: () => Nullable<string>
  requestDiagnostics: WorkbenchProjectKernelPort['getWorkbenchLanguageServiceDiagnostics']
}

/** Publish markers as soon as diagnostics arrive. Quick fixes are requested on demand by the hover UI. */
export function createWorkbenchCodeMirrorLintSource({
  projectRoot,
  path,
  language,
  getOpenTabs,
  getActivePath,
  requestDiagnostics,
}: WorkbenchLintSourceOptions): LintSource {
  let generation = 0
  return async (view) => {
    if (!path || !usesWorkbenchBuiltinLanguageService(path) || getActivePath() !== path) return []
    const current = ++generation
    const document = view.state.doc
    const result = await requestDiagnostics(
      buildWorkbenchLanguageServiceRequestBase({
        projectRoot,
        path,
        language,
        content: document.toString(),
        openTabs: getOpenTabs(),
      })
    )
    if (
      !result.ok ||
      current !== generation ||
      getActivePath() !== path ||
      view.state.doc !== document
    )
      return []
    return result.data.diagnostics
      .filter((diagnostic) => diagnostic.path === path)
      .flatMap((diagnostic) => {
        const mapped = mapWorkbenchDiagnosticToCodeMirror(view.state, diagnostic)
        return mapped ? [mapped] : []
      })
  }
}
