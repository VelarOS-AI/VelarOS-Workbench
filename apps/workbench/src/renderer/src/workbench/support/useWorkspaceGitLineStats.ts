import { useCallback, useEffect, useRef, useState } from 'react'

import { AppError } from '@velaros/core'
import { Result } from '@velaros/core/result'
import type { SystemWorkspaceGitLineStatsSnapshot } from '@velaros/core/types'
import { workbenchHost } from '@velaros/workbench/host'

export type WorkspaceGitLineStatsRefreshReason =
  | 'mount'
  | 'manual'
  | 'files-changed'
  | 'workspace-bound'
  | 'git-action'

export interface WorkspaceGitLineStatsRefreshRequest {
  reason?: WorkspaceGitLineStatsRefreshReason
  force?: boolean
}

export interface UseWorkspaceGitLineStatsOptions {
  enabled?: boolean
  refreshOnMount?: boolean
  watchFileChanges?: boolean
}

interface UseWorkspaceGitLineStatsResult {
  snapshot: Nullable<SystemWorkspaceGitLineStatsSnapshot>
  isLoading: boolean
  error: Nullable<string>
  refresh: (options?: WorkspaceGitLineStatsRefreshRequest) => Promise<void>
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
    async (_request?: WorkspaceGitLineStatsRefreshRequest): Promise<void> => {
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
    if (refreshOnMount) void refresh({ reason: 'mount' })
  }, [enabled, refresh, refreshOnMount, workspaceRoot])

  return { snapshot, isLoading, error, refresh }
}
