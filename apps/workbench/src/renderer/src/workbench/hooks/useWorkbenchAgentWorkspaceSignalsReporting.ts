import { useEffect } from 'react'
import { workbenchHost } from '@workbench/host'

import { useDebounceFn, useMemoizedFn } from '../support/genericHooks'
import { WorkbenchAgentSignalsReportDebounceMs } from '../support/workspaceAgentSignals'

import type { WorkbenchEditorCursorSnapshot } from './useWorkbenchEditorNavigationState'

interface UseWorkbenchAgentWorkspaceSignalsReportingOptions {
  projectRoot?: string
  chatSessionId: Nullable<string>
  focusedRelativePath: Nullable<string>
  cursor: WorkbenchEditorCursorSnapshot
  debounceMs?: number
}

/**
 * 将工作台编辑器聚焦信息同步到主进程工作区智能体流水线，进程通信会防抖。
 */
export function useWorkbenchAgentWorkspaceSignalsReporting({
  projectRoot,
  chatSessionId,
  focusedRelativePath,
  cursor,
  debounceMs = WorkbenchAgentSignalsReportDebounceMs,
}: UseWorkbenchAgentWorkspaceSignalsReportingOptions): void {
  const flushReport = useMemoizedFn(() => {
    if (!projectRoot) return

    void workbenchHost.kernel.project.reportWorkbenchAgentWorkspaceSignals({
      projectRoot,
      chatSessionId,
      focusedRelativePath,
      selection: cursor.selection || undefined,
    })
  })

  const { run: scheduleReport, cancel } = useDebounceFn(flushReport, { wait: debounceMs })

  useEffect(() => {
    if (!projectRoot) {
      cancel()
      return undefined
    }

    scheduleReport()
    return cancel
  }, [
    cancel,
    projectRoot,
    scheduleReport,
    chatSessionId,
    focusedRelativePath,
    debounceMs,
    cursor.line,
    cursor.column,
    cursor.selection?.startLine,
    cursor.selection?.endLine,
    cursor.selection?.startColumn,
    cursor.selection?.endColumn,
  ])
}
