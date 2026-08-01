import { useCallback, useEffect, useState } from 'react'
import type { WorkbenchGitChangeItem } from '@renderer/models/git/workbenchGitModel'
import type { WorkbenchLightEditorTab } from '@renderer/types/workbenchTypes'

import { toNullable } from '@velaros-ai/core'

import type { EditorNavigationRequest } from '../components/editor/CodeInsightPanel'
import { useLatest } from '../support/genericHooks'

export interface WorkbenchEditorCursorSnapshot {
  line: number
  column: number
  selection?: {
    startLine: number
    endLine: number
    startColumn: number
    endColumn: number
  }
}

/** 编辑器区里的一个内置 webview 调试选项卡。 */
export interface WorkbenchDebugTab {
  id: string
  url: string
  title: string
}

const WorkbenchAgentBrowserTabPrefix = 'agent-browser:'

/** 用 host（含端口）作为调试选项卡标题，取不到就退回原始 URL。 */
function deriveDebugTabTitle(url: string): string {
  try {
    return new URL(url).host || url
  } catch {
    return url
  }
}

interface UseWorkbenchEditorNavigationStateOptions {
  gitChangeItems: WorkbenchGitChangeItem[]
  selectedFilePath: Nullable<string>
  onSelectFile: (path: string) => Promise<any>
}

