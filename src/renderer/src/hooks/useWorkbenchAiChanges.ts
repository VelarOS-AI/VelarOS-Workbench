import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type { WorkbenchChatRunFileChangeStatus } from '@shared/workbenchGit'

import type { WorkbenchChatSessionSnapshot } from '../composition'
import {
  buildWorkbenchAiChangeTree,
  getWorkbenchAiChangeRoundKey,
  listWorkbenchAiChangeRounds,
  listWorkbenchAiChangeTreeFiles,
  type WorkbenchAiChangeRound,
} from '../models/chat/workbenchAiChangeRounds'
import { readWorkbenchRunChangeRecord } from '../runtime/workbenchRunChangeRecords'
import { useLatest } from '../support/genericHooks'

/** 一轮结束后自动打开的文件标签最多这么多个；其余的在左侧面板里点开。 */
const MaxAutoOpenedTabs = 8

/** 编辑区里一个「AI 改动」对比标签：某一轮里某个文件的改动，只读。 */
export interface WorkbenchAiChangeTab {
  readonly id: string
  readonly roundKey: string
  readonly sessionId: string
  readonly recordId: string
  readonly path: string
  readonly status: WorkbenchChatRunFileChangeStatus
  readonly runNumber: number
  /** 一轮结束时自动打开的：下一轮自动打开时被替换掉；用户自己点开的留着。 */
  readonly auto: boolean
}

export interface WorkbenchAiChangesState {
  readonly rounds: readonly WorkbenchAiChangeRound[]
  readonly expandedRoundKeys: ReadonlySet<string>
  /** 左侧面板要把哪一轮滚进视野（每次请求 +1）。 */
  readonly revealRequest: { roundKey: string; id: number } | null
  /** 有新的一轮改动还没在面板里看过：左侧图标上亮一个点。 */
  readonly hasUnseenRounds: boolean
  readonly tabs: readonly WorkbenchAiChangeTab[]
  readonly activeTab: WorkbenchAiChangeTab | null
  /** 编辑区此刻显示的是「AI 改动」标签组。 */
  readonly active: boolean
  toggleRound: (roundKey: string) => void
  markRoundsSeen: () => void
  openFile: (
    round: WorkbenchAiChangeRound,
    change: { path: string; status: WorkbenchChatRunFileChangeStatus }
  ) => void
  /** 打开一轮的文件（最多 {@link MaxAutoOpenedTabs} 个），并在左侧面板里展开这一轮。 */
  openRound: (target: { sessionId: string; recordId: string }, options?: { auto?: boolean }) => Promise<void>
  selectTab: (tabId: string) => void
  closeTab: (tabId: string) => void
  closeAllTabs: () => void
  /** 离开「AI 改动」标签组，回到普通编辑器（标签保留，下次点回来还在）。 */
  deactivate: () => void
}

interface UseWorkbenchAiChangesOptions {
  projectRoot: string | null
  sessions: readonly WorkbenchChatSessionSnapshot[]
  sessionTitles: ReadonlyMap<string, string>
  currentSessionId: string
  /** 一轮结束后自动打开这一轮改过的文件。 */
  autoOpen: boolean
  /** 标签组要显示出来时调用：页面借此收起别的占据编辑区的视图（结构图等）。 */
  onShow: () => void
}

function tabId(sessionId: string, recordId: string, path: string): string {
  return `ai-change:${sessionId}\0${recordId}\0${path}`
}

interface TabGroupState {
  readonly tabs: readonly WorkbenchAiChangeTab[]
  readonly activeTabId: string | null
  /** 标签组是否占着编辑区（有标签但用户切回了普通编辑器时为 false）。 */
  readonly shown: boolean
}

const EmptyTabGroup: TabGroupState = { tabs: [], activeTabId: null, shown: false }

/** 关掉一些标签后的标签组：当前标签没了就落到它右边那个（没有就左边），一个不剩就收起。 */
function withoutTabs(state: TabGroupState, removed: (tab: WorkbenchAiChangeTab) => boolean): TabGroupState {
  const next = state.tabs.filter((tab) => !removed(tab))
  if (next.length === state.tabs.length) return state
  if (next.length === 0) return EmptyTabGroup
  if (next.some((tab) => tab.id === state.activeTabId)) return { ...state, tabs: next }
  const index = state.tabs.findIndex((tab) => tab.id === state.activeTabId)
  const fallback = next[Math.min(Math.max(index, 0), next.length - 1)]
  return { ...state, tabs: next, activeTabId: fallback.id }
}

