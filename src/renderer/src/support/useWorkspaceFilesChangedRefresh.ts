import { useEffect } from 'react'

import { AppError } from '@velaros-ai/core/error'

import { type SystemWorkspaceFilesChangedEvent } from '@shared/contracts/system'
import type { WorkbenchWatchStatus } from '@shared/workbenchWatch'

import { useMemoizedFn } from './genericHooks'

interface UseWorkspaceFilesChangedRefreshOptions {
  rootPath?: LooseOptional<string>
  enabled?: boolean
  onChanged: (event: SystemWorkspaceFilesChangedEvent) => void | Promise<void>
  /**
   * 监听能不能跑：一开始就起不来、出错后停着（`unavailable`），或者恢复了（`watching`）。要把
   * 「改动收不到了」告诉用户的调用方传；恢复时主进程会补发一次整个根目录的变更。
   */
  onWatchStatus?: (status: WorkbenchWatchStatus) => void
}

/**
 * 订阅项目根目录的文件变更事件。事件一律送达：调用方正在刷新时到的事件由它自己排队重跑，
 * 在这里丢掉会让 Agent 连着写的第二个文件在编辑器里一直是旧内容。监听起不来、停了也不瞒着：
 * 经 `onWatchStatus` 报给调用方。
 */
export function useWorkspaceFilesChangedRefresh(
  {
    rootPath,
    enabled = true,
    onChanged,
    onWatchStatus,
  }: UseWorkspaceFilesChangedRefreshOptions
): void {
  const handleChanged = useMemoizedFn((event: SystemWorkspaceFilesChangedEvent): void => {
    void onChanged(event)
  })
  const handleWatchStatus = useMemoizedFn((status: WorkbenchWatchStatus): void => {
    onWatchStatus?.(status)
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
    const unsubscribeStatus = window.velarosWorkbenchWatch.onStatus((payload) => {
      if (disposed || payload.subscriptionId !== subscriptionId) return
      handleWatchStatus(payload.status)
    })
    // 订阅不上（工程目录没了、主进程出错）就没有后台重试，也不能悄悄当成在监听。
    const reportStartFailure = (message: string): void => {
      if (!disposed) handleWatchStatus({ state: 'unavailable', message })
    }

    void window.velarosWorkbenchWatch
      .start({ workspaceRoot })
      .then((result) => {
        if (!result.ok) {
          reportStartFailure(result.message)
          return
        }
        subscriptionId = result.value.subscriptionId
        if (disposed) {
          void window.velarosWorkbenchWatch.stop({ subscriptionId })
          return
        }
        handleWatchStatus(result.value.status)
      })
      .catch((error: unknown) => reportStartFailure(AppError.getMessage(error)))

    return () => {
      disposed = true
      unsubscribeChanged()
      unsubscribeStatus()
      if (subscriptionId) void window.velarosWorkbenchWatch.stop({ subscriptionId })
    }
  }, [enabled, handleChanged, handleWatchStatus, rootPath])
}
