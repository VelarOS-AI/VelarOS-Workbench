import { BrowserWindow, ipcMain, type WebContents } from 'electron'

import { AppError } from '@velaros-ai/core/error'

import {
  WorkbenchBrowserChannels,
  type WorkbenchBrowserCloseSessionRequest,
  type WorkbenchBrowserPresentPageRequest,
  type WorkbenchBrowserStateRequest,
} from '../../shared/workbenchBrowser'
import type { WorkbenchWindowManager } from '../projects/WorkbenchWindowManager'

import type { WorkbenchBrowserToolHost } from './WorkbenchBrowserToolHost'

/** Browser IPC 的 projectRoot 永远从 sender 对应窗口读取，不接受 renderer 自报。 */
export function registerWorkbenchBrowserIpc(
  host: WorkbenchBrowserToolHost,
  windows: Pick<WorkbenchWindowManager, 'getHubForWebContents'>
): () => void {
  const broadcast = (): void => {
    const event = { generation: hostGeneration(host) }
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
        window.webContents.send(WorkbenchBrowserChannels.changed, event)
      }
    }
  }
  const unsubscribe = host.subscribe(broadcast)

  ipcMain.handle(WorkbenchBrowserChannels.getState, (event, request: unknown) => {
    const parsed = readStateRequest(request)
    return host.getState(parsed.sessionId, resolveSenderProjectRoot(windows, event.sender))
  })
  ipcMain.handle(WorkbenchBrowserChannels.presentPage, (event, request: unknown) => {
    const parsed = readPresentPageRequest(request)
    return host.presentPage({
      ...parsed,
      projectRoot: resolveSenderProjectRoot(windows, event.sender),
      hostWebContentsId: event.sender.id,
    })
  })
  ipcMain.handle(WorkbenchBrowserChannels.closeSession, (event, request: unknown) => {
    const parsed = readCloseSessionRequest(request)
    return host.releaseSession(
      parsed.sessionId,
      resolveSenderProjectRoot(windows, event.sender)
    )
  })

  return () => {
    unsubscribe()
    ipcMain.removeHandler(WorkbenchBrowserChannels.getState)
    ipcMain.removeHandler(WorkbenchBrowserChannels.presentPage)
    ipcMain.removeHandler(WorkbenchBrowserChannels.closeSession)
  }
}

function resolveSenderProjectRoot(
  windows: Pick<WorkbenchWindowManager, 'getHubForWebContents'>,
  sender: WebContents
): string {
  const projectRoot = windows.getHubForWebContents(sender)?.getState().currentProject?.path
  if (!projectRoot) {
    throw new AppError('PERMISSION', 'This Workbench window does not own an open project.')
  }
  return projectRoot
}

function readStateRequest(request: unknown): WorkbenchBrowserStateRequest {
  const value = readRequestRecord(request)
  if (typeof value['sessionId'] !== 'string') {
    throw new AppError('VALIDATION', 'Workbench Browser session id must be a string.')
  }
  return { sessionId: value['sessionId'] }
}

function readPresentPageRequest(request: unknown): WorkbenchBrowserPresentPageRequest {
  const value = readRequestRecord(request)
  const state = readStateRequest(value)
  if (!Number.isSafeInteger(value['webContentsId']) || (value['webContentsId'] as number) <= 0) {
    throw new AppError('VALIDATION', 'Workbench Browser webContents id is invalid.')
  }
  return { sessionId: state.sessionId, webContentsId: value['webContentsId'] as number }
}

function readCloseSessionRequest(request: unknown): WorkbenchBrowserCloseSessionRequest {
  return readStateRequest(request)
}

function readRequestRecord(request: unknown): Record<string, unknown> {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw new AppError('VALIDATION', 'Workbench Browser request must be an object.')
  }
  return request as Record<string, unknown>
}

/** 事件契约只需要递增值；状态查询仍由 host 自己返回当前 generation。 */
function hostGeneration(host: WorkbenchBrowserToolHost): number {
  return host.getStateRevision()
}

export { readCloseSessionRequest, readPresentPageRequest, readStateRequest }
