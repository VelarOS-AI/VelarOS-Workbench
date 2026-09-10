import { BrowserWindow, ipcMain } from 'electron'

import {
  WorkbenchAccountChannels,
  type WorkbenchAccountState,
} from '../../shared/workbenchAccount'

import type { WorkbenchAccountService } from './WorkbenchAccountService'

export function registerWorkbenchAccountIpc(service: WorkbenchAccountService): () => void {
  const publish = (state: WorkbenchAccountState): WorkbenchAccountState => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send(WorkbenchAccountChannels.changed, state)
    }
    return state
  }
  ipcMain.handle(WorkbenchAccountChannels.getState, () => service.getState())
  ipcMain.handle(WorkbenchAccountChannels.ensureSignedIn, () =>
    service.ensureSignedIn().then(publish))
  ipcMain.handle(WorkbenchAccountChannels.signIn, () => service.signIn().then(publish))
  ipcMain.handle(WorkbenchAccountChannels.signOut, () => service.signOut().then(publish))
  // 价格目录拿不到只是不显示约价，不算错误。
  ipcMain.handle(WorkbenchAccountChannels.getModelPricing, () =>
    service.getPublicModelPricing().catch(() => null))
  return () => {
    ipcMain.removeHandler(WorkbenchAccountChannels.getState)
    ipcMain.removeHandler(WorkbenchAccountChannels.ensureSignedIn)
    ipcMain.removeHandler(WorkbenchAccountChannels.signIn)
    ipcMain.removeHandler(WorkbenchAccountChannels.signOut)
    ipcMain.removeHandler(WorkbenchAccountChannels.getModelPricing)
  }
}
