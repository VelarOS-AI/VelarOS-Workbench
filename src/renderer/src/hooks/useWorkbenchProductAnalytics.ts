import { useCallback, useEffect, useState } from 'react'

import type { WorkbenchProductAnalyticsState } from '@shared/workbenchProductAnalytics'

const InitialState: WorkbenchProductAnalyticsState = {
  revision: 0,
  enabled: true,
  noticeRequired: false,
  noticeResolved: false,
  consentDecision: 'unresolved',
  consentReceiptRecorded: false,
}

export function useWorkbenchProductAnalytics(): {
  readonly enabled: boolean
  readonly noticeRequired: boolean
  readonly noticeResolved: boolean
  readonly setEnabled: (enabled: boolean) => Promise<void>
  readonly resolveNotice: (decision: 'allowed' | 'declined') => Promise<void>
  readonly openDetails: () => void
} {
  const [state, setState] = useState(InitialState)
  const applyState = useCallback((next: WorkbenchProductAnalyticsState): void => {
    setState((current) => (next.revision >= current.revision ? next : current))
  }, [])

  useEffect(() => {
    let active = true
    const apply = (next: WorkbenchProductAnalyticsState): void => {
      if (!active) return
      applyState(next)
    }
    const unsubscribe = window.velarosWorkbenchProductAnalytics.onChanged(apply)
    void window.velarosWorkbenchProductAnalytics.getState().then(apply)
    return () => {
      active = false
      unsubscribe()
    }
  }, [applyState])

  return {
    enabled: state.enabled,
    noticeRequired: state.noticeRequired,
    noticeResolved: state.noticeResolved,
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
