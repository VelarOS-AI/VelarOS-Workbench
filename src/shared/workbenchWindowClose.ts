/**
 * 独立 Workbench 关窗与退出前「未保存改动」确认的 main ↔ renderer IPC 契约（应用私有）。
 *
 * renderer 随时把「这个窗口的编辑器有没有未保存的改动」报给 main；main 拦下关窗与退出，
 * 有改动的窗口先把关闭请求交给 renderer：能存的先存掉，存不下的再问用户（保存全部 / 不保存 / 取消），
 * renderer 答复之后 main 才放行或作罢。没有改动的窗口照常直接关。
 */

export const WorkbenchWindowCloseChannels = {
  setUnsavedChanges: 'workbench-app:window-close:set-unsaved-changes',
  closeRequested: 'workbench-app:window-close:close-requested',
  resolveCloseRequest: 'workbench-app:window-close:resolve-close-request',
} as const

/** `close`：关这一个窗口；`quit`：退出应用前挨个问到的窗口。 */
export type WorkbenchWindowCloseReason = 'close' | 'quit'

export interface WorkbenchWindowCloseRequest {
  id: number
  reason: WorkbenchWindowCloseReason
}

export interface WorkbenchWindowCloseResponse {
  id: number
  /** true：改动已存好或用户选了不保存，可以关；false：用户取消，或有文件没存下。 */
  proceed: boolean
}

/** preload 通过 contextBridge 暴露给 renderer 的关窗确认桥面。 */
export interface WorkbenchWindowCloseBridge {
  setUnsavedChanges: (unsaved: boolean) => void
  onCloseRequested: (listener: (request: WorkbenchWindowCloseRequest) => void) => () => void
  resolveCloseRequest: (response: WorkbenchWindowCloseResponse) => void
}
