import { useEffect, useRef, useState } from 'react'
import {
  readWorkbenchRecentFiles,
  recordWorkbenchRecentFile,
  saveWorkbenchRecentFiles,
} from '@renderer/models/files/workbenchRecentFiles'

interface UseWorkbenchRecentFilesOptions {
  projectId: Nullable<string>
  /** 编辑器的当前文件：每切到一个文件就记一次。 */
  selectedFilePath: Nullable<string>
  /** 记录存到本机（独立窗口）；不存时只在这次会话里记。 */
  persist: boolean
}

interface RecentFilesState {
  projectId: Nullable<string>
  paths: readonly string[]
  /** 这次会话里记过新的：要写回本机。刚读出来的不用写。 */
  changed: boolean
}

function loadRecentFiles(projectId: Nullable<string>, persist: boolean): RecentFilesState {
  return {
    projectId,
    paths: projectId && persist ? readWorkbenchRecentFiles(projectId) : [],
    changed: false,
  }
}

/** 当前项目最近打开过的文件，最近的在前（含当前文件）。 */
export function useWorkbenchRecentFiles({
  projectId,
  selectedFilePath,
  persist,
}: UseWorkbenchRecentFilesOptions): readonly string[] {
  const [state, setState] = useState(() => loadRecentFiles(projectId, persist))
  // 换了项目：换成那个项目记下的（渲染时就换，免得这一轮的记录落到上一个项目头上）。
  if (state.projectId !== projectId) setState(loadRecentFiles(projectId, persist))

  // 只在当前文件变了时记：换项目的那一刻当前文件还是上一个项目的，不能算进新项目。
  const recordedPathRef = useRef<Nullable<string>>(null)
  useEffect(() => {
    if (!selectedFilePath) recordedPathRef.current = null
    if (!projectId || !selectedFilePath || recordedPathRef.current === selectedFilePath) return

    recordedPathRef.current = selectedFilePath
    setState((current) =>
      current.projectId === projectId
        ? {
            projectId,
            paths: recordWorkbenchRecentFile(current.paths, selectedFilePath),
            changed: true,
          }
        : current
    )
  }, [projectId, selectedFilePath])

  useEffect(() => {
    if (!persist || !state.changed || !state.projectId) return

    saveWorkbenchRecentFiles(state.projectId, state.paths)
  }, [persist, state])

  return state.projectId === projectId ? state.paths : []
}
