import { useCallback, useEffect, useRef, useState } from 'react'
import { workbenchHost } from '@renderer/host'

import { AppError } from '@velaros-ai/core'
import { Result } from '@velaros-ai/core/result'

import type { SystemWorkspaceGitSummary } from '@shared/contracts'

export type WorkspaceGitSummariesRefreshReason =
  | 'mount'
  | 'manual'
  | 'refresh-key'
  | 'files-changed'
  | 'session-workspace'
  | 'surface-open'
  | 'workspace-bound'
  | 'git-action'
  | 'agent-run-finished'

export interface WorkspaceGitSummariesRefreshRequest {
  reason?: WorkspaceGitSummariesRefreshReason
  force?: boolean
}

export interface UseWorkspaceGitSummariesOptions {
  enabled?: boolean
  refreshKey?: number | string
  refreshOnMount?: boolean
  watchFileChanges?: boolean
  watchSessionWorkspace?: boolean
}

interface UseWorkspaceGitSummariesResult {
  summaries: readonly SystemWorkspaceGitSummary[]
  activeSummary: Nullable<SystemWorkspaceGitSummary>
  isLoading: boolean
  error: Nullable<string>
  refresh: (options?: WorkspaceGitSummariesRefreshRequest) => Promise<void>
}

export function useWorkspaceGitSummaries(
  workspaceRoot: Nullable<string>,
  options: UseWorkspaceGitSummariesOptions = {}
): UseWorkspaceGitSummariesResult {
  const { enabled = true, refreshKey, refreshOnMount = true } = options
  const [activeSummary, setActiveSummary] =
    useState<Nullable<SystemWorkspaceGitSummary>>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<Nullable<string>>(null)
  const generationRef = useRef(0)

  const refresh = useCallback(
    async (_request?: WorkspaceGitSummariesRefreshRequest): Promise<void> => {
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
    },
    [enabled, workspaceRoot]
  )

  useEffect(() => {
    if (!enabled || !workspaceRoot) {
      generationRef.current += 1
      setActiveSummary(null)
      setError(null)
      setIsLoading(false)
      return
    }
    if (refreshOnMount) void refresh({ reason: 'mount' })
  }, [enabled, refresh, refreshKey, refreshOnMount, workspaceRoot])

  return {
    summaries: activeSummary ? [activeSummary] : [],
    activeSummary,
    isLoading,
    error,
    refresh,
  }
}
