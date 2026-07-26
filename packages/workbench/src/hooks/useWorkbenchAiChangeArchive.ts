import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { isEmpty, isFalse,Log, toNullable } from '@velaros-ai/core'
import { Result } from '@velaros-ai/core/result'

import type { WorkbenchChatSessionGroup, WorkbenchChatSessionSnapshot } from '../composition'
import type { ChatMessage, SystemFileChangePreviewResult } from '../contracts/index'
import { workbenchHost } from '../host'
import { useWorkbenchI18n } from '../i18n'
import {
  buildWorkbenchAiChangeArchive,
  findWorkbenchAiChangeArchiveEntry,
  getWorkbenchAiChangeArchiveRoundId,
  getWorkbenchAiChangeSnapshotRequestKey,
  listWorkbenchAiChangeArchiveRounds,
  type WorkbenchAiChangeArchiveEntry,
  type WorkbenchAiChangeArchiveSelectionTarget,
} from '../models/chat/workbenchAiChangeArchive'

const WORKBENCH_CHAT_HISTORY_LOAD_CHUNK = 40

export interface WorkbenchAiChangeArchiveSnapshot {
  entryId: string
  beforeContent: string
  afterContent: string
  beforeExists: boolean
  afterExists: boolean
}

export type WorkbenchAiChangeArchiveApplyMode = 'before' | 'after'

export interface WorkbenchAiChangeArchivePendingApply {
  entryId: string
  mode: WorkbenchAiChangeArchiveApplyMode
}

interface UseWorkbenchAiChangeArchiveOptions {
  active: boolean
  projectRoot: LooseOptional<string>
  sessions: readonly WorkbenchChatSessionSnapshot[]
  sessionGroups: readonly WorkbenchChatSessionGroup[]
  isPathDirty: (path: string) => boolean
  onFilesChanged: () => Promise<void>
  notify?: (notification: {
    tone: 'error' | 'success' | 'warning'
    title: string
    description?: string
  }) => void
}

export interface WorkbenchAiChangeArchiveState {
  archive: ReturnType<typeof buildWorkbenchAiChangeArchive>
  expandedRoundIds: ReadonlySet<string>
  historyLoading: boolean
  pendingApply: Nullable<WorkbenchAiChangeArchivePendingApply>
  selectedEntry: Nullable<WorkbenchAiChangeArchiveEntry>
  selectedSnapshot: Nullable<WorkbenchAiChangeArchiveSnapshot>
  selectedSnapshotError: Nullable<string>
  applyNext: (entry: WorkbenchAiChangeArchiveEntry) => Promise<void>
  closeSelection: () => void
  getNextApplyMode: (entry: WorkbenchAiChangeArchiveEntry) => WorkbenchAiChangeArchiveApplyMode
  selectEntry: (entry: WorkbenchAiChangeArchiveEntry) => void
  selectLinkedEntry: (target: WorkbenchAiChangeArchiveSelectionTarget) => void
  toggleRound: (id: string) => void
}

function getPreviewRoot(preview: SystemFileChangePreviewResult): string {
  return (preview.rootPath ?? '').trim().replaceAll('\\', '/').replace(/\/+$/u, '')
}

function getNormalizedRoot(root: LooseOptional<string>): string {
  return (root ?? '').trim().replaceAll('\\', '/').replace(/\/+$/u, '')
}

function useLatestValue<T>(value: T): { current: T } {
  const ref = useRef(value)
  ref.current = value
  return ref
}

async function loadOlderSessionMessages(
  session: WorkbenchChatSessionSnapshot
): Promise<ChatMessage[]> {
  let beforeIndex = session.messagePaging?.loadedFromIndex ?? 0
  let olderMessages: ChatMessage[] = []

  while (beforeIndex > 0) {
    const page = Result.unwrap(
      await workbenchHost.kernel.sessions.loadOlderMessages({
        sessionId: session.id,
        branchId: session.activeBranchId,
        beforeIndex,
        count: WORKBENCH_CHAT_HISTORY_LOAD_CHUNK,
      })
    )
    olderMessages = [...page.messages, ...olderMessages]
    beforeIndex = page.loadedFromIndex
    if (!page.hasMore) break
  }

  return olderMessages
}

