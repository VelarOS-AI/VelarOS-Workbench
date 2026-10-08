import { useCallback, useEffect, useRef, useState } from 'react'
import { workbenchHost } from '@renderer/host/WorkbenchHost'

import { AppError } from '@velaros-ai/core'
import { Result } from '@velaros-ai/core/result'

import { type SystemWorkspaceGitLineStatsSnapshot } from '@shared/contracts/system'

/** 什么时候拉取由调用方决定（见 useWorkbenchGitState 的刷新时机）；这里只管拉取与代际守卫。 */
export interface UseWorkspaceGitLineStatsOptions {
  enabled?: boolean
  refreshOnMount?: boolean
}

interface UseWorkspaceGitLineStatsResult {
  snapshot: Nullable<SystemWorkspaceGitLineStatsSnapshot>
  isLoading: boolean
  error: Nullable<string>
  refresh: () => Promise<void>
}

export function useWorkspaceGitLineStats(
  workspaceRoot: Nullable<string>,
  options: UseWorkspaceGitLineStatsOptions = {}
): UseWorkspaceGitLineStatsResult {
  const { enabled = true, refreshOnMount = true } = options
  const [snapshot, setSnapshot] =
    useState<Nullable<SystemWorkspaceGitLineStatsSnapshot>>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<Nullable<string>>(null)
  const generationRef = useRef(0)

  const refresh = useCallback(
    async (): Promise<void> => {
      if (!enabled || !workspaceRoot) return
      const generation = ++generationRef.current
      setIsLoading(true)
      setError(null)
      try {
        const next = Result.unwrap(
          await workbenchHost.kernel.workspace.getWorkspaceGitLineStats(workspaceRoot)
        )
        if (generation === generationRef.current) setSnapshot(next)
      } catch (loadError) {
        if (generation !== generationRef.current) return
        setSnapshot(null)
        setError(AppError.getMessage(loadError))
      } finally {
        if (generation === generationRef.current) setIsLoading(false)
      }
    },
    [enabled, workspaceRoot]
  )

  useEffect(() => {
    if (!enabled || !workspaceRoot) {
      generationRef.current += 1
      setSnapshot(null)
      setError(null)
      setIsLoading(false)
      return
    }
    if (refreshOnMount) void refresh()
  }, [enabled, refresh, refreshOnMount, workspaceRoot])

  return { snapshot, isLoading, error, refresh }
}
