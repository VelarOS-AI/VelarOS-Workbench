import { useCallback, useEffect, useState } from 'react'

import { Result } from '@velaros-ai/velaros/core/result'

import type { WorkbenchProductAnalyticsState } from '@shared/workbenchProductAnalytics'

export function useWorkbenchProductAnalytics(): {
  readonly state: Result<WorkbenchProductAnalyticsState> | null
  readonly setEnabled: (enabled: boolean) => Promise<void>
  readonly resolveNotice: (decision: 'allowed' | 'declined') => Promise<void>
  readonly openDetails: () => void
} {
  const [state, setState] = useState<Result<WorkbenchProductAnalyticsState> | null>(null)
  const applyState = useCallback((next: WorkbenchProductAnalyticsState): void => {
    setState((current) =>
      current?.ok && next.revision < current.data.revision ? current : Result.ok(next)
    )
  }, [])

  useEffect(() => {
    let active = true
    const apply = (next: WorkbenchProductAnalyticsState): void => {
      if (!active) return
      applyState(next)
    }
    const unsubscribe = window.velarosWorkbenchProductAnalytics.onChanged(apply)
    void window.velarosWorkbenchProductAnalytics.getState().then(apply, (error: unknown) => {
      if (!active) return
      // 实时状态已经到达时，旧初读的失败不能抹掉它。
      setState((current) =>
        current?.ok ? current : Result.fail<WorkbenchProductAnalyticsState>(error)
      )
    })
    return () => {
      active = false
      unsubscribe()
    }
  }, [applyState])

  return {
    state,
    setEnabled: async (enabled) => {
      applyState(await window.velarosWorkbenchProductAnalytics.setEnabled(enabled))
    },
    resolveNotice: async (decision) => {
      applyState(await window.velarosWorkbenchProductAnalytics.resolveNotice(decision))
    },
    openDetails: () => {
      void window.velarosWorkbenchProductAnalytics.openDetails()
    },
  }
}
