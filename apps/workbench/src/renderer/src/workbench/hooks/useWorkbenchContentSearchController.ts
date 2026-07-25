import { useEffect, useMemo, useState } from 'react'

import { AppError } from '@velaros-ai/core/error'
import { Result } from '@velaros-ai/core/result'
import { workbenchHost } from '@velaros-ai/workbench/host'
import {
  buildWorkbenchContentSearchMatches,
  mapWorkbenchContentSearchMatchResult,
  mergeWorkbenchContentSearchMatches,
  type WorkbenchContentSearchMatch,
} from '@velaros-ai/workbench/models/files/workbenchContentSearchModel'
import type { WorkbenchProject } from '@velaros-ai/workbench/models/project/workbenchProjects'
import type { WorkbenchOpenEditorTab } from '@velaros-ai/workbench/types/workbenchTypes'

import { useStableWorkbenchMessageTranslate } from '../runtime/useStableWorkbenchMessaging'
import { useDebounceFn, useLatest, useMemoizedFn, useMonotonicAsyncRequest } from '../support/genericHooks'

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
            maxDepth: 8,
          })
        )

        if (!isActive(generation) || activeProjectRef.current?.id !== owningProjectId) return

        const openPaths = new Set(openTabsRef.current.map((tab) => tab.path))
        setDiskMatches(
          result.matches.map((match) =>
            mapWorkbenchContentSearchMatchResult(match, {
              isOpen: openPaths.has(match.path),
            })
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
  }, [
    abandonInFlightRequests,
    activeProject?.id,
    cancel,
    enabled,
    normalizedQuery,
    scheduleSearch,
  ])

  return {
    contentSearchMatches: matches,
    isSearchingContent,
    contentSearchTruncated,
  }
}
