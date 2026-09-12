/**
 * 窗口状态 IPC 装配：按 event.sender 找到发问的那个窗口，读它此刻的状态。
 *
 * 状态变化的推送由各窗口创建时挂上的 `installWorkbenchWindowState` 负责，这里只答初始读取。
 */
import { BrowserWindow, ipcMain } from 'electron'

import { WorkbenchWindowStateChannels } from '../../shared/workbenchWindowState'

import { readWorkbenchWindowState } from './WorkbenchWindowState'

export function registerWorkbenchWindowStateIpc(): void {
  ipcMain.handle(WorkbenchWindowStateChannels.getState, (event) =>
    readWorkbenchWindowState(BrowserWindow.fromWebContents(event.sender))
  )
}