/**
 * 「AI 改动」的页面状态：左侧面板（每一轮一棵文件树）与编辑区的只读对比标签组。
 *
 * 轮次从会话的运行标记投影出来；一轮收尾、改动摘要挂上标记之后，这一轮第一次出现在列表里——当前会话
 * 的新一轮在这时自动打开它改过的文件。应用启动时已经在的轮次不自动打开。
 */
export function useWorkbenchAiChanges({
  projectRoot,
  sessions,
  sessionTitles,
  currentSessionId,
  autoOpen,
  onShow,
}: UseWorkbenchAiChangesOptions): WorkbenchAiChangesState {
  // 会话快照在流式输出时每个 token 都换一份；轮次只随运行标记与改动摘要变，按它们的指纹重算。
  const sessionsRef = useLatest(sessions)
  const roundSourceKey = sessions
    .map(
      (session) =>
        `${session.id}\u0001${sessionTitles.get(session.id) ?? ''}\u0001${session.messageRunMarkers
          .map((marker) =>
            marker.runChanges
              ? `${marker.messageId}:${marker.runChanges.recordId}:${marker.runChanges.fileCount}:${marker.runChanges.error ?? ''}`
              : marker.messageId
          )
          .join(',')}`
    )
    .join('\u0002')
  const rounds = useMemo(
    () =>
      listWorkbenchAiChangeRounds(
        sessionsRef.current.map((session) => ({
          id: session.id,
          title: sessionTitles.get(session.id) ?? '',
          messages: session.messages,
          messageRunMarkers: session.messageRunMarkers,
        }))
      ),
    // 指纹 roundSourceKey 覆盖了 sessions 里与轮次相关的全部字段。
    [roundSourceKey]
  )
  const [expandedRoundKeys, setExpandedRoundKeys] = useState<ReadonlySet<string>>(() => new Set())
  const [revealRequest, setRevealRequest] = useState<{ roundKey: string; id: number } | null>(null)
  const [seenUntil, setSeenUntil] = useState<number | null>(null)
  const [tabGroup, setTabGroup] = useState<TabGroupState>(EmptyTabGroup)
  const knownRoundKeysRef = useRef<Set<string> | null>(null)
  const roundsRef = useLatest(rounds)
  const onShowRef = useLatest(onShow)
  const openGenerationRef = useRef(0)

  // 换项目：面板与标签都是这个项目的，一并清空。
  useEffect(() => {
    knownRoundKeysRef.current = null
    setExpandedRoundKeys(new Set())
    setRevealRequest(null)
    setSeenUntil(null)
    setTabGroup(EmptyTabGroup)
  }, [projectRoot])

  const notifyShown = useCallback((): void => onShowRef.current(), [onShowRef])

  const expandRound = useCallback((roundKey: string): void => {
    setExpandedRoundKeys((current) =>
      current.has(roundKey) ? current : new Set([...current, roundKey])
    )
    setRevealRequest((current) => ({ roundKey, id: (current?.id ?? 0) + 1 }))
  }, [])

  const openRound = useCallback(
    async (
      target: { sessionId: string; recordId: string },
      options?: { auto?: boolean }
    ): Promise<void> => {
      if (!projectRoot) return
      const auto = options?.auto === true
      const roundKey = getWorkbenchAiChangeRoundKey(target.sessionId, target.recordId)
      const round = roundsRef.current.find((candidate) => candidate.key === roundKey)
      const generation = ++openGenerationRef.current
      const record = await readWorkbenchRunChangeRecord(
        projectRoot,
        target.sessionId,
        target.recordId
      )
      if (!record || generation !== openGenerationRef.current) return
      const files = listWorkbenchAiChangeTreeFiles(buildWorkbenchAiChangeTree(record.changes))
        .slice(0, MaxAutoOpenedTabs)
      if (files.length === 0) return
      const opened = files.map(
        (change): WorkbenchAiChangeTab => ({
          id: tabId(target.sessionId, target.recordId, change.path),
          roundKey,
          sessionId: target.sessionId,
          recordId: target.recordId,
          path: change.path,
          status: change.status,
          runNumber: round?.runNumber ?? 0,
          auto,
        })
      )
      setTabGroup((current) => {
        const openedIds = new Set(opened.map((tab) => tab.id))
        // 自动打开的一批替换上一批自动打开的；用户点开过的标签不动。
        const kept = current.tabs.filter((tab) => !openedIds.has(tab.id) && !(auto && tab.auto))
        return { tabs: [...kept, ...opened], activeTabId: opened[0].id, shown: true }
      })
      // 这一轮已经摆在编辑区里了，左侧图标不必再提示有新改动。
      if (round) setSeenUntil((current) => Math.max(current ?? 0, round.capturedAt))
      expandRound(roundKey)
      notifyShown()
    },
    [expandRound, notifyShown, projectRoot, roundsRef]
  )

  // 新的一轮出现在列表里：当前会话的就自动打开。第一次看到的那批（启动时已有的轮次）只记下不打开。
  useEffect(() => {
    const known = knownRoundKeysRef.current
    if (!known) {
      knownRoundKeysRef.current = new Set(rounds.map((round) => round.key))
      setSeenUntil(rounds[0]?.capturedAt ?? 0)
      if (rounds[0]) setExpandedRoundKeys(new Set([rounds[0].key]))
      return
    }
    const fresh = rounds.filter((round) => !known.has(round.key))
    for (const round of fresh) known.add(round.key)
    const newest = fresh.find(
      (round) => round.sessionId === currentSessionId && !round.error && round.fileCount > 0
    )
    if (newest && autoOpen) void openRound(newest, { auto: true })
    else if (newest) setExpandedRoundKeys((current) => new Set([...current, newest.key]))
  }, [autoOpen, currentSessionId, openRound, rounds])

  const openFile = useCallback(
    (
      round: WorkbenchAiChangeRound,
      change: { path: string; status: WorkbenchChatRunFileChangeStatus }
    ): void => {
      const id = tabId(round.sessionId, round.recordId, change.path)
      setTabGroup((current) => ({
        tabs: current.tabs.some((tab) => tab.id === id)
          ? current.tabs.map((tab) => (tab.id === id ? { ...tab, auto: false } : tab))
          : [
              ...current.tabs,
              {
                id,
                roundKey: round.key,
                sessionId: round.sessionId,
                recordId: round.recordId,
                path: change.path,
                status: change.status,
                runNumber: round.runNumber,
                auto: false,
              },
            ],
        activeTabId: id,
        shown: true,
      }))
      notifyShown()
    },
    [notifyShown]
  )

  const selectTab = useCallback(
    (id: string): void => {
      setTabGroup((current) =>
        current.tabs.some((tab) => tab.id === id)
          ? { ...current, activeTabId: id, shown: true }
          : current
      )
      notifyShown()
    },
    [notifyShown]
  )

  const closeTab = useCallback((id: string): void => {
    setTabGroup((current) => withoutTabs(current, (tab) => tab.id === id))
  }, [])

  // 轮次被回溯或会话被移除后，指向它的标签一并关掉（记录文件已经删了，留着只会显示读不到）。
  useEffect(() => {
    const roundKeys = new Set(rounds.map((round) => round.key))
    setTabGroup((current) => withoutTabs(current, (tab) => !roundKeys.has(tab.roundKey)))
  }, [rounds])

  const toggleRound = useCallback((roundKey: string): void => {
    setExpandedRoundKeys((current) => {
      const next = new Set(current)
      if (next.has(roundKey)) next.delete(roundKey)
      else next.add(roundKey)
      return next
    })
  }, [])
  const markRoundsSeen = useCallback(
    (): void => setSeenUntil(roundsRef.current[0]?.capturedAt ?? 0),
    [roundsRef]
  )
  const closeAllTabs = useCallback((): void => setTabGroup(EmptyTabGroup), [])
  const deactivate = useCallback(
    (): void =>
      setTabGroup((current) => (current.shown ? { ...current, shown: false } : current)),
    []
  )

  const { tabs } = tabGroup
  const activeTab = tabs.find((tab) => tab.id === tabGroup.activeTabId) ?? null
  const latestCapturedAt = rounds[0]?.capturedAt ?? 0

  return {
    rounds,
    expandedRoundKeys,
    revealRequest,
    hasUnseenRounds: seenUntil !== null && latestCapturedAt > seenUntil,
    tabs,
    activeTab,
    active: tabGroup.shown && !!activeTab,
    toggleRound,
    markRoundsSeen,
    openFile,
    openRound,
    selectTab,
    closeTab,
    closeAllTabs,
    deactivate,
  }
}
