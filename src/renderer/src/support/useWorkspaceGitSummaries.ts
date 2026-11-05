import { useCallback, useEffect, useRef, useState } from 'react'
import { workbenchHost } from '@renderer/host/WorkbenchHost'

import { AppError } from '@velaros-ai/velaros/core'
import { Result } from '@velaros-ai/velaros/core/result'

import { type SystemWorkspaceGitSummary } from '@shared/contracts/system'

/** 什么时候拉取由调用方决定（见 useWorkbenchGitState 的刷新时机）；这里只管拉取与代际守卫。 */
export interface UseWorkspaceGitSummariesOptions {
  enabled?: boolean
  refreshOnMount?: boolean
}

interface UseWorkspaceGitSummariesResult {
  summaries: readonly SystemWorkspaceGitSummary[]
  activeSummary: Nullable<SystemWorkspaceGitSummary>
  isLoading: boolean
  error: Nullable<string>
  refresh: () => Promise<void>
}

export function useWorkspaceGitSummaries(
  workspaceRoot: Nullable<string>,
  options: UseWorkspaceGitSummariesOptions = {}
): UseWorkspaceGitSummariesResult {
  const { enabled = true, refreshOnMount = true } = options
  const [activeSummary, setActiveSummary] = useState<Nullable<SystemWorkspaceGitSummary>>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<Nullable<string>>(null)
  const generationRef = useRef(0)

  const refresh = useCallback(async (): Promise<void> => {
    if (!enabled || !workspaceRoot) return
    const generation = ++generationRef.current
    setIsLoading(true)
    setError(null)
    try {
      const summary = Result.unwrap(
        await workbenchHost.kernel.workspace.getWorkspaceGitSummary(workspaceRoot)
      )
      if (generation === generationRef.current) setActiveSummary(summary)
    } catch (loadError) {
      if (generation !== generationRef.current) return
      setActiveSummary(null)
      setError(AppError.getMessage(loadError))
    } finally {
      if (generation === generationRef.current) setIsLoading(false)
    }
  }, [enabled, workspaceRoot])

  useEffect(() => {
    if (!enabled || !workspaceRoot) {
      generationRef.current += 1
      setActiveSummary(null)
      setError(null)
      setIsLoading(false)
      return
    }
    if (refreshOnMount) void refresh()
  }, [enabled, refresh, refreshOnMount, workspaceRoot])

  return {
    summaries: activeSummary ? [activeSummary] : [],
    activeSummary,
    isLoading,
    error,
    refresh,
  }
}