export function useWorkbenchEditorNavigationState({
  gitChangeItems,
  selectedFilePath,
  onSelectFile,
}: UseWorkbenchEditorNavigationStateOptions) {
  const onSelectFileLatest = useLatest(onSelectFile)
  const [cursorPosition, setCursorPosition] = useState<WorkbenchEditorCursorSnapshot>({
    line: 1,
    column: 1,
  })
  const [diffItem, setDiffItem] = useState<Nullable<WorkbenchGitChangeItem>>(null)
  const [lightTab, setLightTab] = useState<Nullable<WorkbenchLightEditorTab>>(null)
  const [debugTabs, setDebugTabs] = useState<WorkbenchDebugTab[]>([])
  const [activeDebugTabId, setActiveDebugTabId] = useState<Nullable<string>>(null)
  const [agentBrowserTabSessionId, setAgentBrowserTabSessionId] =
    useState<Nullable<string>>(null)
  const debugTabsRef = useLatest(debugTabs)
  const [navigationRequest, setNavigationRequest] = useState<Nullable<EditorNavigationRequest>>(null)
  const [activeProblemId, setActiveProblemIdState] = useState<Nullable<string>>(null)
  const setActiveProblemId = useCallback((problemId: Nullable<string>) => {
    setActiveProblemIdState((current) => (current === problemId ? current : problemId))
  }, [])

  useEffect(() => {
    setActiveProblemId(null)
  }, [selectedFilePath, setActiveProblemId])

  async function selectFile(path: string): Promise<void> {
    setDiffItem(null)
    setLightTab(null)
    setActiveDebugTabId(null)
    await onSelectFileLatest.current(path)
  }

  async function goToLocation(path: string, line: number, column?: number): Promise<void> {
    setDiffItem(null)
    setLightTab(null)
    setActiveDebugTabId(null)
    if (path !== selectedFilePath) {
      await onSelectFileLatest.current(path)
    }

    setNavigationRequest((request) => ({
      id: (request?.id ?? 0) + 1,
      line,
      column,
    }))
  }

  useEffect(() => {
    if (!diffItem) return

    const next = gitChangeItems.find((item) => item.path === diffItem.path)
    if (!next) {
      setDiffItem(null)
      return
    }

    // 刷新会重建行；合并到最新条目，确保暂存、未暂存和未跟踪状态正确。
    // 但不要求状态码完全一致，格式可能漂移，否则会误关差异视图。
    if (
      next.group !== diffItem.group ||
      next.statusCode !== diffItem.statusCode ||
      next.indexStatus !== diffItem.indexStatus ||
      next.workTreeStatus !== diffItem.workTreeStatus
    ) {
      setDiffItem(next)
    }
  }, [diffItem, gitChangeItems])

  function openDiff(item: WorkbenchGitChangeItem): void {
    setLightTab(null)
    setActiveDebugTabId(null)
    setDiffItem(item)
  }

  function openLightTab(tab: WorkbenchLightEditorTab): void {
    setDiffItem(null)
    setActiveDebugTabId(null)
    setLightTab(tab)
  }

  const openDebugTab = useCallback((rawUrl: string): void => {
    const url = rawUrl.trim()
    if (!url) return

    // webview 调试页与 diff/light 互斥（都占编辑区）。
    setDiffItem(null)
    setLightTab(null)

    const existing = debugTabsRef.current.find((tab) => tab.url === url)
    if (existing) {
      setActiveDebugTabId(existing.id)
      return
    }

    const id = `debug-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    setDebugTabs((current) => [...current, { id, url, title: deriveDebugTabTitle(url) }])
    setActiveDebugTabId(id)
  }, [debugTabsRef])

  const selectDebugTab = useCallback((id: string): void => {
    setDiffItem(null)
    setLightTab(null)
    setActiveDebugTabId(id)
  }, [])

  const closeDebugTab = useCallback((id: string): void => {
    setDebugTabs((current) => {
      const next = current.filter((tab) => tab.id !== id)
      setActiveDebugTabId((active) =>
        active === id ? toNullable(next.at(-1)?.id) : active
      )
      return next
    })
  }, [])

  const navigateDebugTab = useCallback((id: string, url: string, title?: string): void => {
    setDebugTabs((current) =>
      current.map((tab) =>
        tab.id === id
          ? { ...tab, url, title: title?.trim() || deriveDebugTabTitle(url) }
          : tab
      )
    )
  }, [])

  const agentBrowserTabId = agentBrowserTabSessionId
    ? `${WorkbenchAgentBrowserTabPrefix}${agentBrowserTabSessionId}`
    : null
  const openAgentBrowserTab = useCallback((sessionId: string): void => {
    const normalizedSessionId = sessionId.trim()
    if (!normalizedSessionId) return

    const id = `${WorkbenchAgentBrowserTabPrefix}${normalizedSessionId}`
    setAgentBrowserTabSessionId(normalizedSessionId)
    setDiffItem(null)
    setLightTab(null)
    setActiveDebugTabId(id)
  }, [])
  const selectAgentBrowserTab = useCallback((): void => {
    if (!agentBrowserTabSessionId) return

    setDiffItem(null)
    setLightTab(null)
    setActiveDebugTabId(`${WorkbenchAgentBrowserTabPrefix}${agentBrowserTabSessionId}`)
  }, [agentBrowserTabSessionId])
  const closeAgentBrowserTab = useCallback((): void => {
    setAgentBrowserTabSessionId((sessionId) => {
      if (sessionId) {
        const id = `${WorkbenchAgentBrowserTabPrefix}${sessionId}`
        setActiveDebugTabId((active) => (active === id ? null : active))
      }
      return null
    })
  }, [])
  const agentBrowser = {
    tabId: agentBrowserTabId,
    sessionId: agentBrowserTabSessionId,
    open: openAgentBrowserTab,
    select: selectAgentBrowserTab,
    close: closeAgentBrowserTab,
  }
  const debug = {
    tabs: debugTabs,
    activeTabId: activeDebugTabId,
    openTab: openDebugTab,
    selectTab: selectDebugTab,
    closeTab: closeDebugTab,
    navigateTab: navigateDebugTab,
    agentBrowser,
  }

  function updateLightTabContent(content: string): void {
    setLightTab((current) => (current ? { ...current, content } : null))
  }

  function patchLightTabMetadata(metadata: { size: number; modifiedAt: number }): void {
    setLightTab((current) => (current ? { ...current, ...metadata } : null))
  }

  return {
    activeProblemId,
    cursorPosition,
    diffItem,
    goToLocation,
    lightTab,
    navigationRequest,
    openDiff,
    openLightTab,
    updateLightTabContent,
    patchLightTabMetadata,
    selectFile,
    setActiveProblemId,
    setCursorPosition,
    debug,
    closeDiff: () => setDiffItem(null),
    closeLightTab: () => setLightTab(null),
  }
}
