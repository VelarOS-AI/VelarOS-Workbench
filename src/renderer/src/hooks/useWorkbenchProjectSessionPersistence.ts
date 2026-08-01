import { useEffect, useMemo, useRef } from 'react'
import {
  type PersistedWorkbenchEditorCursor,
  saveWorkbenchProjectSessionSnapshot,
} from '@renderer/models/project/workbenchProjectSessionModel'
import type { WorkbenchOpenEditorTab } from '@renderer/types/workbenchTypes'

import { useLatest, useTimerScope } from '../support/genericHooks'

import type { WorkbenchEditorCursorSnapshot } from './useWorkbenchEditorNavigationState'

const SAVE_DEBOUNCE_MS = 450

interface UseWorkbenchProjectSessionPersistenceOptions {
  enabled?: boolean
  projectId: Nullable<string>
  expandedPaths: ReadonlySet<string>
  selectedEntryPath: Nullable<string>
  openTabs: readonly WorkbenchOpenEditorTab[]
  selectedFilePath: Nullable<string>
  cursorPosition: WorkbenchEditorCursorSnapshot
  cursorByPathRef?: React.MutableRefObject<Record<string, PersistedWorkbenchEditorCursor>>
}

export function useWorkbenchProjectSessionPersistence({
  enabled = true,
  projectId,
  expandedPaths,
  selectedEntryPath,
  openTabs,
  selectedFilePath,
  cursorPosition,
  cursorByPathRef: externalCursorByPathRef,
}: UseWorkbenchProjectSessionPersistenceOptions): void {
  const timers = useTimerScope('useWorkbenchProjectSessionPersistence')
  const internalCursorByPathRef = useRef<Record<string, PersistedWorkbenchEditorCursor>>({})
  const cursorByPathRef = externalCursorByPathRef ?? internalCursorByPathRef
  const snapshotRef = useLatest({
    projectId,
    expandedPaths,
    selectedEntryPath,
    openTabs,
    selectedFilePath,
    cursorPosition,
  })

  const expandedPathList = useMemo(
    () => [...expandedPaths].sort((left, right) => left.localeCompare(right)),
    [expandedPaths]
  )
  const openTabPaths = useMemo(() => openTabs.map((tab) => tab.path), [openTabs])

  useEffect(() => {
    if (!enabled || !selectedFilePath) return

    cursorByPathRef.current[selectedFilePath] = {
      line: cursorPosition.line,
      column: cursorPosition.column,
    }
  }, [cursorPosition.column, cursorPosition.line, enabled, selectedFilePath])

  useEffect(() => {
    if (!enabled || !projectId) return undefined

    const lease = timers.after(
      SAVE_DEBOUNCE_MS,
      () => {
        const snapshot = snapshotRef.current
        if (!snapshot.projectId) return

        saveWorkbenchProjectSessionSnapshot(snapshot.projectId, {
          expandedPaths: snapshot.expandedPaths,
          selectedEntryPath: snapshot.selectedEntryPath,
          openTabPaths: snapshot.openTabs.map((tab) => tab.path),
          selectedFilePath: snapshot.selectedFilePath,
          cursorByPath: cursorByPathRef.current,
        })
      },
      { label: 'workbench.session.persist' }
    )

    return () => {
      lease.cancel()
    }
  }, [
    expandedPathList,
    enabled,
    openTabPaths,
    projectId,
    selectedEntryPath,
    selectedFilePath,
    cursorPosition.column,
    cursorPosition.line,
    snapshotRef,
    timers,
  ])
}

export function flushWorkbenchProjectSessionPersistence(
  options: UseWorkbenchProjectSessionPersistenceOptions,
  cursorByPath: Record<string, PersistedWorkbenchEditorCursor>
): void {
  if (!options.projectId) return

  saveWorkbenchProjectSessionSnapshot(options.projectId, {
    expandedPaths: options.expandedPaths,
    selectedEntryPath: options.selectedEntryPath,
    openTabPaths: options.openTabs.map((tab) => tab.path),
    selectedFilePath: options.selectedFilePath,
    cursorByPath,
  })
}
