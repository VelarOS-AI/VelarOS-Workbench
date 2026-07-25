import { useEffect, useState } from 'react'

import { AppError } from '@velaros/core/error'
import { Result } from '@velaros/core/result'
import type { WorkbenchSearchEntriesResult } from '@velaros/core/types'
import { workbenchHost } from '@velaros/workbench/host'
import type { WorkbenchProject } from '@velaros/workbench/models/project/workbenchProjects'

import { useStableWorkbenchMessageTranslate } from '../runtime/useStableWorkbenchMessaging'
import { useDebounceFn, useLatest, useMemoizedFn, useMonotonicAsyncRequest } from '../support/genericHooks'
interface UseWorkbenchSearchControllerOptions {
  activeProject: Nullable<WorkbenchProject>
}

export function useWorkbenchSearchController({
  activeProject,
}: UseWorkbenchSearchControllerOptions) {
  const { messageLatest, tLatest } = useStableWorkbenchMessageTranslate()
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResult, setSearchResult] = useState<Nullable<WorkbenchSearchEntriesResult>>(null)
  const [isSearchingEntries, setIsSearchingEntries] = useState(false)

  const { abandonInFlightRequests, completeIfActive, isActive, start } = useMonotonicAsyncRequest()

  const activeProjectRef = useLatest(activeProject)

  const normalizedSearchQuery = searchQuery.trim()

  const executeSearch = useMemoizedFn(() => {
    const project = activeProject
    const query = normalizedSearchQuery

    if (!project || !query) {
      setIsSearchingEntries(false)
      return
    }

    const generation = start()
    const owningProjectId = project.id

    void (async () => {
      try {
        const result = Result.unwrap(
          await workbenchHost.kernel.project.searchWorkbenchEntries({
            projectRoot: project.rootPath,
            query,
            limit: 60,
            maxDepth: 8,
          })
        )

        if (!isActive(generation) || activeProjectRef.current?.id !== owningProjectId) return

        setSearchResult(result)
      } catch (error) {
        const appError = AppError.from(error)
        if (!isActive(generation) || activeProjectRef.current?.id !== owningProjectId) return

        setSearchResult(null)
        messageLatest.current.error({
          title: tLatest.current('workbench.searchFailed'),
          description: appError.message,
        })
      } finally {
        completeIfActive(generation, () => setIsSearchingEntries(false))
      }
    })()
  })

  const { run: scheduleSearch, cancel } = useDebounceFn(executeSearch, { wait: 180 })

  useEffect(() => {
    cancel()
    abandonInFlightRequests()

    if (!activeProject || !normalizedSearchQuery) {
      setSearchResult(null)
      setIsSearchingEntries(false)
      return undefined
    }

    setIsSearchingEntries(true)
    scheduleSearch()

    return () => {
      cancel()
    }
  }, [abandonInFlightRequests, activeProject?.id, cancel, normalizedSearchQuery, scheduleSearch])

  function resetSearch(): void {
    abandonInFlightRequests()
    cancel()
    setSearchQuery('')
    setSearchResult(null)
    setIsSearchingEntries(false)
  }

  return {
    searchQuery,
    normalizedSearchQuery,
    searchResult,
    searchActive: normalizedSearchQuery.length > 0,
    isSearchingEntries,
    setSearchQuery,
    resetSearch,
  }
}