async function loadSnapshotRefPreview(
  ref: WorkbenchAiChangeArchiveEntry['snapshotRefs'][number]
): Promise<SystemFileChangePreviewResult> {
  if (ref.preview) return ref.preview
  return Result.unwrap(
    await workbenchHost.kernel.workspace.getFileChangePreview(ref.sessionId, ref.changeId, ref.path)
  )
}

function toggleSetValue(current: ReadonlySet<string>, id: string): ReadonlySet<string> {
  const next = new Set(current)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  return next
}

function inferAppliedMode(entry: WorkbenchAiChangeArchiveEntry): WorkbenchAiChangeArchiveApplyMode {
  return !isEmpty(entry.snapshotRefs) &&
    entry.snapshotRefs.every((ref) => ref.preview?.rolledBack === true)
    ? 'before'
    : 'after'
}

export function useWorkbenchAiChangeArchive({
  active,
  projectRoot,
  sessions,
  sessionGroups,
  isPathDirty,
  onFilesChanged,
  notify,
}: UseWorkbenchAiChangeArchiveOptions): WorkbenchAiChangeArchiveState {
  const { t } = useWorkbenchI18n()
  const tLatest = useLatestValue(t)
  const notifyLatest = useLatestValue(notify)
  const folders = useMemo(
    () =>
      sessionGroups.map((group) => ({
        id: group.folderId,
        title: group.title,
        updatedAt: group.updatedAt,
        archivedAt: group.archivedAt,
        surfaceScope: group.surfaceScope,
        memberSessionIds: group.memberSessionIds,
      })),
    [sessionGroups]
  )
  const [olderMessagesBySession, setOlderMessagesBySession] = useState<
    ReadonlyMap<string, readonly ChatMessage[]>
  >(() => new Map())
  const [historyLoading, setHistoryLoading] = useState(false)
  const [expandedRoundIds, setExpandedRoundIds] = useState<ReadonlySet<string>>(() => new Set())
  const [selectedEntryId, setSelectedEntryId] = useState<Nullable<string>>(null)
  const [linkedSelection, setLinkedSelection] =
    useState<Nullable<WorkbenchAiChangeArchiveSelectionTarget>>(null)
  const [selectedSnapshot, setSelectedSnapshot] =
    useState<Nullable<WorkbenchAiChangeArchiveSnapshot>>(null)
  const [selectedSnapshotError, setSelectedSnapshotError] = useState<Nullable<string>>(null)
  const [appliedModeByEntryId, setAppliedModeByEntryId] = useState<
    ReadonlyMap<string, WorkbenchAiChangeArchiveApplyMode>
  >(() => new Map())
  const [pendingApply, setPendingApply] =
    useState<Nullable<WorkbenchAiChangeArchivePendingApply>>(null)
  const historyGenerationRef = useRef(0)
  const snapshotGenerationRef = useRef(0)
  const normalizedProjectRoot = getNormalizedRoot(projectRoot)
  const relevantSessionIds = useMemo(() => {
    const ids = new Set<string>()
    for (const folder of folders) {
      if (
        folder.surfaceScope?.surface !== 'workbench' ||
        getNormalizedRoot(folder.surfaceScope.projectRoot) !== normalizedProjectRoot
      )
        continue
      folder.memberSessionIds.forEach((id) => ids.add(id))
    }
    return ids
  }, [folders, normalizedProjectRoot])
  const relevantSessions = useMemo(
    () => sessions.filter((session) => relevantSessionIds.has(session.id)),
    [relevantSessionIds, sessions]
  )
  const pagingKey = useMemo(
    () =>
      relevantSessions
        .map((session) => `${session.id}:${session.messagePaging?.loadedFromIndex ?? 0}`)
        .sort()
        .join('|'),
    [relevantSessions]
  )

  useEffect(() => {
    setExpandedRoundIds(new Set())
    setSelectedEntryId(null)
    setLinkedSelection(null)
    setAppliedModeByEntryId(new Map())
  }, [normalizedProjectRoot])

  useEffect(() => {
    if (!active || !normalizedProjectRoot) return
    const generation = ++historyGenerationRef.current
    const pagedSessions = relevantSessions.filter(
      (session) => (session.messagePaging?.loadedFromIndex ?? 0) > 0
    )
    if (isEmpty(pagedSessions)) return

    setHistoryLoading(true)
    void Promise.all(
      pagedSessions.map(
        async (session) => [session.id, await loadOlderSessionMessages(session)] as const
      )
    )
      .then((entries) => {
        if (historyGenerationRef.current !== generation) return
        setOlderMessagesBySession((current) => {
          const next = new Map(current)
          entries.forEach(([sessionId, messages]) => next.set(sessionId, messages))
          return next
        })
      })
      .catch((error) => {
        if (historyGenerationRef.current !== generation) return
        Log.tag('workbench-ai-changes').warn('加载 AI 修改历史失败', error)
        notifyLatest.current?.({
          tone: 'error',
          title: tLatest.current('workbench.aiChangesHistoryLoadFailed'),
        })
      })
      .finally(() => {
        if (historyGenerationRef.current === generation) setHistoryLoading(false)
      })

    return () => {
      historyGenerationRef.current += 1
    }
  }, [active, normalizedProjectRoot, pagingKey])

  const archive = useMemo(
    () =>
      buildWorkbenchAiChangeArchive({
        folders,
        sessions: relevantSessions,
        projectRoot: normalizedProjectRoot,
        olderMessagesBySession,
      }),
    [folders, normalizedProjectRoot, olderMessagesBySession, relevantSessions]
  )
  const selectedEntry = useMemo(
    () =>
      toNullable(
        archive.conversations
          .flatMap((conversation) => conversation.rounds)
          .flatMap((round) => round.entries)
          .find((entry) => entry.id === selectedEntryId)
      ),
    [archive.conversations, selectedEntryId]
  )
  const getNextApplyMode = useCallback(
    (entry: WorkbenchAiChangeArchiveEntry): WorkbenchAiChangeArchiveApplyMode =>
      (appliedModeByEntryId.get(entry.id) ?? inferAppliedMode(entry)) === 'before'
        ? 'after'
        : 'before',
    [appliedModeByEntryId]
  )
  const selectedEntryLatest = useLatestValue(selectedEntry)
  const selectedSnapshotRequestKey = getWorkbenchAiChangeSnapshotRequestKey(selectedEntry)

  useEffect(() => {
    const latestRound = listWorkbenchAiChangeArchiveRounds(archive).at(-1)
    if (!latestRound) return
    setExpandedRoundIds((current) => (current.size === 0 ? new Set([latestRound.id]) : current))
  }, [archive])

  const selectEntry = useCallback((entry: WorkbenchAiChangeArchiveEntry): void => {
    setLinkedSelection(null)
    setSelectedEntryId(entry.id)
    setExpandedRoundIds(
      (current) =>
        new Set([
          ...current,
          getWorkbenchAiChangeArchiveRoundId(entry.conversationId, entry.roundId),
        ])
    )
  }, [])

  useEffect(() => {
    if (!linkedSelection) return
    const entry = findWorkbenchAiChangeArchiveEntry(archive, linkedSelection)
    if (!entry) return
    selectEntry(entry)
  }, [archive, linkedSelection, selectEntry])

  useEffect(() => {
    const generation = ++snapshotGenerationRef.current
    const currentEntry = selectedEntryLatest.current
    setSelectedSnapshot((current) => (current?.entryId === currentEntry?.id ? current : null))
    setSelectedSnapshotError(null)
    if (!currentEntry) return

    const firstRef = currentEntry.snapshotRefs[0]
    const lastRef = currentEntry.snapshotRefs.at(-1)
    if (!firstRef || !lastRef) {
      if (!currentEntry.workspaceDiff) {
        setSelectedSnapshotError(tLatest.current('workbench.aiChangesSnapshotUnavailable'))
      }
      return
    }

    const firstPreviewPromise = loadSnapshotRefPreview(firstRef)
    void Promise.all([
      firstPreviewPromise,
      firstRef.id === lastRef.id ? firstPreviewPromise : loadSnapshotRefPreview(lastRef),
    ])
      .then(([beforePreview, afterPreview]) => {
        if (snapshotGenerationRef.current !== generation) return
        const beforeRoot = getPreviewRoot(beforePreview)
        const afterRoot = getPreviewRoot(afterPreview)
        if (
          (beforeRoot && beforeRoot !== normalizedProjectRoot) ||
          (afterRoot && afterRoot !== normalizedProjectRoot)
        ) {
          setSelectedSnapshotError(tLatest.current('workbench.aiChangesSnapshotWrongProject'))
          return
        }
        setSelectedSnapshot({
          entryId: currentEntry.id,
          beforeContent: beforePreview.beforeContent,
          afterContent: afterPreview.afterContent,
          beforeExists: !beforePreview.created,
          afterExists: !afterPreview.deleted,
        })
      })
      .catch((error) => {
        if (snapshotGenerationRef.current !== generation) return
        Log.tag('workbench-ai-changes').warn('加载 AI 修改文件快照失败', error)
        setSelectedSnapshotError(tLatest.current('workbench.aiChangesSnapshotUnavailable'))
      })

    return () => {
      snapshotGenerationRef.current += 1
    }
  }, [normalizedProjectRoot, selectedSnapshotRequestKey])

  const applySnapshot = useCallback(
    async (
      entry: WorkbenchAiChangeArchiveEntry,
      mode: WorkbenchAiChangeArchiveApplyMode
    ): Promise<void> => {
      if (isPathDirty(entry.path)) {
        notifyLatest.current?.({
          tone: 'warning',
          title: tLatest.current('workbench.aiChangesUnsavedBlocked'),
        })
        return
      }

      if (
        isEmpty(entry.snapshotRefs) ||
        entry.snapshotRefs.some((ref) => isFalse(ref.preview?.revertAvailable))
      ) {
        notifyLatest.current?.({
          tone: 'warning',
          title: tLatest.current('workbench.aiChangesSnapshotUnavailable'),
        })
        return
      }

      setPendingApply({ entryId: entry.id, mode })
      try {
        const orderedRefs =
          mode === 'before' ? [...entry.snapshotRefs].reverse() : entry.snapshotRefs
        for (const ref of orderedRefs) {
          if (mode === 'before') {
            Result.unwrap(
              await workbenchHost.kernel.workspace.rollbackFileChange(
                ref.sessionId,
                ref.changeId,
                ref.path
              )
            )
          } else {
            Result.unwrap(
              await workbenchHost.kernel.workspace.restoreFileChange(
                ref.sessionId,
                ref.changeId,
                ref.path
              )
            )
          }
        }
        setAppliedModeByEntryId((current) => new Map(current).set(entry.id, mode))
        await onFilesChanged()
        notifyLatest.current?.({
          tone: 'success',
          title: tLatest.current(
            mode === 'before'
              ? 'workbench.aiChangesRollbackSucceeded'
              : 'workbench.aiChangesRestoreSucceeded'
          ),
        })
      } catch (error) {
        Log.tag('workbench-ai-changes').warn('应用 AI 修改文件存档失败', error)
        notifyLatest.current?.({
          tone: 'error',
          title: tLatest.current('workbench.aiChangesApplyFailed'),
        })
      } finally {
        setPendingApply(null)
      }
    },
    [isPathDirty, onFilesChanged]
  )

  const applyNext = useCallback(
    async (entry: WorkbenchAiChangeArchiveEntry): Promise<void> =>
      applySnapshot(entry, getNextApplyMode(entry)),
    [applySnapshot, getNextApplyMode]
  )

  return {
    archive,
    expandedRoundIds,
    historyLoading,
    pendingApply,
    selectedEntry,
    selectedSnapshot,
    selectedSnapshotError,
    applyNext,
    closeSelection: () => setSelectedEntryId(null),
    getNextApplyMode,
    selectEntry,
    selectLinkedEntry: (target) => setLinkedSelection(target),
    toggleRound: (id) => setExpandedRoundIds((current) => toggleSetValue(current, id)),
  }
}
