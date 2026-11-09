import { useEffect } from 'react'
import type { WorkbenchEditorGroupsLayout } from '@renderer/models/editor/workbenchEditorGroups'
import {
  type PersistedWorkbenchEditorCursor,
  saveWorkbenchProjectSessionSnapshot,
} from '@renderer/models/project/workbenchProjectSessionModel'

import { useLatest, useTimerScope } from '../support/genericHooks'

import type { WorkbenchEditorCursorSnapshot } from './useWorkbenchEditorNavigationState'

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
  cursorPosition: WorkbenchEditorCursorSnapshot
  cursorByPathRef: React.MutableRefObject<Record<string, PersistedWorkbenchEditorCursor>>
}

export function useWorkbenchProjectSessionPersistence({
  enabled = true,
  projectId,
  expandedPaths,
  selectedEntryPath,
  editorLayout,
  selectedFilePath,
  cursorPosition,
  cursorByPathRef,
}: UseWorkbenchProjectSessionPersistenceOptions): void {
  const timers = useTimerScope('useWorkbenchProjectSessionPersistence')
  const snapshotRef = useLatest({
    enabled,
    projectId,
    expandedPaths,
    selectedEntryPath,
    editorLayout,
  })

  useEffect(() => {
    if (!enabled || !selectedFilePath) return

    cursorByPathRef.current[selectedFilePath] = {
      line: cursorPosition.line,
      column: cursorPosition.column,
    }
  }, [cursorByPathRef, cursorPosition.column, cursorPosition.line, enabled, selectedFilePath])

  useEffect(() => {
    if (!enabled || !projectId) return undefined

    const lease = timers.after(
      SAVE_DEBOUNCE_MS,
      () => {
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

    return () => {
      lease.cancel()
    }
  }, [
    expandedPaths,
    enabled,
    editorLayout,
    projectId,
    selectedEntryPath,
    cursorByPathRef,
    cursorPosition.column,
    cursorPosition.line,
    snapshotRef,
    timers,
  ])
}
