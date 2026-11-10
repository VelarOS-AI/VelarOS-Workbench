import { useEffect, useState } from 'react'

import { Result } from '@velaros-ai/velaros/core/result'

import type { WorkbenchUpdateState } from '@shared/workbenchUpdate'

export function useWorkbenchUpdate(): Result<WorkbenchUpdateState> | null {
  const [state, setState] = useState<Result<WorkbenchUpdateState> | null>(null)

  useEffect(() => {
    let active = true
    const apply = (next: WorkbenchUpdateState): void => {
      if (!active) return
      setState((current) =>
        current?.ok && next.revision < current.data.revision ? current : Result.ok(next)
      )
    }
    const unsubscribe = window.velarosWorkbenchUpdate.onChanged(apply)
    void window.velarosWorkbenchUpdate.getState().then(apply, (error: unknown) => {
      if (!active) return
      setState((current) => current?.ok ? current : Result.fail<WorkbenchUpdateState>(error))
    })
    return () => {
      active = false
      unsubscribe()
    }
  }, [])

  return state
}
