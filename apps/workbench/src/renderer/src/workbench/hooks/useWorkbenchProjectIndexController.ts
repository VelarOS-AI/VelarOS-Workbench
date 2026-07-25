import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { Log, toOptional } from '@velaros/core'
import { AppError } from '@velaros/core/error'
import { Result } from '@velaros/core/result'
import type {
  WorkbenchIndexProjectResult,
  WorkbenchProjectAiIndexStatus,
} from '@velaros/core/types'
import { workbenchHost } from '@velaros/workbench/host'
import type { WorkbenchMessageKey } from '@velaros/workbench/i18n'
import type { WorkbenchOpenFileSnapshot } from '@velaros/workbench/models/project/workbenchProjectContextIndex'
import { getWorkbenchProjectAiIndexNotice } from '@velaros/workbench/models/project/workbenchProjectIndexNotice'
import type { WorkbenchProject } from '@velaros/workbench/models/project/workbenchProjects'
import { fileLanguage } from '@velaros/workbench/models/shared/workbenchUtils'

import { useStableWorkbenchMessageTranslate } from '../runtime/useStableWorkbenchMessaging'
import { useLatest, useMonotonicAsyncRequest } from '../support/genericHooks'

const log = Log.tag('workbench-project-index-controller')

function normalizeProjectRoot(root: LooseOptional<string>): Nullable<string> {
  const normalized = root?.trim().replace(/\\/g, '/').replace(/\/+$/, '') ?? ''
  return normalized ? normalized : null
}

interface UseWorkbenchProjectIndexControllerOptions {
  activeProject: Nullable<WorkbenchProject>
  enabled: boolean
}

