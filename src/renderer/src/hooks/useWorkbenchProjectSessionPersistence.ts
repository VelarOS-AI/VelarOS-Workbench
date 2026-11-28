import { useCallback, useEffect, useRef } from 'react'
import type { WorkbenchEditorCursorStore } from '@renderer/models/editor/workbenchEditorCursorStore'
import type { WorkbenchEditorGroupsLayout } from '@renderer/models/editor/workbenchEditorGroups'
import {
  type PersistedWorkbenchEditorCursor,
  saveWorkbenchProjectSessionSnapshot,
} from '@renderer/models/project/workbenchProjectSessionModel'

import type { TimerLease } from '@velaros-ai/velaros/core/utils/TimerScope'

import { useLatest, useTimerScope } from '../support/genericHooks'

const SAVE_DEBOUNCE_MS = 450

interface UseWorkbenchProjectSessionPersistenceOptions {
  enabled?: boolean
  projectId: Nullable<string>
  expandedPaths: ReadonlySet<string>
  selectedEntryPath: Nullable<string>
  /** 编辑区的标签布局：变了就存。 */
  editorLayout: WorkbenchEditorGroupsLayout
  /** 当前文件：光标位置记在它名下。 */
  selectedFilePath: Nullable<string>
  cursorStore: WorkbenchEditorCursorStore
  cursorByPathRef: React.MutableRefObject<Record<string, PersistedWorkbenchEditorCursor>>
}

export function useWorkbenchProjectSessionPersistence({
  enabled = true,
  projectId,
  expandedPaths,
  selectedEntryPath,
  editorLayout,
  selectedFilePath,
  cursorStore,
  cursorByPathRef,
}: UseWorkbenchProjectSessionPersistenceOptions): void {
  const timers = useTimerScope('useWorkbenchProjectSessionPersistence')
  const pendingSave = useRef<Nullable<TimerLease>>(null)
  const snapshotRef = useLatest({
    enabled,
    projectId,
    expandedPaths,
    selectedEntryPath,
    editorLayout,
  })

  const scheduleSave = useCallback(() => {
    pendingSave.current?.cancel()
    pendingSave.current = null
    const { enabled, projectId } = snapshotRef.current
    if (!enabled || !projectId) return
    pendingSave.current = timers.after(
      SAVE_DEBOUNCE_MS,
      () => {
        pendingSave.current = null
        const snapshot = snapshotRef.current
        if (!snapshot.enabled || snapshot.projectId !== projectId) return

        saveWorkbenchProjectSessionSnapshot(projectId, {
          expandedPaths: snapshot.expandedPaths,
          selectedEntryPath: snapshot.selectedEntryPath,
          editorLayout: snapshot.editorLayout,
          cursorByPath: cursorByPathRef.current,
        })
      },
      { label: 'workbench.session.persist' }
    )
  }, [cursorByPathRef, snapshotRef, timers])

  useEffect(() => {
    scheduleSave()
  }, [editorLayout, enabled, expandedPaths, projectId, scheduleSave, selectedEntryPath])

  useEffect(() => {
    if (!enabled || !selectedFilePath) return undefined
    return cursorStore.subscribe(() => {
      const { line, column } = cursorStore.getSnapshot()
      const saved = cursorByPathRef.current[selectedFilePath]
      if (saved?.line === line && saved.column === column) return
      cursorByPathRef.current[selectedFilePath] = { line, column }
      scheduleSave()
    })
  }, [cursorByPathRef, cursorStore, enabled, scheduleSave, selectedFilePath])
}
