import { useEffect } from 'react'

import type { SystemWorkspaceFilesChangedEvent } from '@shared/contracts'

import { useMemoizedFn } from './genericHooks'

interface UseWorkspaceFilesChangedRefreshOptions {
  rootPath?: LooseOptional<string>
  enabled?: boolean
  onChanged: (event: SystemWorkspaceFilesChangedEvent) => void | Promise<void>
}

/**
 * 订阅项目根目录的文件变更事件。事件一律送达：调用方正在刷新时到的事件由它自己排队重跑，
 * 在这里丢掉会让 Agent 连着写的第二个文件在编辑器里一直是旧内容。
 */
export function useWorkspaceFilesChangedRefresh(
  {
    rootPath,
    enabled = true,
    onChanged,
  }: UseWorkspaceFilesChangedRefreshOptions
): void {
  const handleChanged = useMemoizedFn((event: SystemWorkspaceFilesChangedEvent): void => {
    void onChanged(event)
  })

  useEffect(() => {
    const workspaceRoot = rootPath?.trim()
    if (!enabled || !workspaceRoot) return

    let disposed = false
    let subscriptionId: Nullable<string> = null
    const unsubscribeChanged = window.velarosWorkbenchWatch.onChanged((payload) => {
      if (disposed || payload.subscriptionId !== subscriptionId) return
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