export function useWorkbenchProjectIndexController({
  activeProject,
  enabled,
}: UseWorkbenchProjectIndexControllerOptions) {
  const { messageLatest, tLatest } = useStableWorkbenchMessageTranslate()
  const [projectIndexResult, setProjectIndexResult] =
    useState<Nullable<WorkbenchIndexProjectResult>>(null)
  const [projectAiIndexStatus, setProjectAiIndexStatus] =
    useState<Nullable<WorkbenchProjectAiIndexStatus>>(null)
  const [isIndexingProject, setIsIndexingProject] = useState(false)
  const [isStartingProjectAiIndex, setIsStartingProjectAiIndex] = useState(false)
  const { completeIfActive, abandonInFlightRequests, start, isActive } = useMonotonicAsyncRequest()
  const activeProjectRef = useLatest(activeProject)
  const announcedProjectAiIndexNoticeKeysRef = useRef(new Set<string>())

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
    setProjectIndexResult(null)
    setProjectAiIndexStatus(null)
    setIsIndexingProject(false)
    setIsStartingProjectAiIndex(false)
  }, [abandonInFlightRequests])

  const notifyProjectAiIndexNotice = useCallback(
    (status: WorkbenchProjectAiIndexStatus): void => {
      const notice = getWorkbenchProjectAiIndexNotice(status)
      if (!notice) return

      const announced = announcedProjectAiIndexNoticeKeysRef.current
      if (announced.has(notice.key)) return

      announced.add(notice.key)
      const notify =
        notice.severity === 'error' ? messageLatest.current.error : messageLatest.current.warning
      notify({
        title: tLatest.current(notice.titleKey as WorkbenchMessageKey),
        description: toOptional(notice.description),
      })
    },
    [messageLatest, tLatest]
  )

  const applyProjectAiIndexStatus = useCallback(
    (status: WorkbenchProjectAiIndexStatus): void => {
      setProjectAiIndexStatus(status)
      notifyProjectAiIndexNotice(status)
    },
    [notifyProjectAiIndexNotice]
  )

  const refreshProjectAiIndexStatus = useCallback(async (): Promise<void> => {
    if (!enabled) {
      setProjectAiIndexStatus(null)
      return
    }

    const owningProject = activeProjectRef.current
    if (!owningProject) {
      setProjectAiIndexStatus(null)
      return
    }

    try {
      const result = Result.unwrap(
        await workbenchHost.kernel.project.getWorkbenchProjectAiIndexStatus({
          projectRoot: owningProject.rootPath,
        })
      )

      if (activeProjectRef.current?.id !== owningProject.id) return

      applyProjectAiIndexStatus(result)
    } catch (error) {
      log.debug('刷新项目 AI 索引状态失败，清空当前状态', {
        projectId: owningProject.id,
        rootPath: owningProject.rootPath,
        error: String(error),
      })
      if (activeProjectRef.current?.id === owningProject.id) {
        setProjectAiIndexStatus(null)
      }
    }
  }, [activeProjectRef, applyProjectAiIndexStatus, enabled])

  const refreshProjectIndex = useCallback(async (): Promise<void> => {
    if (!enabled || !activeProject) {
      resetProjectIndex()
      return
    }

    const owningProjectId = activeProject.id
    const owningProjectRoot = activeProject.rootPath

    const generation = start()
    setIsIndexingProject(true)

    try {
      const result = Result.unwrap(
        await workbenchHost.kernel.project.indexWorkbenchProject({
          projectRoot: owningProjectRoot,
          maxDepth: 4,
          maxFiles: 120,
          maxFileBytes: 160_000,
          maxCharsPerFile: 24_000,
        })
      )

      if (!isActive(generation) || activeProjectRef.current?.id !== owningProjectId) return

      setProjectIndexResult(result)
      void refreshProjectAiIndexStatus()
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
    refreshProjectAiIndexStatus,
    resetProjectIndex,
    start,
    tLatest,
  ])

  const startProjectAiIndex = useCallback(
    async (force = true, forceCodeGraph = false): Promise<void> => {
      if (!enabled) return

      const owningProject = activeProjectRef.current
      if (!owningProject) return

      setIsStartingProjectAiIndex(true)
      setProjectAiIndexStatus((current) =>
        current
          ? {
              ...current,
              status: 'indexing',
              phase: 'scanning-project',
              startedAt: Date.now(),
              updatedAt: Date.now(),
              error: null,
            }
          : current
      )

      try {
        const result = Result.unwrap(
          await workbenchHost.kernel.project.startWorkbenchProjectAiIndex({
            projectRoot: owningProject.rootPath,
            maxDepth: 4,
            maxFiles: 120,
            maxFileBytes: 160_000,
            maxCharsPerFile: 24_000,
            force,
            forceCodeGraph,
          })
        )

        if (activeProjectRef.current?.id !== owningProject.id) return

        if (!result.scheduled) {
          setProjectIndexResult(result.projectIndex)
        }
        applyProjectAiIndexStatus(result.status)
      } catch (error) {
        const appError = AppError.from(error)
        if (activeProjectRef.current?.id !== owningProject.id) return

        messageLatest.current.error({
          title: tLatest.current('workbench.aiIndexStartFailed'),
          description: appError.message,
        })
        void refreshProjectAiIndexStatus()
      } finally {
        if (activeProjectRef.current?.id === owningProject.id) {
          setIsStartingProjectAiIndex(false)
        }
      }
    },
    [
      activeProjectRef,
      applyProjectAiIndexStatus,
      enabled,
      messageLatest,
      refreshProjectAiIndexStatus,
      tLatest,
    ]
  )

  useEffect(() => {
    if (!enabled || !activeProject) {
      resetProjectIndex()
      return
    }

    void refreshProjectIndex()
  }, [activeProject?.id, enabled, refreshProjectIndex, resetProjectIndex])

  useEffect(() => {
    if (!enabled) return

    return workbenchHost.kernel.project.onWorkbenchProjectAiIndexStatusChanged((event) => {
      const currentProject = activeProjectRef.current
      if (
        !currentProject ||
        normalizeProjectRoot(currentProject.rootPath) !==
          normalizeProjectRoot(event.status.projectRoot)
      )
        return

      applyProjectAiIndexStatus(event.status)
    })
  }, [activeProjectRef, applyProjectAiIndexStatus, enabled])

  return {
    projectIndexResult,
    projectAiIndexStatus,
    indexedFileSnapshots,
    isIndexingProject,
    isStartingProjectAiIndex,
    refreshProjectIndex,
    refreshProjectAiIndexStatus,
    startProjectAiIndex,
    resetProjectIndex,
  }
}
