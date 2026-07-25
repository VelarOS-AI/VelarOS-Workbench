import { useEffect, useMemo, useRef, useState } from 'react'

import { isEmpty,toNullable } from '@velaros-ai/core'
import type { ChatMessage } from '@velaros-ai/core/types'
import { extractMessageFileChangeDescriptors } from '@velaros-ai/core/utils/messageFileChanges'

import type { WorkbenchChatSessionSnapshot } from '../composition'
import {
  getWorkbenchGitChangeItemKey,
  isSameWorkbenchGitChangeItem,
  type WorkbenchGitChangeItem,
} from '../models/git/workbenchGitModel'

const SettledRunStatuses = new Set(['completed', 'failed', 'aborted'])

function useLatestValue<T>(value: T): { current: T } {
  const ref = useRef(value)
  ref.current = value
  return ref
}

interface UseWorkbenchChatChangePreviewOptions {
  activeDiffItem: Nullable<WorkbenchGitChangeItem>
  autoOpen?: boolean
  changeItems: WorkbenchGitChangeItem[]
  enabled: boolean
  onOpenDiff: (item: WorkbenchGitChangeItem) => void
  onRefreshWorkspace: () => Promise<void>
  onRefreshGit: () => Promise<void>
  session: WorkbenchChatSessionSnapshot
}

export interface WorkbenchChatChangePreviewState {
  active: boolean
  items: WorkbenchGitChangeItem[]
  runKey: Nullable<string>
}

function messageBelongsToCurrentRun(message: ChatMessage, runStartedAt: Nullable<number>): boolean {
  if (!runStartedAt) return false

  if (message.timestamp >= runStartedAt) return true

  return message.blocks.some(
    (block) =>
      block.type === 'tool-call' &&
      ((block.startedAt ?? 0) >= runStartedAt || (block.finishedAt ?? 0) >= runStartedAt)
  )
}

function matchesDescriptorPath(item: WorkbenchGitChangeItem, paths: ReadonlySet<string>): boolean {
  return paths.has(item.path) || (!!item.originalPath && paths.has(item.originalPath))
}

function getChangePathIdentity(item: WorkbenchGitChangeItem): string {
  return `${item.path}\0${item.originalPath ?? ''}`
}

function buildChangeBaselineMap(
  items: readonly WorkbenchGitChangeItem[]
): Map<string, WorkbenchGitChangeItem> {
  return new Map(items.map((item) => [getChangePathIdentity(item), item]))
}

function hasChangedSinceBaseline(
  item: WorkbenchGitChangeItem,
  baselineMap: ReadonlyMap<string, WorkbenchGitChangeItem>
): boolean {
  const baselineItem = baselineMap.get(getChangePathIdentity(item))
  if (!baselineItem) return true

  return getWorkbenchGitChangeItemKey(baselineItem) !== getWorkbenchGitChangeItemKey(item)
}

function pickPreviewItem(
  items: WorkbenchGitChangeItem[],
  orderedPaths: readonly string[]
): Nullable<WorkbenchGitChangeItem> {
  for (let index = orderedPaths.length - 1; index >= 0; index -= 1) {
    const path = orderedPaths[index]
    if (!path) continue

    const match = items.find((item) => item.path === path || item.originalPath === path)
    if (match) return match
  }

  return toNullable(items[0])
}

