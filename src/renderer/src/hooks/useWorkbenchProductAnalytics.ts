import { useEffect, useState } from 'react'

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
  readonly setEnabled: (enabled: boolean) => void
  readonly resolveNotice: (decision: 'allowed' | 'declined') => Promise<void>
  readonly openDetails: () => void
} {
  const [state, setState] = useState(InitialState)

  useEffect(() => {
    let active = true
    const apply = (next: WorkbenchProductAnalyticsState): void => {
      if (!active) return
      setState((current) => (next.revision >= current.revision ? next : current))
    }
    const unsubscribe = window.velarosWorkbenchProductAnalytics.onChanged(apply)
    void window.velarosWorkbenchProductAnalytics.getState().then(apply)
    return () => {
      active = false
      unsubscribe()
    }
  }, [])

  return {
    enabled: state.enabled,
    noticeRequired: state.noticeRequired,
    noticeResolved: state.noticeResolved,
    setEnabled: (enabled) => {
      setState((current) => ({ ...current, enabled }))
      void window.velarosWorkbenchProductAnalytics.setEnabled(enabled).then(setState)
    },
    resolveNotice: async (decision) => {
      setState(await window.velarosWorkbenchProductAnalytics.resolveNotice(decision))
    },
    openDetails: () => {
      void window.velarosWorkbenchProductAnalytics.openDetails()
    },
  }
}
