import type { BrowserWindow } from 'electron'

import {
  type WorkbenchWindowState,
  WorkbenchWindowStateChannels,
} from '../../shared/workbenchWindowState'

/** 窗口此刻的状态；找不到窗口或窗口已销毁时按「未全屏」答，renderer 保持常规外观。 */
export function readWorkbenchWindowState(
  window: Nullable<Pick<BrowserWindow, 'isDestroyed' | 'isFullScreen'>>
): WorkbenchWindowState {
  return { fullScreen: !!window && !window.isDestroyed() && window.isFullScreen() }
}

/**
 * 进出全屏时把新状态推给这个窗口自己的 renderer。
 *
 * 只认 Electron 的 `enter-full-screen` / `leave-full-screen`：macOS 的全屏转场是异步动画，
 * 这两个事件落在转场完成之后，此时读 `isFullScreen()` 才是定论。窗口建出来时就已处于的状态
 * （含页面重载后），由 renderer 挂载时经 getState 通道补读。
 */
export function installWorkbenchWindowState(window: BrowserWindow): void {
  const publish = (): void => {
    if (window.isDestroyed()) return
    window.webContents.send(WorkbenchWindowStateChannels.changed, readWorkbenchWindowState(window))
  }

  window.on('enter-full-screen', publish)
  window.on('leave-full-screen', publish)
}
