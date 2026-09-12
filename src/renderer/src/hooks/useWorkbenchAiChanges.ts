import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type {
  WorkbenchChatRunChangesSummary,
  WorkbenchChatRunFileChangeStatus,
} from '@shared/workbenchGit'

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
const NoRounds: readonly WorkbenchAiChangeRound[] = Object.freeze([])

/** 编辑区里一个「AI 改动」对比标签：某一轮里某个文件的改动，只读。 */
export interface WorkbenchAiChangeTab {
  readonly id: string
  readonly roundKey: string
  readonly sessionId: string
  readonly recordId: string
  /** 这一轮最近一次采集的时刻：还在跑的一轮每采一次就跟着更新，对比内容据此重读。 */
  readonly capturedAt: number
  readonly path: string
  readonly status: WorkbenchChatRunFileChangeStatus
  readonly runNumber: number
  /** 一轮结束时自动打开的：下一轮自动打开时被替换掉；用户自己点开的留着。 */
  readonly auto: boolean
}

export interface WorkbenchAiChangesState {
  /** 当前会话的轮次，最近的在前（还在跑的那一轮排最前）。 */
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
  /** 项目下全部会话：面板只列当前会话的轮次，其余会话只用来判断编辑区里它们的标签还在不在。 */
  sessions: readonly WorkbenchChatSessionSnapshot[]
  currentSessionId: string
  /** 一轮结束后自动打开这一轮改过的文件。 */
  autoOpen: boolean
  /** 标签组要显示出来时调用：页面借此收起别的占据编辑区的视图（结构图等）。 */
  onShow: () => void
}

function tabId(sessionId: string, recordId: string, path: string): string {
  return `ai-change:${sessionId}\0${recordId}\0${path}`
}

