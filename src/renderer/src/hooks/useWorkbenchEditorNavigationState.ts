import { useCallback, useEffect, useRef, useState } from 'react'
import type { WorkbenchEditorOpenTabIntent } from '@renderer/models/editor/workbenchEditorGroups'
import type {
  WorkbenchIndentation,
  WorkbenchIndentationChange,
  WorkbenchIndentationRequest,
} from '@renderer/models/editor/workbenchIndentation'
import {
  WorkbenchNavigationHistory,
  type WorkbenchNavigationPoint,
} from '@renderer/models/editor/workbenchNavigationHistory'
import type {
  WorkbenchGitChangeItem,
  WorkbenchOpenDiffOptions,
} from '@renderer/models/git/workbenchGitModel'
import type { WorkbenchLightEditorTab } from '@renderer/types/workbenchTypes'

import { isFalse, isPositiveNumber, optionalWhen, toNullable } from '@velaros-ai/core'

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

/** 打开文件时带给编辑器控制器的：标签怎么开、没开着时开在哪一组。 */
export interface WorkbenchEditorOpenTabRequest extends WorkbenchEditorOpenTabIntent {
  groupIndex?: number
}

/** 跳到某个位置时的选项：选中的范围、要不要抢焦点、标签怎么开、没开着时开在哪一组。 */
export type WorkbenchEditorLocationOptions = Pick<
  EditorNavigationRequest,
  'endLine' | 'endColumn' | 'focus'
> &
  WorkbenchEditorOpenTabRequest

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
  /** 全局动作所在的编辑器组（0 左，1 右）：后退 / 前进记下它。 */
  focusedGroupIndex?: number
  /** 这个文件的标签在哪一组、或者打开它时会落在哪一组（见 resolveWorkbenchEditorTabGroupIndex）。 */
  resolveFileGroupIndex?: (path: string, preferredGroupIndex?: number) => number
  /** 打开文件并切过去；给出标签的路径（规范化后的，可能与传进去的写法不同），没打开给 null。 */
  onSelectFile: (
    path: string,
    options?: WorkbenchEditorOpenTabRequest
  ) => Promise<LooseOptional<string>>
  /** 左边那组上盖的标签（Git 对比、只读预览、网页调试）被用户打开或切到：全局动作交给左边那组。 */
  onPrimaryGroupTabShown?: () => void
}

