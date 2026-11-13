/**
 * 窗口状态 IPC 装配：按 event.sender 找到发问的那个窗口，读它此刻的状态。
 *
 * 全屏推送由 `installWorkbenchWindowState` 负责；主题同步只接受已注册应用窗口的请求。
 */
import { BrowserWindow, ipcMain, type WebContents } from 'electron'

import { AppError } from '@velaros-ai/velaros/core/error'

import { WorkbenchWindowStateChannels } from '../../shared/workbenchWindowState'

import type { WorkbenchNativeAppearance } from './WorkbenchNativeAppearance'
import { readWorkbenchWindowState } from './WorkbenchWindowState'

export function registerWorkbenchWindowStateIpc(
  appearance: WorkbenchNativeAppearance,
  acceptsSender: (sender: WebContents) => boolean
): void {
  ipcMain.handle(WorkbenchWindowStateChannels.getState, (event) =>
    readWorkbenchWindowState(BrowserWindow.fromWebContents(event.sender))
  )
  ipcMain.handle(WorkbenchWindowStateChannels.setTheme, (event, theme: unknown) => {
    if (!acceptsSender(event.sender)) throw new AppError('PERMISSION', 'Missing Workbench window')
    appearance.setTheme(theme)
  })
}