/** 摘要里与面板显示有关的全部字段；会话快照每换一份，按它判断轮次要不要重算。 */
function summaryFingerprint(summary: WorkbenchChatRunChangesSummary): string {
  return `${summary.recordId}:${summary.capturedAt}:${summary.fileCount}:${summary.additions}:${summary.deletions}:${summary.error ?? ''}`
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
 * 按眼下的轮次校正标签：轮次被回溯、会话被移除（记录文件已经删了，留着只会显示读不到）的标签关掉；
 * 还在跑的一轮又采了一次，它的标签换上新的采集时刻，对比内容随之重读。
 */
function syncTabsWithRounds(
  state: TabGroupState,
  capturedAtByRound: ReadonlyMap<string, number>
): TabGroupState {
  const kept = withoutTabs(state, (tab) => !capturedAtByRound.has(tab.roundKey))
  const stale = (tab: WorkbenchAiChangeTab): boolean =>
    capturedAtByRound.get(tab.roundKey) !== tab.capturedAt
  if (!kept.tabs.some(stale)) return kept
  return {
    ...kept,
    tabs: kept.tabs.map((tab) =>
      stale(tab) ? { ...tab, capturedAt: capturedAtByRound.get(tab.roundKey) ?? tab.capturedAt } : tab
    ),
  }
}

/** 面板认得的轮次：属于哪个会话，见过哪些、其中哪些已经收尾。 */
interface KnownRounds {
  readonly sessionId: string
  readonly seen: Set<string>
  readonly settled: Set<string>
}

/**
 * 「AI 改动」的页面状态：左侧面板（当前会话每一轮一棵文件树）与编辑区的只读对比标签组。
 *
 * 面板跟着右侧的当前会话走，切会话就换成那个会话的轮次。轮次从会话的运行标记与「进行中」的实时摘要
 * 投影出来：一轮跑着的时候，第一次采到改动它就出现在面板里并展开，此后随写入实时刷新，编辑区不动；
 * 收尾、最终摘要挂上运行标记的那一刻（进行中 → 已完成）才按「自动打开」把它改过的文件摆进编辑区——
 * 与原来「一轮结束后自动打开」同一时机，一轮只一次。启动、切会话时已经在的轮次只记下，不自动打开。
 */
export function useWorkbenchAiChanges({
  projectRoot,
  sessions,
  currentSessionId,
  autoOpen,
  onShow,
}: UseWorkbenchAiChangesOptions): WorkbenchAiChangesState {
  // 会话快照随会话列表、运行起止这些项目级字段换新；轮次只随运行标记与改动摘要变，按它们的指纹重算。
  const sessionsRef = useLatest(sessions)
  const roundSourceKey = sessions
    .map((session) =>
      [
        session.id,
        session.messageRunMarkers
          .map((marker) =>
            marker.runChanges
              ? `${marker.messageId}:${summaryFingerprint(marker.runChanges)}`
              : marker.messageId
          )
          .join(','),
        session.liveRunChanges ? summaryFingerprint(session.liveRunChanges.summary) : '',
      ].join('\u0001')
    )
    .join('\u0002')
  const roundsBySession = useMemo(
    () =>
      new Map(
        sessionsRef.current.map((session) => [session.id, listWorkbenchAiChangeRounds(session)])
      ),
    // 指纹 roundSourceKey 覆盖了 sessions 里与轮次相关的全部字段。
    [roundSourceKey]
  )
  const rounds = roundsBySession.get(currentSessionId) ?? NoRounds
  const capturedAtByRound = useMemo(
    () =>
      new Map(
        [...roundsBySession.values()].flatMap((sessionRounds) =>
          sessionRounds.map((round) => [round.key, round.capturedAt] as const)
        )
      ),
    [roundsBySession]
  )
  const latestCapturedAt = useMemo(
    () => rounds.reduce((latest, round) => Math.max(latest, round.capturedAt), 0),
    [rounds]
  )
  const [expandedRoundKeys, setExpandedRoundKeys] = useState<ReadonlySet<string>>(() => new Set())
  const [revealRequest, setRevealRequest] = useState<{ roundKey: string; id: number } | null>(null)
  const [seenUntil, setSeenUntil] = useState<number | null>(null)
  const [tabGroup, setTabGroup] = useState<TabGroupState>(EmptyTabGroup)
  const knownRoundsRef = useRef<KnownRounds | null>(null)
  const roundsRef = useLatest(rounds)
  const latestCapturedAtRef = useLatest(latestCapturedAt)
  const onShowRef = useLatest(onShow)
  const openGenerationRef = useRef(0)

  // 换项目：面板与标签都是这个项目的，一并清空。
  useEffect(() => {
    knownRoundsRef.current = null
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
        target.recordId,
        round?.capturedAt ?? 0
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
          capturedAt: record.capturedAt,
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

  useEffect(() => {
    const known = knownRoundsRef.current
    // 第一次看到这个会话的轮次（启动、切会话）：只记下、展开最新一轮，不自动打开，也不算新改动。
    if (!known || known.sessionId !== currentSessionId) {
      knownRoundsRef.current = {
        sessionId: currentSessionId,
        seen: new Set(rounds.map((round) => round.key)),
        settled: new Set(rounds.filter((round) => !round.live).map((round) => round.key)),
      }
      setSeenUntil(latestCapturedAt)
      const newest = rounds[0]
      if (newest)
        setExpandedRoundKeys((current) =>
          current.has(newest.key) ? current : new Set([...current, newest.key])
        )
      return
    }
    const appeared = rounds.filter((round) => !known.seen.has(round.key))
    const settled = rounds.filter((round) => !round.live && !known.settled.has(round.key))
    for (const round of appeared) known.seen.add(round.key)
    for (const round of settled) known.settled.add(round.key)
    // 一轮收尾、最终摘要挂上了（包括来不及实时采集就收尾的短轮次）：按设置把它改过的文件摆进编辑区。
    const finished = settled.find((round) => !round.error && round.fileCount > 0)
    if (finished && autoOpen) {
      void openRound(finished, { auto: true })
      return
    }
    // 新出现的一轮（多半还在跑）只在面板里展开，不抢编辑区。
    if (appeared.length > 0)
      setExpandedRoundKeys((current) => new Set([...current, ...appeared.map((round) => round.key)]))
  }, [autoOpen, currentSessionId, latestCapturedAt, openRound, rounds])

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
                capturedAt: round.capturedAt,
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

  useEffect(() => {
    setTabGroup((current) => syncTabsWithRounds(current, capturedAtByRound))
  }, [capturedAtByRound])

  const toggleRound = useCallback((roundKey: string): void => {
    setExpandedRoundKeys((current) => {
      const next = new Set(current)
      if (next.has(roundKey)) next.delete(roundKey)
      else next.add(roundKey)
      return next
    })
  }, [])
  const markRoundsSeen = useCallback(
    (): void => setSeenUntil(latestCapturedAtRef.current),
    [latestCapturedAtRef]
  )
  const closeAllTabs = useCallback((): void => setTabGroup(EmptyTabGroup), [])
  const deactivate = useCallback(
    (): void =>
      setTabGroup((current) => (current.shown ? { ...current, shown: false } : current)),
    []
  )

  const { tabs } = tabGroup
  const activeTab = tabs.find((tab) => tab.id === tabGroup.activeTabId) ?? null

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
