import { useEffect, useRef, useState } from 'react'
import { workbenchHost } from '@renderer/host/WorkbenchHost'
import {
  buildWorkbenchEditorAutosaveNoticeKey,
  clearWorkbenchEditorAutosaveFailure,
  isWorkbenchEditorTabAutosavable,
  pruneWorkbenchEditorAutosaveFailures,
  recordWorkbenchEditorAutosaveFailure,
  resolveNextWorkbenchEditorAutosaveAt,
  selectDueWorkbenchEditorAutosaveTabs,
  type WorkbenchEditorAutosaveFailures,
} from '@renderer/models/editor/workbenchEditorAutosave'
import type { WorkbenchEditorSaveResult } from '@renderer/models/editor/workbenchEditorSaving'
import { resolveWorkbenchTabTextFormat } from '@renderer/models/editor/workbenchEditorTextFormat'
import type { WorkbenchProject } from '@renderer/models/project/workbenchProjects'
import type { WorkbenchOpenEditorTab } from '@renderer/types/workbenchTypes'

import { isEmpty, Log } from '@velaros-ai/core'

import { useLatest, useMemoizedFn, useTimerScope } from '../support/genericHooks'

const log = Log.tag('workbench-editor-autosave')

interface UseWorkbenchEditorAutosaveParams {
  activeProject: Nullable<WorkbenchProject>
  isSavingFile: boolean
  /** 正在问用户要不要保存的标签：等用户回答，别抢在「不保存」之前把它写回去。 */
  heldPaths: ReadonlySet<string>
  openTabsByPath: Map<string, WorkbenchOpenEditorTab>
  saveEditorTab: (
    tab: WorkbenchOpenEditorTab,
    options?: { notify?: boolean; silent?: boolean }
  ) => Promise<WorkbenchEditorSaveResult>
  /** 某个文件自动保存失败：同一文件的同一种失败只通知一次。 */
  onAutosaveFailed: (path: string, message: string) => void
}

export interface WorkbenchEditorAutosave {
  /** 存不下的文件与原因（按路径）；存好、撤回或关掉标签后撤销。 */
  failures: WorkbenchEditorAutosaveFailures
  /** 这些标签的当前内容在页面卸载时不再同步写回（用户选了不保存）。 */
  skipExitFlush: (tabs: readonly WorkbenchOpenEditorTab[]) => void
}

/**
 * 项目编辑器挂载期间的自动保存：输入停顿后把每个改过的标签各自写回磁盘。
 *
 * 一个文件写不进去只按它自己的节奏退避重试，其它标签照常保存；失败原因留在返回的记录里，
 * 标签上据此标出来，关窗前的确认也据此列出存不下的文件。
 */
