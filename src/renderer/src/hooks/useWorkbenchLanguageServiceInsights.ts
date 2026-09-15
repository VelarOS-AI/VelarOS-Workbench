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
import { useStableWorkbenchMessageTranslate } from '@renderer/runtime/useStableWorkbenchMessaging'
import type { WorkbenchOpenEditorTab } from '@renderer/types/workbenchTypes'

import { isEmpty } from '@velaros-ai/core'

import type {
  WorkbenchLanguageServiceDiagnostic,
  WorkbenchLanguageServiceDocumentSymbol,
} from '@shared/contracts'

import { useLatest } from '../support/genericHooks'

const MAX_DIAGNOSTIC_TABS = 8
/** 内容变了的文件（正在编辑的那个）多久后重算。 */
const DIAGNOSTIC_DEBOUNCE_MS = 700
/** 别的打开文件多久后跟着复核：它们的内容没变，只是当前文件的改动或磁盘上的改动可能影响它们。 */
const SIBLING_DIAGNOSTIC_DEBOUNCE_MS = 1_800

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
  externalRevision,
}: {
  projectRoot: Nullable<string>
  openTabs: readonly WorkbenchOpenEditorTab[]
  selectedFilePath: Nullable<string>
  editorContent: string
  /** 工作区在编辑器之外被改动的次数：变了就重算所有打开文件的诊断，即使它们的内容没变。 */
  externalRevision: number
}): WorkbenchLanguageServiceInsights {
  const hostRuntime = useWorkbenchHostRuntime()
  const { messageLatest, tLatest } = useStableWorkbenchMessageTranslate()
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
  const announcedErrorRef = useRef<Nullable<string>>(null)
  const contextRef = useLatest({ projectRoot, openTabs, selectedFilePath, editorContent })

  // 内容键按值比较：标签对象因保存、外部刷新换了身份但文本没变时，不重新排诊断。
  const diagnosticContentKey = useMemo(
    () =>
      openTabs
        .filter((tab) => usesWorkbenchBuiltinLanguageService(tab.path))
        .slice(0, MAX_DIAGNOSTIC_TABS)
        .map((tab) => {
          const content = tab.path === selectedFilePath ? editorContent : tab.content

          return `${tab.path}\u001f${content}`
        })
        .join('\u001e'),
    [editorContent, openTabs, selectedFilePath]
  )
  const scheduledContentByPathRef = useRef(new Map<string, string>())
  const pendingPathsRef = useRef(new Set<string>())

  // 内容变了的文件（正在编辑的那个）700ms 后重算；别的打开文件的内容没变，只是可能受它影响（导出改了）
  // 或者工作区在外面变了（externalRevision），等手停下来再复核，旧结论在此之前继续显示、面板不闪。
  // 连续输入时不必每一波都把 8 个标签全算一遍：语言服务 worker 是串行的，一个大文件的类型检查就要几百毫秒。
  useEffect(() => {
    const root = contextRef.current.projectRoot
    const { openTabs: currentTabs, selectedFilePath: activePath, editorContent: activeContent } =
      contextRef.current
    const targets = currentTabs
      .filter((tab) => usesWorkbenchBuiltinLanguageService(tab.path))
      .slice(0, MAX_DIAGNOSTIC_TABS)
    if (!root || isEmpty(targets)) {
      announcedErrorRef.current = null
      scheduledContentByPathRef.current = new Map()
      pendingPathsRef.current = new Set()
      setDiagnosticsByPath(new Map())
      setDiagnosticsPendingPaths(new Set())
      return undefined
    }

    const generation = ++diagnosticGenerationRef.current
    const contentByPath = new Map(
      targets.map((tab) => [tab.path, tab.path === activePath ? activeContent : tab.content] as const)
    )
    const previousContentByPath = scheduledContentByPathRef.current
    scheduledContentByPathRef.current = contentByPath
    const changedPaths = new Set(
      [...contentByPath].filter(([path, content]) => previousContentByPath.get(path) !== content)
        .map(([path]) => path)
    )
    // 上一轮还没算完就被打断的照样尽快算；当前文件永远走快车道。
    const promptPaths = new Set(
      [...pendingPathsRef.current].filter((path) => contentByPath.has(path))
    )
    for (const path of changedPaths) promptPaths.add(path)
    if (activePath && contentByPath.has(activePath)) promptPaths.add(activePath)
    const siblingPaths = [...contentByPath.keys()].filter((path) => !promptPaths.has(path))

    // 内容变了的旧诊断已经对不上文本，先撤下；只是复核的继续显示。
    const pendingPaths = new Set(
      [...pendingPathsRef.current].filter((path) => contentByPath.has(path))
    )
    for (const path of changedPaths) pendingPaths.add(path)
    pendingPathsRef.current = pendingPaths
    setDiagnosticsPendingPaths(new Set(pendingPaths))
    if (changedPaths.size > 0)
      setDiagnosticsByPath((current) => omitWorkbenchPendingDiagnostics(current, changedPaths))

    // 当前文件的实时缓冲进共享的打开文件覆盖层：别的标签看到的是刚改过的依赖，而不是旧的标签快照。
    const openTabsWithLiveContent = currentTabs.map((tab) =>
      tab.path === activePath ? { ...tab, content: activeContent } : tab
    )
    const request = async (paths: readonly string[]): Promise<void> => {
      if (isEmpty(paths)) return
      const results = new Map<string, readonly WorkbenchLanguageServiceDiagnostic[]>()
      let failureMessage: Nullable<string> = null

      await Promise.all(
        paths.map(async (path) => {
          const result = await getWorkbenchLanguageServiceDiagnostics({
            ...buildWorkbenchLanguageServiceRequestBase({
              projectRoot: root,
              path,
              language: fileLanguage(path),
              content: contentByPath.get(path) ?? '',
              openTabs: openTabsWithLiveContent,
            }),
          }, hostRuntime)

          if (!result.ok) {
            failureMessage ??= result.error.message
            return
          }
          results.set(path, result.data.diagnostics.filter((diagnostic) => diagnostic.path === path))
        })
      )

      if (generation !== diagnosticGenerationRef.current) return
      const errorKey = failureMessage ? `${root}\0${failureMessage}` : null
      if (failureMessage && announcedErrorRef.current !== errorKey) {
        messageLatest.current.error({
          title: tLatest.current('workbench.languageServiceStartFailed'),
          description: failureMessage,
        })
      }
      announcedErrorRef.current = errorKey
      setDiagnosticsByPath((current) => {
        const next = new Map<string, readonly WorkbenchLanguageServiceDiagnostic[]>()
        for (const [path, diagnostics] of current) if (contentByPath.has(path)) next.set(path, diagnostics)
        for (const [path, diagnostics] of results) next.set(path, diagnostics)
        return next
      })
      const remaining = new Set(
        [...pendingPathsRef.current].filter((path) => !paths.includes(path))
      )
      pendingPathsRef.current = remaining
      setDiagnosticsPendingPaths(remaining)
    }

    const promptTimer = setTimeout(() => void request([...promptPaths]), DIAGNOSTIC_DEBOUNCE_MS)
    const siblingTimer = isEmpty(siblingPaths)
      ? null
      : setTimeout(() => void request(siblingPaths), SIBLING_DIAGNOSTIC_DEBOUNCE_MS)

    return () => {
      clearTimeout(promptTimer)
      if (siblingTimer) clearTimeout(siblingTimer)
    }
  }, [contextRef, diagnosticContentKey, externalRevision, hostRuntime, messageLatest, tLatest])

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
