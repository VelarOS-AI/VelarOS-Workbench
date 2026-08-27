import { useEffect, useState } from 'react'

import type { WorkbenchUpdateState } from '@shared/workbenchUpdate'

const InitialState: WorkbenchUpdateState = {
  revision: 0,
  phase: 'idle',
  currentVersion: '',
  automaticDownloads: true,
}

export function useWorkbenchUpdate(): WorkbenchUpdateState {
  const [state, setState] = useState(InitialState)

  useEffect(() => {
    let active = true
    const apply = (next: WorkbenchUpdateState): void => {
      if (!active) return
      setState((current) => (next.revision >= current.revision ? next : current))
    }
    const unsubscribe = window.velarosWorkbenchUpdate.onChanged(apply)
    void window.velarosWorkbenchUpdate.getState().then(apply)
    return () => {
      active = false
      unsubscribe()
    }
  }, [])

  return state
}
