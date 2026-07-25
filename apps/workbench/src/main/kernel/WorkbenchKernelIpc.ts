import { BrowserWindow, ipcMain } from 'electron'

import { WorkbenchKernelChannels } from '../../shared/workbenchKernel'

import type { WorkbenchKernelClientRuntime } from './WorkbenchKernelClientRuntime'

export function registerWorkbenchKernelIpc(
  runtime: WorkbenchKernelClientRuntime
): () => void {
  ipcMain.handle(WorkbenchKernelChannels.getStatus, () => runtime.getStatus())
  ipcMain.handle(WorkbenchKernelChannels.retry, () => runtime.retry())

  const unsubscribe = runtime.subscribe((status) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) {
        window.webContents.send(WorkbenchKernelChannels.statusChanged, status)
      }
    }
  })

  return () => {
    unsubscribe()
    ipcMain.removeHandler(WorkbenchKernelChannels.getStatus)
    ipcMain.removeHandler(WorkbenchKernelChannels.retry)
  }
}
