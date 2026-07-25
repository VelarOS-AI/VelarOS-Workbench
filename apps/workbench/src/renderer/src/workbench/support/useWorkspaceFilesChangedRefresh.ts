import { type MutableRefObject, useEffect } from 'react'

import type { SystemWorkspaceFilesChangedEvent } from '@velaros/core/types'

import { useMemoizedFn } from './genericHooks'

interface UseWorkspaceFilesChangedRefreshOptions {
  rootPath?: LooseOptional<string>
  enabled?: boolean
  refreshInFlightRef?: MutableRefObject<boolean>
  onChanged: (event: SystemWorkspaceFilesChangedEvent) => void | Promise<void>
}

export function useWorkspaceFilesChangedRefresh(
  {
    rootPath,
    enabled = true,
    refreshInFlightRef,
    onChanged,
  }: UseWorkspaceFilesChangedRefreshOptions
): void {
  const handleChanged = useMemoizedFn((event: SystemWorkspaceFilesChangedEvent): void => {
    if (refreshInFlightRef?.current) return
    void onChanged(event)
  })

  useEffect(() => {
    const workspaceRoot = rootPath?.trim()
    if (!enabled || !workspaceRoot) return

    let disposed = false
    let subscriptionId: Nullable<string> = null
    const unsubscribeChanged = window.velarosWorkbenchWatch.onChanged((payload) => {
      if (disposed || payload.subscriptionId !== subscriptionId || refreshInFlightRef?.current)
        return
      handleChanged(payload.event)
    })

    void window.velarosWorkbenchWatch.start({ workspaceRoot }).then((result) => {
      if (!result.ok) return
      subscriptionId = result.value.subscriptionId
      if (disposed) {
        void window.velarosWorkbenchWatch.stop({ subscriptionId })
      }
    })

    return () => {
      disposed = true
      unsubscribeChanged()
      if (subscriptionId) void window.velarosWorkbenchWatch.stop({ subscriptionId })
    }
  }, [enabled, handleChanged, rootPath])
}