export function useWorkbenchChatChangePreview({
  activeDiffItem,
  autoOpen = true,
  changeItems,
  enabled,
  onOpenDiff,
  onRefreshWorkspace,
  onRefreshGit,
  session,
}: UseWorkbenchChatChangePreviewOptions): WorkbenchChatChangePreviewState {
  const activeDiffItemLatest = useLatestValue(activeDiffItem)
  const onOpenDiffLatest = useLatestValue(onOpenDiff)
  const onRefreshWorkspaceLatest = useLatestValue(onRefreshWorkspace)
  const onRefreshGitLatest = useLatestValue(onRefreshGit)
  const handledWorkspaceRefreshKeyRef = useRef<string>(null)
  const handledFinishedRunKeyRef = useRef<string>(null)
  const handledAutoOpenKeyRef = useRef<string>(null)
  const autoOpenedItemRef = useRef<{ itemKey: string; runKey: string }>(null)
  const suppressedAutoOpenRunKeyRef = useRef<string>(null)
  const [baselineItemsByRunKey, setBaselineItemsByRunKey] = useState<
    ReadonlyMap<string, WorkbenchGitChangeItem[]>
  >(() => new Map())
  const runStartedAt = session.runtime.lastRunStartedAt
  const runKey = session.kind === 'chat' && runStartedAt ? `${session.id}:${runStartedAt}` : null
  const baselineItems = runKey ? toNullable(baselineItemsByRunKey.get(runKey)) : null
  const baselineMap = useMemo(
    () => (baselineItems ? buildChangeBaselineMap(baselineItems) : null),
    [baselineItems]
  )
  const descriptors = useMemo(
    () =>
      session.kind === 'chat'
        ? session.messages
            .filter((message) => messageBelongsToCurrentRun(message, runStartedAt))
            .flatMap((message) => extractMessageFileChangeDescriptors(message))
        : [],
    [runStartedAt, session.kind, session.messages]
  )
  const orderedDescriptorPaths = useMemo(
    () => descriptors.map((descriptor) => descriptor.path),
    [descriptors]
  )
  const descriptorPathSet = useMemo(() => new Set(orderedDescriptorPaths), [orderedDescriptorPaths])
  const descriptorPathKey = useMemo(
    () => [...descriptorPathSet].sort((left, right) => left.localeCompare(right, 'en')).join('\n'),
    [descriptorPathSet]
  )
  const shouldUseFallbackChanges =
    enabled &&
    session.kind === 'chat' &&
    descriptorPathSet.size === 0 &&
    !!baselineMap &&
    session.workspaceVersion > 0 &&
    (session.runtime.status === 'running' || !!session.runtime.lastRunFinishedAt)
  const items = useMemo(() => {
    if (!enabled || session.kind !== 'chat') return []

    if (descriptorPathSet.size > 0)
      return changeItems.filter((item) => matchesDescriptorPath(item, descriptorPathSet))

    return shouldUseFallbackChanges && baselineMap
      ? changeItems.filter((item) => hasChangedSinceBaseline(item, baselineMap))
      : []
  }, [baselineMap, changeItems, descriptorPathSet, enabled, session.kind, shouldUseFallbackChanges])
  const itemKey = useMemo(() => items.map(getWorkbenchGitChangeItemKey).join('\n'), [items])
  const preferredItem = useMemo(
    () => pickPreviewItem(items, orderedDescriptorPaths),
    [items, orderedDescriptorPaths]
  )

  useEffect(() => {
    if (!enabled || session.kind !== 'chat' || session.runtime.status !== 'running' || !runKey)
      return

    setBaselineItemsByRunKey((current) => {
      if (current.has(runKey)) return current

      const next = new Map(current)
      next.set(runKey, changeItems)

      while (next.size > 6) {
        const oldestKey = next.keys().next().value
        if (!oldestKey) {
          break
        }
        next.delete(oldestKey)
      }

      return next
    })
  }, [changeItems, enabled, runKey, session.kind, session.runtime.status])

  useEffect(() => {
    if (!enabled || session.kind !== 'chat' || session.workspaceVersion <= 0) return

    const refreshKey = `${session.id}:${session.workspaceVersion}`
    if (handledWorkspaceRefreshKeyRef.current === refreshKey) return

    handledWorkspaceRefreshKeyRef.current = refreshKey
    void onRefreshWorkspaceLatest.current()
  }, [enabled, onRefreshWorkspaceLatest, session.id, session.kind, session.workspaceVersion])

  useEffect(() => {
    if (!enabled || session.kind !== 'chat' || !session.runtime.lastRunFinishedAt) return

    if (!SettledRunStatuses.has(session.runtime.status)) return

    const finishedRunKey = `${session.id}:${session.runtime.lastRunFinishedAt}`
    if (handledFinishedRunKeyRef.current === finishedRunKey) return

    handledFinishedRunKeyRef.current = finishedRunKey
    void onRefreshWorkspaceLatest.current()
    void onRefreshGitLatest.current()
  }, [
    enabled,
    onRefreshGitLatest,
    onRefreshWorkspaceLatest,
    session.id,
    session.kind,
    session.runtime.lastRunFinishedAt,
    session.runtime.status,
  ])

  useEffect(() => {
    if (!runKey || autoOpenedItemRef.current?.runKey !== runKey) return

    const activeItemKey = activeDiffItem ? getWorkbenchGitChangeItemKey(activeDiffItem) : null
    if (activeItemKey === autoOpenedItemRef.current.itemKey) return

    if (activeItemKey && items.some((item) => getWorkbenchGitChangeItemKey(item) === activeItemKey))
      return

    suppressedAutoOpenRunKeyRef.current = runKey
  }, [activeDiffItem, itemKey, items, runKey])

  useEffect(() => {
    if (!autoOpen || !enabled || session.kind !== 'chat' || !preferredItem) return

    if (runKey && suppressedAutoOpenRunKeyRef.current === runKey) return

    const autoOpenKey = [
      session.id,
      runStartedAt ?? 0,
      session.workspaceVersion,
      descriptorPathKey,
      itemKey,
    ].join(':')
    if (handledAutoOpenKeyRef.current === autoOpenKey) return

    handledAutoOpenKeyRef.current = autoOpenKey
    if (items.some((item) => isSameWorkbenchGitChangeItem(activeDiffItemLatest.current, item)))
      return

    onOpenDiffLatest.current(preferredItem)
    autoOpenedItemRef.current = {
      itemKey: getWorkbenchGitChangeItemKey(preferredItem),
      runKey: runKey ?? autoOpenKey,
    }
  }, [
    activeDiffItemLatest,
    autoOpen,
    descriptorPathKey,
    enabled,
    itemKey,
    items,
    onOpenDiffLatest,
    preferredItem,
    runStartedAt,
    runKey,
    session.id,
    session.kind,
    session.workspaceVersion,
  ])

  return {
    active: autoOpen && enabled && !isEmpty(items),
    items,
    runKey,
  }
}