export function useWorkbenchEditorAutosave({
  activeProject,
  isSavingFile,
  heldPaths,
  openTabsByPath,
  saveEditorTab,
  onAutosaveFailed,
}: UseWorkbenchEditorAutosaveParams): WorkbenchEditorAutosave {
  const [failures, setFailures] = useState<WorkbenchEditorAutosaveFailures>(() => new Map())
  const failuresLatest = useLatest(failures)
  const heldPathsLatest = useLatest(heldPaths)
  const saveEditorTabLatest = useLatest(saveEditorTab)
  const onAutosaveFailedLatest = useLatest(onAutosaveFailed)
  const activeProjectLatest = useLatest(activeProject)
  const openTabsByPathLatest = useLatest(openTabsByPath)
  const notifiedFailureKeysRef = useRef(new Set<string>())
  const autosaveRunningRef = useRef(false)
  const exitFlushedTabKeysRef = useRef(new Set<string>())
  const timers = useTimerScope('useWorkbenchEditorAutosave')

  // 标签存好了、撤回了、关掉了或转成了外部冲突：失败记录与标签上的标记一并撤掉。
  useEffect(() => {
    setFailures((current) => pruneWorkbenchEditorAutosaveFailures(current, openTabsByPath))
  }, [openTabsByPath])

  const forgetNotifiedFailures = (path: string): void => {
    for (const key of notifiedFailureKeysRef.current) {
      if (key.startsWith(`${path}\u0000`)) notifiedFailureKeysRef.current.delete(key)
    }
  }

  const runAutosave = useMemoizedFn(async (): Promise<void> => {
    const project = activeProjectLatest.current
    if (!project || autosaveRunningRef.current) return

    const dueTabs = selectDueWorkbenchEditorAutosaveTabs(
      [...openTabsByPathLatest.current.values()].filter(
        (tab) => !heldPathsLatest.current.has(tab.path)
      ),
      failuresLatest.current,
      Date.now()
    )
    if (isEmpty(dueTabs)) return

    autosaveRunningRef.current = true
    try {
      const results = await Promise.all(
        dueTabs.map(async (tab) => ({
          path: tab.path,
          result: await saveEditorTabLatest.current(tab, { silent: true }),
        }))
      )
      if (activeProjectLatest.current?.id !== project.id) return

      const now = Date.now()
      setFailures((current) =>
        results.reduce<WorkbenchEditorAutosaveFailures>((next, { path, result }) => {
          if (result.status === 'saved') return clearWorkbenchEditorAutosaveFailure(next, path)
          if (result.status === 'failed')
            return recordWorkbenchEditorAutosaveFailure(next, path, result.error.message, now)
          return next
        }, current)
      )

      for (const { path, result } of results) {
        if (result.status === 'saved') {
          forgetNotifiedFailures(path)
          continue
        }
        if (result.status !== 'failed') continue

        log.warn('编辑器自动保存失败', { path, error: result.error.message })
        const noticeKey = buildWorkbenchEditorAutosaveNoticeKey(path, result.error.message)
        if (notifiedFailureKeysRef.current.has(noticeKey)) continue
        notifiedFailureKeysRef.current.add(noticeKey)
        onAutosaveFailedLatest.current(path, result.error.message)
      }
    } finally {
      autosaveRunningRef.current = false
    }
  })

  useEffect(() => {
    if (!activeProject || isSavingFile) return undefined

    const nextAt = resolveNextWorkbenchEditorAutosaveAt(
      [...openTabsByPath.values()].filter((tab) => !heldPaths.has(tab.path)),
      failures,
      Date.now()
    )
    if (nextAt === null) return undefined

    const lease = timers.after(nextAt - Date.now(), () => void runAutosave(), {
      label: 'workbench.editor.autosave',
    })
    return (): void => {
      lease.cancel()
    }
  }, [activeProject, failures, heldPaths, isSavingFile, openTabsByPath, runAutosave, timers])

  // 页面卸载（重新加载窗口）前把还能存的改动同步写回：关窗与退出另有确认，走不到这里还没存的改动。
  const flushDirtyTabsBeforeExit = useMemoizedFn((): void => {
    const project = activeProjectLatest.current
    if (!project) return

    for (const tab of openTabsByPathLatest.current.values()) {
      if (!isWorkbenchEditorTabAutosavable(tab)) {
        continue
      }

      const flushKey = `${project.rootPath}\0${tab.path}\0${tab.content}`
      if (exitFlushedTabKeysRef.current.has(flushKey)) {
        continue
      }
      exitFlushedTabKeysRef.current.add(flushKey)

      try {
        workbenchHost.kernel.project.saveWorkbenchFileSync({
          projectRoot: project.rootPath,
          path: tab.path,
          content: tab.content,
          ...resolveWorkbenchTabTextFormat(tab),
          expectedModifiedAt: tab.file.modifiedAt,
          expectedSize: tab.file.size,
        })
      } catch (error) {
        log.warn('页面卸载前同步保存标签失败', {
          projectRoot: project.rootPath,
          path: tab.path,
          error: String(error),
        })
      }
    }
  })

  useEffect(() => {
    window.addEventListener('beforeunload', flushDirtyTabsBeforeExit)
    window.addEventListener('pagehide', flushDirtyTabsBeforeExit)

    return (): void => {
      window.removeEventListener('beforeunload', flushDirtyTabsBeforeExit)
      window.removeEventListener('pagehide', flushDirtyTabsBeforeExit)
    }
  }, [flushDirtyTabsBeforeExit])

  /** 用户选了「不保存」的标签：页面卸载时也别再替它写回去。 */
  const skipExitFlush = useMemoizedFn((tabs: readonly WorkbenchOpenEditorTab[]): void => {
    const project = activeProjectLatest.current
    if (!project) return

    for (const tab of tabs) {
      exitFlushedTabKeysRef.current.add(`${project.rootPath}\0${tab.path}\0${tab.content}`)
    }
  })

  return { failures, skipExitFlush }
}
