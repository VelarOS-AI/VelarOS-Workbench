import { useEffect, useMemo, useState } from 'react'
import { workbenchHost } from '@renderer/host/WorkbenchHost'
import {
  buildWorkbenchContentSearchMatches,
  mapWorkbenchContentSearchMatchResult,
  mergeWorkbenchContentSearchMatches,
  type WorkbenchContentSearchMatch,
} from '@renderer/models/files/workbenchContentSearchModel'
import type { WorkbenchProject } from '@renderer/models/project/workbenchProjects'
import type { WorkbenchOpenEditorTab } from '@renderer/types/workbenchTypes'

import { AppError } from '@velaros-ai/velaros/core/error'
import { Result } from '@velaros-ai/velaros/core/result'

import { useStableWorkbenchMessageTranslate } from '../runtime/useStableWorkbenchMessaging'
import {
  useDebounceFn,
  useLatest,
  useMemoizedFn,
  useMonotonicAsyncRequest,
} from '../support/genericHooks'

interface UseWorkbenchContentSearchControllerOptions {
  activeProject: Nullable<WorkbenchProject>
  openTabs: WorkbenchOpenEditorTab[]
  query: string
  enabled?: boolean
  limit?: number
}

export function useWorkbenchContentSearchController({
  activeProject,
  openTabs,
  query,
  enabled = true,
  limit = 80,
}: UseWorkbenchContentSearchControllerOptions) {
  const { messageLatest, tLatest } = useStableWorkbenchMessageTranslate()
  const normalizedQuery = query.trim()
  const [diskMatches, setDiskMatches] = useState<WorkbenchContentSearchMatch[]>([])
  const [isSearchingContent, setIsSearchingContent] = useState(false)
  const [contentSearchTruncated, setContentSearchTruncated] = useState(false)
  const activeProjectRef = useLatest(activeProject)
  const openTabsRef = useLatest(openTabs)
  const { abandonInFlightRequests, completeIfActive, isActive, start } = useMonotonicAsyncRequest()

  const openTabMatches = useMemo(
    () =>
      buildWorkbenchContentSearchMatches({
        indexedFiles: [],
        openTabs,
        query: normalizedQuery,
        limit,
      }),
    [limit, normalizedQuery, openTabs]
  )

  const matches = useMemo(
    () => mergeWorkbenchContentSearchMatches(openTabMatches, diskMatches, limit),
    [diskMatches, limit, openTabMatches]
  )

  const executeSearch = useMemoizedFn(() => {
    const project = activeProjectRef.current
    if (!project || !normalizedQuery) {
      setDiskMatches([])
      setContentSearchTruncated(false)
      setIsSearchingContent(false)
      return
    }

    const generation = start()
    const owningProjectId = project.id

    void (async () => {
      try {
        const result = Result.unwrap(
          await workbenchHost.kernel.project.searchWorkbenchContent({
            projectRoot: project.rootPath,
            query: normalizedQuery,
            limit,
            maxResultsPerFile: 3,
          })
        )

        if (!isActive(generation) || activeProjectRef.current?.id !== owningProjectId) return

        const openPaths = new Set(openTabsRef.current.map((tab) => tab.path))
        setDiskMatches(
          result.files.flatMap((file) =>
            file.matches.map((match) =>
              mapWorkbenchContentSearchMatchResult(
                { ...match, path: file.path },
                { isOpen: openPaths.has(file.path) }
              )
            )
          )
        )
        setContentSearchTruncated(result.truncated)
      } catch (error) {
        const appError = AppError.from(error)
        if (!isActive(generation) || activeProjectRef.current?.id !== owningProjectId) return

        setDiskMatches([])
        setContentSearchTruncated(false)
        messageLatest.current.error({
          title: tLatest.current('workbench.searchFailed'),
          description: appError.message,
        })
      } finally {
        completeIfActive(generation, () => setIsSearchingContent(false))
      }
    })()
  })

  const { run: scheduleSearch, cancel } = useDebounceFn(executeSearch, { wait: 180 })

  useEffect(() => {
    cancel()
    abandonInFlightRequests()

    if (!enabled || !activeProject || !normalizedQuery) {
      setDiskMatches([])
      setContentSearchTruncated(false)
      setIsSearchingContent(false)
      return undefined
    }

    setIsSearchingContent(true)
    scheduleSearch()

    return () => {
      cancel()
    }
  }, [abandonInFlightRequests, activeProject?.id, cancel, enabled, normalizedQuery, scheduleSearch])

  return {
    contentSearchMatches: matches,
    isSearchingContent,
    contentSearchTruncated,
  }
}
