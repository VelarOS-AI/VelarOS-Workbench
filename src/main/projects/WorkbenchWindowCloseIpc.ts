/**
 * 关窗确认 IPC 装配：按 event.sender 认出是哪个窗口在报「有没有未保存改动」、答复关闭请求。
 */
import { ipcMain, type IpcMainEvent } from 'electron'

import { WorkbenchWindowCloseChannels } from '../../shared/workbenchWindowClose'

import type { WorkbenchWindowCloseGuard } from './WorkbenchWindowCloseGuard'

export function registerWorkbenchWindowCloseIpc(guard: WorkbenchWindowCloseGuard): () => void {
  const setUnsavedChanges = (event: IpcMainEvent, unsaved: unknown): void => {
    guard.setUnsavedChanges(event.sender.id, unsaved === true)
  }
  const resolveCloseRequest = (event: IpcMainEvent, response: unknown): void => {
    if (typeof response !== 'object' || response === null) return

    const { id, proceed } = response as { id?: unknown; proceed?: unknown }
    if (typeof id !== 'number' || typeof proceed !== 'boolean') return
    guard.resolveCloseRequest(event.sender.id, { id, proceed })
  }

  ipcMain.on(WorkbenchWindowCloseChannels.setUnsavedChanges, setUnsavedChanges)
  ipcMain.on(WorkbenchWindowCloseChannels.resolveCloseRequest, resolveCloseRequest)
  return () => {
    ipcMain.removeListener(WorkbenchWindowCloseChannels.setUnsavedChanges, setUnsavedChanges)
    ipcMain.removeListener(WorkbenchWindowCloseChannels.resolveCloseRequest, resolveCloseRequest)
  }
}
