import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { workbenchHost } from '@renderer/host/WorkbenchHost'
import type { WorkbenchOpenFileSnapshot } from '@renderer/models/project/workbenchProjectContextIndex'
import type { WorkbenchProject } from '@renderer/models/project/workbenchProjects'
import { fileLanguage } from '@renderer/models/shared/workbenchUtils'

import { AppError } from '@velaros-ai/velaros/core/error'
import { Result } from '@velaros-ai/velaros/core/result'

import {
  type WorkbenchIndexProjectResult,
  type WorkbenchProjectIndexProgress,
} from '@shared/contracts/workbench'

import { useStableWorkbenchMessageTranslate } from '../runtime/useStableWorkbenchMessaging'
import { useLatest, useMonotonicAsyncRequest } from '../support/genericHooks'

interface UseWorkbenchProjectIndexControllerOptions {
  activeProject: Nullable<WorkbenchProject>
  enabled: boolean
}

/** 项目基础索引：打开项目时扫一遍浅层文件，编辑器补全与项目类型判断用它。 */
export function useWorkbenchProjectIndexController({
  activeProject,
  enabled,
}: UseWorkbenchProjectIndexControllerOptions) {
  const { messageLatest, tLatest } = useStableWorkbenchMessageTranslate()
  const [projectIndexResult, setProjectIndexResult] =
    useState<Nullable<WorkbenchIndexProjectResult>>(null)
  const [isIndexingProject, setIsIndexingProject] = useState(false)
  const [projectIndexProgress, setProjectIndexProgress] =
    useState<Nullable<WorkbenchProjectIndexProgress>>(null)
  const abortRef = useRef<AbortController>(null)
  const { completeIfActive, abandonInFlightRequests, start, isActive } = useMonotonicAsyncRequest()
  const activeProjectRef = useLatest(activeProject)

  const indexedFileSnapshots = useMemo<WorkbenchOpenFileSnapshot[]>(
    () =>
      projectIndexResult?.files.map((file) => ({
        path: file.path,
        content: file.content,
        language: fileLanguage(file.path),
      })) ?? [],
    [projectIndexResult]
  )

  const resetProjectIndex = useCallback((): void => {
    abandonInFlightRequests()
    abortRef.current?.abort()
    setProjectIndexResult(null)
    setIsIndexingProject(false)
    setProjectIndexProgress(null)
  }, [abandonInFlightRequests])

  const refreshProjectIndex = useCallback(async (): Promise<void> => {
    if (!enabled || !activeProject) {
      resetProjectIndex()
      return
    }

    const owningProjectId = activeProject.id
    const owningProjectRoot = activeProject.rootPath

    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller
    const generation = start()
    setIsIndexingProject(true)
    setProjectIndexProgress(null)

    try {
      const result = Result.unwrap(
        await workbenchHost.kernel.project.indexWorkbenchProject(
          {
            projectRoot: owningProjectRoot,
            maxDepth: 4,
            maxFiles: 120,
            maxFileBytes: 160_000,
            maxCharsPerFile: 24_000,
          },
          {
            signal: controller.signal,
            onProgress: (progress) => {
              if (isActive(generation) && activeProjectRef.current?.id === owningProjectId)
                setProjectIndexProgress(progress)
            },
          }
        )
      )

      if (!isActive(generation) || activeProjectRef.current?.id !== owningProjectId) return

      setProjectIndexResult(result)
    } catch (error) {
      const appError = AppError.from(error)
      if (!isActive(generation) || activeProjectRef.current?.id !== owningProjectId) return

      setProjectIndexResult(null)
      messageLatest.current.warning({
        title: tLatest.current('workbench.indexProjectFailed'),
        description: appError.message,
      })
    } finally {
      completeIfActive(generation, () => setIsIndexingProject(false))
    }
  }, [
    activeProject?.id,
    activeProject?.rootPath,
    activeProjectRef,
    completeIfActive,
    enabled,
    isActive,
    messageLatest,
    resetProjectIndex,
    start,
    tLatest,
  ])

  useEffect(() => {
    if (!enabled || !activeProject) {
      resetProjectIndex()
      return
    }

    // The window can restore its tree and tabs before background indexing starts.
    const handle = window.requestIdleCallback(() => void refreshProjectIndex(), { timeout: 1_000 })
    return () => {
      window.cancelIdleCallback(handle)
      abortRef.current?.abort()
      abandonInFlightRequests()
    }
  }, [abandonInFlightRequests, activeProject?.id, enabled, refreshProjectIndex, resetProjectIndex])

  return {
    projectIndexResult,
    indexedFileSnapshots,
    isIndexingProject,
    projectIndexProgress,
    refreshProjectIndex,
    resetProjectIndex,
  }
}
