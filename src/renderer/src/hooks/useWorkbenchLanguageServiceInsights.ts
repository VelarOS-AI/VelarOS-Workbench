import { useEffect, useMemo, useRef, useState } from 'react'
import { useWorkbenchHostRuntime } from '@renderer/host'
import {
  buildWorkbenchLanguageServiceRequestBase,
  usesWorkbenchBuiltinLanguageService,
  usesWorkbenchTypeScriptLanguageService,
} from '@renderer/models/editor/workbenchCodeMirrorLanguageService'
import { omitWorkbenchPendingDiagnostics } from '@renderer/models/editor/workbenchLanguageServiceInsightsModel'
import {
  getWorkbenchLanguageServiceDiagnostics,
  getWorkbenchLanguageServiceDocumentSymbols,
} from '@renderer/models/editor/workbenchLanguageServiceIpc'
import { fileLanguage } from '@renderer/models/shared/workbenchUtils'
import type { WorkbenchOpenEditorTab } from '@renderer/types/workbenchTypes'

import { isEmpty } from '@velaros-ai/core'

import type {
  WorkbenchLanguageServiceDiagnostic,
  WorkbenchLanguageServiceDocumentSymbol,
} from '@shared/contracts'

import { useLatest } from '../support/genericHooks'

const MAX_DIAGNOSTIC_TABS = 8
const DIAGNOSTIC_DEBOUNCE_MS = 700

export interface WorkbenchLanguageServiceInsights {
  diagnosticsByPath: ReadonlyMap<string, readonly WorkbenchLanguageServiceDiagnostic[]>
  diagnosticsPendingPaths: ReadonlySet<string>
  documentSymbols: readonly WorkbenchLanguageServiceDocumentSymbol[]
}

export function useWorkbenchLanguageServiceInsights({
  projectRoot,
  openTabs,
  selectedFilePath,
  editorContent,
}: {
  projectRoot: Nullable<string>
  openTabs: readonly WorkbenchOpenEditorTab[]
  selectedFilePath: Nullable<string>
  editorContent: string
}): WorkbenchLanguageServiceInsights {
  const hostRuntime = useWorkbenchHostRuntime()
  const [diagnosticsByPath, setDiagnosticsByPath] = useState<
    ReadonlyMap<string, readonly WorkbenchLanguageServiceDiagnostic[]>
  >(() => new Map())
  const [diagnosticsPendingPaths, setDiagnosticsPendingPaths] = useState<ReadonlySet<string>>(
    () => new Set()
  )
  const [documentSymbols, setDocumentSymbols] = useState<
    readonly WorkbenchLanguageServiceDocumentSymbol[]
  >([])
  const diagnosticGenerationRef = useRef(0)
  const symbolGenerationRef = useRef(0)
  const contextRef = useLatest({ projectRoot, openTabs, selectedFilePath, editorContent })

  const diagnosticTargets = useMemo(
    () =>
      openTabs
        .filter((tab) => usesWorkbenchBuiltinLanguageService(tab.path))
        .slice(0, MAX_DIAGNOSTIC_TABS),
    [openTabs]
  )
  const diagnosticScheduleKey = useMemo(
    () =>
      diagnosticTargets
        .map((tab) => {
          const content = tab.path === selectedFilePath ? editorContent : tab.content

          return `${tab.path}\u001f${content}`
        })
        .join('\u001e'),
    [diagnosticTargets, editorContent, selectedFilePath]
  )

  useEffect(() => {
    const root = contextRef.current.projectRoot
    if (!root || isEmpty(diagnosticTargets)) {
      setDiagnosticsByPath(new Map())
      setDiagnosticsPendingPaths(new Set())
      return undefined
    }

    const generation = ++diagnosticGenerationRef.current
    const pendingPaths = new Set(diagnosticTargets.map((tab) => tab.path))
    setDiagnosticsPendingPaths(pendingPaths)
    setDiagnosticsByPath((current) => omitWorkbenchPendingDiagnostics(current, pendingPaths))

    const timer = setTimeout(() => {
      void (async () => {
        const nextDiagnostics = new Map<string, readonly WorkbenchLanguageServiceDiagnostic[]>()

        // Inject the active file's live buffer into the shared open-files overlay so that
        // other tabs see the just-edited dependency instead of a stale tab snapshot — this
        // clears cross-file errors that were already fixed in the active editor.
        const activePath = contextRef.current.selectedFilePath
        const activeContent = contextRef.current.editorContent
        const openTabsWithLiveContent = contextRef.current.openTabs.map((tab) =>
          tab.path === activePath ? { ...tab, content: activeContent } : tab
        )

        await Promise.all(
          diagnosticTargets.map(async (tab) => {
            const content = tab.path === activePath ? activeContent : tab.content

            const result = await getWorkbenchLanguageServiceDiagnostics({
              ...buildWorkbenchLanguageServiceRequestBase({
                projectRoot: root,
                path: tab.path,
                language: fileLanguage(tab.path),
                content,
                openTabs: openTabsWithLiveContent,
              }),
            }, hostRuntime)

            if (!result.ok) return
            nextDiagnostics.set(
              tab.path,
              result.data.diagnostics.filter((diagnostic) => diagnostic.path === tab.path)
            )
          })
        )

        if (generation !== diagnosticGenerationRef.current) return
        setDiagnosticsByPath(nextDiagnostics)
        setDiagnosticsPendingPaths(new Set())
      })()
    }, DIAGNOSTIC_DEBOUNCE_MS)

    return () => clearTimeout(timer)
  }, [contextRef, diagnosticScheduleKey, diagnosticTargets, hostRuntime])

  useEffect(() => {
    const root = contextRef.current.projectRoot
    const path = contextRef.current.selectedFilePath
    if (!root || !path || !usesWorkbenchTypeScriptLanguageService(path)) {
      setDocumentSymbols([])
      return undefined
    }

    const generation = ++symbolGenerationRef.current
    const timer = setTimeout(() => {
      void (async () => {
        const result = await getWorkbenchLanguageServiceDocumentSymbols({
          ...buildWorkbenchLanguageServiceRequestBase({
            projectRoot: root,
            path,
            language: fileLanguage(path),
            content: contextRef.current.editorContent,
            openTabs: contextRef.current.openTabs,
          }),
        }, hostRuntime)

        if (generation !== symbolGenerationRef.current) return
        setDocumentSymbols(result.ok ? result.data.symbols : [])
      })()
    }, 240)

    return () => clearTimeout(timer)
  }, [contextRef, editorContent, hostRuntime, selectedFilePath])

  return { diagnosticsByPath, diagnosticsPendingPaths, documentSymbols }
}
