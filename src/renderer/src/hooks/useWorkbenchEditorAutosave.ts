import { useEffect, useRef } from 'react'
import { workbenchHost } from '@renderer/host'
import { isDirtyTab } from '@renderer/models/editor/workbenchEditorTabs'
import { resolveWorkbenchTabTextFormat } from '@renderer/models/editor/workbenchEditorTextFormat'
import type { WorkbenchProject } from '@renderer/models/project/workbenchProjects'
import type { WorkbenchOpenEditorTab } from '@renderer/types/workbenchTypes'

import { Log } from '@velaros-ai/core'

import { useDebounceFn, useLatest, useMemoizedFn } from '../support/genericHooks'

const AUTO_SAVE_DELAY_MS = 3000
const log = Log.tag('workbench-editor-autosave')

interface UseWorkbenchEditorAutosaveParams {
  activeProject: Nullable<WorkbenchProject>
  isSavingFile: boolean
  openTabsByPath: Map<string, WorkbenchOpenEditorTab>
  saveEditorTab: (
    tab: WorkbenchOpenEditorTab,
    options?: { notify?: boolean; silent?: boolean }
  ) => Promise<unknown>
}

/** 项目编辑器挂载期间，对第一个未截断且已修改的打开标签做防抖保存。 */
export function useWorkbenchEditorAutosave({
  activeProject,
  isSavingFile,
  openTabsByPath,
  saveEditorTab,
}: UseWorkbenchEditorAutosaveParams): void {
  const saveEditorTabLatest = useLatest(saveEditorTab)
  const activeProjectLatest = useLatest(activeProject)
  const openTabsByPathLatest = useLatest(openTabsByPath)
  const autoSaveTargetRef = useRef<WorkbenchOpenEditorTab>(null)
  const exitFlushedTabKeysRef = useRef(new Set<string>())

  const flushAutoSave = useMemoizedFn((): void => {
    const tab = autoSaveTargetRef.current
    if (!tab) return

    void saveEditorTabLatest.current(tab, { silent: true })
  })

  const { run: scheduleAutoSave, cancel: cancelAutoSave } = useDebounceFn(flushAutoSave, {
    wait: AUTO_SAVE_DELAY_MS,
  })

  const flushDirtyTabsBeforeExit = useMemoizedFn((): void => {
    cancelAutoSave()

    const project = activeProjectLatest.current
    if (!project) return

    for (const tab of openTabsByPathLatest.current.values()) {
      if (
        tab.file.truncated
        || tab.externalChange
        || tab.unencodableSaveError
        || !isDirtyTab(tab)
      ) {
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
        log.debug('窗口关闭前同步保存脏标签页失败，继续关闭流程', {
          projectRoot: project.rootPath,
          path: tab.path,
          error: String(error),
        })
      }
    }
  })

  useEffect(() => {
    cancelAutoSave()

    if (!activeProject || isSavingFile) return undefined

    // 有编码写不出的字符、上次被拒的标签不排队：改之前结果只会一样，也别挡住后面的标签。
    const dirtyTab = [...openTabsByPath.values()].find(
      (tab) =>
        !tab.file.truncated && !tab.externalChange && !tab.unencodableSaveError && isDirtyTab(tab)
    )
    if (!dirtyTab) return undefined

    autoSaveTargetRef.current = dirtyTab
    scheduleAutoSave()

    return (): void => cancelAutoSave()
  }, [activeProject, cancelAutoSave, isSavingFile, openTabsByPath, scheduleAutoSave])

  useEffect(() => {
    window.addEventListener('beforeunload', flushDirtyTabsBeforeExit)
    window.addEventListener('pagehide', flushDirtyTabsBeforeExit)

    return (): void => {
      window.removeEventListener('beforeunload', flushDirtyTabsBeforeExit)
      window.removeEventListener('pagehide', flushDirtyTabsBeforeExit)
    }
  }, [flushDirtyTabsBeforeExit])
}
