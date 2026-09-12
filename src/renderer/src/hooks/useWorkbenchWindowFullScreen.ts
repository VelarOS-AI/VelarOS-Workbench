import { useEffect, useState } from 'react'

import type { WorkbenchWindowState } from '@shared/workbenchWindowState'

/**
 * 当前窗口是否处于系统全屏：投影 main 侧 BrowserWindow 的全屏状态，renderer 不自己猜。
 *
 * 挂载（含页面重载）时先读一次，之后跟着 `enter-full-screen` / `leave-full-screen` 的推送走。
 * 推送总是带完整的新状态，所以一旦收到过推送，稍后才回来的那次初始读取就是旧的，直接丢掉。
 */
export function useWorkbenchWindowFullScreen(): boolean {
  const [fullScreen, setFullScreen] = useState(false)

  useEffect(() => {
    let active = true
    let pushed = false
    const apply = (state: WorkbenchWindowState): void => {
      if (active) setFullScreen(state.fullScreen)
    }
    const unsubscribe = window.velarosWorkbenchWindowState.onChanged((state) => {
      pushed = true
      apply(state)
    })
    void window.velarosWorkbenchWindowState.getState().then((state) => {
      if (!pushed) apply(state)
    })
    return () => {
      active = false
      unsubscribe()
    }
  }, [])

  return fullScreen
}