export function useWorkbenchEditorNavigationState({
  gitChangeItems,
  selectedFilePath,
  focusedGroupIndex = 0,
  resolveFileGroupIndex,
  onSelectFile,
  onPrimaryGroupTabShown,
}: UseWorkbenchEditorNavigationStateOptions) {
  const onSelectFileLatest = useLatest(onSelectFile)
  const onPrimaryGroupTabShownLatest = useLatest(onPrimaryGroupTabShown)
  const resolveFileGroupIndexLatest = useLatest(resolveFileGroupIndex)
  const focusedGroupIndexLatest = useLatest(focusedGroupIndex)
  const [cursorPosition, setCursorPosition] = useState<WorkbenchEditorCursorSnapshot>({
    line: 1,
    column: 1,
  })
  const [diffItem, setDiffItem] = useState<Nullable<WorkbenchGitChangeItem>>(null)
  const [diffFocusFirstChangeRequestId, setDiffFocusFirstChangeRequestId] = useState(0)
  const [lightTab, setLightTab] = useState<Nullable<WorkbenchLightEditorTab>>(null)
  const [debugTabs, setDebugTabs] = useState<WorkbenchDebugTab[]>([])
  const [activeDebugTabId, setActiveDebugTabId] = useState<Nullable<string>>(null)
  /** Agent 浏览器标签属于哪个聊天会话；会话的浏览器没进站点时为 null。 */
  const [agentBrowserTabSessionId, setAgentBrowserTabSessionId] =
    useState<Nullable<string>>(null)
  const debugTabsRef = useLatest(debugTabs)
  const [navigationRequest, setNavigationRequest] = useState<Nullable<EditorNavigationRequest>>(null)
  // 状态栏显示的缩进（编辑器报上来），以及状态栏缩进菜单交回编辑器的操作。
  const [indentation, setIndentation] = useState<Nullable<WorkbenchIndentation>>(null)
  const [indentationRequest, setIndentationRequest] =
    useState<Nullable<WorkbenchIndentationRequest>>(null)
  const requestIndentationChange = useCallback((change: WorkbenchIndentationChange): void => {
    setIndentationRequest((current) => ({ id: (current?.id ?? 0) + 1, change }))
  }, [])
  const [activeProblemId, setActiveProblemIdState] = useState<Nullable<string>>(null)
  const setActiveProblemId = useCallback((problemId: Nullable<string>) => {
    setActiveProblemIdState((current) => (current === problemId ? current : problemId))
  }, [])

  useEffect(() => {
    setActiveProblemId(null)
  }, [selectedFilePath, setActiveProblemId])

  // 后退 / 前进：切文件、跳到定义或某一行之前记下当前的文件和光标。
  const navigationHistoryRef = useRef(new WorkbenchNavigationHistory())
  const selectedFilePathLatest = useLatest(selectedFilePath)
  const cursorPositionLatest = useLatest(cursorPosition)
  const currentNavigationPoint = (): Nullable<WorkbenchNavigationPoint> => {
    const path = selectedFilePathLatest.current
    if (!path) return null
    const { line, column } = cursorPositionLatest.current
    return { path, line, column, group: focusedGroupIndexLatest.current }
  }
  const recordNavigationPoint = useCallback((): void => {
    const path = selectedFilePathLatest.current
    if (!path) return
    const { line, column } = cursorPositionLatest.current
    navigationHistoryRef.current.record({
      path,
      line,
      column,
      group: focusedGroupIndexLatest.current,
    })
  }, [cursorPositionLatest, focusedGroupIndexLatest, selectedFilePathLatest])

  /** 左边那组要显示文件了：把盖在那组编辑器上的 Git 对比、只读预览收掉，网页调试标签放到后面。 */
  const uncoverPrimaryGroup = useCallback((): void => {
    setDiffItem(null)
    setDiffFocusFirstChangeRequestId(0)
    setLightTab(null)
    setActiveDebugTabId(null)
  }, [])

  /**
   * 要在编辑区里显示一个文件了：它落在左边那组时，把盖在那组编辑器上的标签让开。落在右边那组时不动它们——
   * 那些标签只在左边那组里。
   */
  function revealFileGroup(path: string, groupIndex?: number): void {
    if ((resolveFileGroupIndexLatest.current?.(path, groupIndex) ?? 0) === 0) uncoverPrimaryGroup()
  }

  async function selectFile(path: string, intent?: WorkbenchEditorOpenTabRequest): Promise<void> {
    if (path !== selectedFilePathLatest.current) recordNavigationPoint()
    revealFileGroup(path, intent?.groupIndex)
    await onSelectFileLatest.current(path, intent)
  }

  async function goToLocation(
    path: string,
    line: number,
    column?: number,
    options?: WorkbenchEditorLocationOptions
  ): Promise<void> {
    recordNavigationPoint()
    await openLocation(path, line, column, options)
  }

  /**
   * 后退或前进到历史里的位置（这一步本身不再记进历史）：文件还开着就去它所在的那一组；标签已经关掉时在
   * 当时那一组里以预览标签重新打开（与 VS Code 一致）。
   */
  async function goThroughHistory(direction: 'back' | 'forward'): Promise<void> {
    const history = navigationHistoryRef.current
    const current = currentNavigationPoint()
    const target = direction === 'back' ? history.back(current) : history.forward(current)
    if (target)
      await openLocation(target.path, target.line, target.column, {
        preview: true,
        groupIndex: target.group,
      })
  }

  async function openLocation(
    path: string,
    line: number,
    column?: number,
    options?: WorkbenchEditorLocationOptions
  ): Promise<void> {
    revealFileGroup(path, options?.groupIndex)
    // 已经是当前文件时也过一遍：普通打开要把预览标签留下。
    const openedPath = await onSelectFileLatest.current(path, {
      preview: options?.preview,
      keepSource: options?.keepSource,
      groupIndex: options?.groupIndex,
    })

    setNavigationRequest((request) => ({
      id: (request?.id ?? 0) + 1,
      // 定位请求按标签的路径找编辑器：用打开之后的那个写法（还在读的文件先按传进来的，读完补跳）。
      path: openedPath ?? path,
      line,
      column,
      endLine: optionalWhen(isPositiveNumber, options?.endLine),
      endColumn: optionalWhen(isPositiveNumber, options?.endColumn),
      focus: optionalWhen(isFalse, options?.focus),
    }))
  }

  useEffect(() => {
    if (!diffItem) return

    // 暂存了一部分的文件两侧各一条：先找同一侧；这一侧的改动没了（全暂存了、全取消暂存了）就跟到另一侧。
    const next =
      gitChangeItems.find((item) => item.path === diffItem.path && item.group === diffItem.group) ??
      gitChangeItems.find((item) => item.path === diffItem.path)
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

  function openDiff(item: WorkbenchGitChangeItem, options?: WorkbenchOpenDiffOptions): void {
    onPrimaryGroupTabShownLatest.current?.()
    setLightTab(null)
    setActiveDebugTabId(null)
    setDiffFocusFirstChangeRequestId((requestId) =>
      options?.focusFirstChange ? requestId + 1 : 0
    )
    setDiffItem(item)
  }

  function openLightTab(tab: WorkbenchLightEditorTab): void {
    onPrimaryGroupTabShownLatest.current?.()
    setDiffItem(null)
    setActiveDebugTabId(null)
    setLightTab(tab)
  }

  const openDebugTab = useCallback((rawUrl: string): void => {
    const url = rawUrl.trim()
    if (!url) return

    onPrimaryGroupTabShownLatest.current?.()
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
  }, [debugTabsRef, onPrimaryGroupTabShownLatest])

  const selectDebugTab = useCallback(
    (id: string): void => {
      onPrimaryGroupTabShownLatest.current?.()
      setDiffItem(null)
      setLightTab(null)
      setActiveDebugTabId(id)
    },
    [onPrimaryGroupTabShownLatest]
  )

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
  /** Agent 进了站点：打开（或切到）这个会话的浏览器标签。 */
  const openAgentBrowserTab = useCallback((sessionId: string): void => {
    const normalizedSessionId = sessionId.trim()
    if (!normalizedSessionId) return

    setAgentBrowserTabSessionId(normalizedSessionId)
    setDiffItem(null)
    setLightTab(null)
    setActiveDebugTabId(`${WorkbenchAgentBrowserTabPrefix}${normalizedSessionId}`)
  }, [])
  const selectAgentBrowserTab = useCallback((): void => {
    if (!agentBrowserTabSessionId) return

    onPrimaryGroupTabShownLatest.current?.()
    setDiffItem(null)
    setLightTab(null)
    setActiveDebugTabId(`${WorkbenchAgentBrowserTabPrefix}${agentBrowserTabSessionId}`)
  }, [agentBrowserTabSessionId, onPrimaryGroupTabShownLatest])
  /** 会话的浏览器离站（或换了会话）：收起标签；给了会话就只收那个会话的。 */
  const closeAgentBrowserTab = useCallback((expectedSessionId?: string): void => {
    setAgentBrowserTabSessionId((sessionId) => {
      if (expectedSessionId && sessionId !== expectedSessionId) return sessionId
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
    diffFocusFirstChangeRequestId,
    goToLocation,
    goBack: () => goThroughHistory('back'),
    goForward: () => goThroughHistory('forward'),
    recordNavigationPoint,
    indentation,
    setIndentation,
    indentationRequest,
    requestIndentationChange,
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
    closeDiff: () => {
      setDiffItem(null)
      setDiffFocusFirstChangeRequestId(0)
    },
    closeLightTab: () => setLightTab(null),
    /** 左边那组要显示文件了（标签从右边那组挪了过来）：把盖在那组编辑器上的标签让开。 */
    uncoverPrimaryGroup,
  }
}
