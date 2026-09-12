/**
 * 独立 Workbench 窗口状态的 main ↔ renderer IPC 契约（应用私有）。
 *
 * 目前只有「是否全屏」一项：macOS `titleBarStyle: hiddenInset` 下顶栏给红绿灯留了左侧空位，
 * 全屏时红绿灯随标题栏一起收起，这块空位就得还回来。全屏与否只有 main 的 BrowserWindow 说得准
 * （`enter-full-screen` / `leave-full-screen` 与 `isFullScreen()`）；renderer 拿窗口尺寸去猜会被
 * 最大化、分屏骗到，所以只投影这里推过来的状态。
 */

export const WorkbenchWindowStateChannels = {
  getState: 'workbench-app:window-state:get-state',
  changed: 'workbench-app:window-state:changed',
} as const

export interface WorkbenchWindowState {
  /** 窗口处于系统全屏（macOS 为独立空间全屏）。 */
  fullScreen: boolean
}

/** preload 通过 contextBridge 暴露给 renderer 的窗口状态桥面。 */
export interface WorkbenchWindowStateBridge {
  /** 当前窗口此刻的状态；renderer 挂载（含页面重载）时读一次，之后跟推送走。 */
  getState: () => Promise<WorkbenchWindowState>
  onChanged: (listener: (state: WorkbenchWindowState) => void) => () => void
}
