import { useEffect, useState } from 'react'

import type {
  WorkbenchHistoryRestoreResult,
  WorkbenchHistoryWindowState,
} from '@shared/workbenchHistoryWindow'
import { normalizeWorkbenchTextEol } from '@shared/workbenchTextFormat'

import {
  isWorkbenchFileEditable,
  type WorkbenchEditorEditMode,
} from '../models/editor/workbenchEditorEditMode'
import { useLatest } from '../support/genericHooks'
import type { WorkbenchOpenEditorTab } from '../types/workbenchTypes'

/** The editor remains the only writer, even when another tab is now selected. */
export function useWorkbenchHistoryWindowOwner(options: {
  projectRoot: string | null
  openTabs: readonly WorkbenchOpenEditorTab[]
  editModes: ReadonlyMap<string, WorkbenchEditorEditMode>
  getOpenTab: (path: string) => WorkbenchOpenEditorTab | undefined
  restore: (content: string, path: string) => void
}): void {
  const bridge = window.velarosWorkbenchHistoryWindow
  const latest = useLatest(options)
  const [binding, setBinding] = useState<WorkbenchHistoryWindowState | null>(null)

  useEffect(() => {
    if (!bridge) return undefined
    const removeOpened = bridge.onOpened(setBinding)
    const removeRestore = bridge.onRestoreRequested((request) => {
      const current = latest.current
      const tab = current.getOpenTab(request.path)
      let result: WorkbenchHistoryRestoreResult
      if (current.projectRoot !== request.projectRoot) result = { ok: false, reason: 'unavailable' }
      else if (!tab) result = { ok: false, reason: 'closed' }
      else if (!isWorkbenchFileEditable(tab.file, current.editModes.get(tab.path)))
        result = { ok: false, reason: 'read-only' }
      else if (tab.content !== request.expectedContent) result = { ok: false, reason: 'stale' }
      else {
        current.restore(normalizeWorkbenchTextEol(request.content), request.path)
        result = { ok: true }
      }
      void bridge.resolveRestore({ requestId: request.requestId, result }).catch(console.warn)
    })
    return () => {
      removeOpened()
      removeRestore()
      void bridge.synchronize(null).catch(console.warn)
    }
  }, [bridge, latest])

  useEffect(() => {
    if (!bridge || !binding) return undefined
    if (binding.projectRoot !== options.projectRoot) {
      void bridge.synchronize(null).catch(console.warn)
      return undefined
    }
    const tab = options.openTabs.find((item) => item.path === binding.path)
    const synchronize = (): void => {
      void bridge
        .synchronize({
          id: binding.id,
          currentContent: tab?.content ?? null,
          editable: !!tab && isWorkbenchFileEditable(tab.file, options.editModes.get(tab.path)),
        })
        .catch(console.warn)
    }
    // Keep live comparisons current without serializing the entire draft on every key.
    if (!tab) {
      synchronize()
      return undefined
    }
    const timer = setTimeout(synchronize, 120)
    return () => clearTimeout(timer)
  }, [binding, bridge, options.editModes, options.openTabs, options.projectRoot])
}
