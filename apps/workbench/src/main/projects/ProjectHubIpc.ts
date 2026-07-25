/**
 * 项目枢纽 IPC 装配：handle 起手页动作通道，状态变更广播到所有窗口。
 *
 * IPC 入参是边界外来数据，在此解析一次（非字符串一律按无效路径处理），枢纽服务内部只见类型。
 */
import { BrowserWindow, ipcMain } from 'electron'

import { WorkbenchProjectHubChannels } from '../../shared/projectHub'

import type { WorkbenchProjectHub } from './ProjectHub'

export function registerProjectHubIpc(hub: WorkbenchProjectHub): void {
  ipcMain.handle(WorkbenchProjectHubChannels.getState, () => hub.getState())

  ipcMain.handle(WorkbenchProjectHubChannels.openProjectDialog, (event) =>
    hub.openProjectViaDialog(BrowserWindow.fromWebContents(event.sender))
  )

  ipcMain.handle(WorkbenchProjectHubChannels.openProjectPath, (_event, path: unknown) =>
    typeof path === 'string' && path.length > 0
      ? hub.openProjectPath(path)
      : { ok: false as const, reason: 'missing' as const }
  )

  ipcMain.handle(WorkbenchProjectHubChannels.pickNewProjectLocation, (event) =>
    hub.pickNewProjectLocation(BrowserWindow.fromWebContents(event.sender))
  )

  ipcMain.handle(
    WorkbenchProjectHubChannels.createProject,
    (_event, locationPath: unknown, name: unknown) =>
      typeof locationPath === 'string' && typeof name === 'string'
        ? hub.createProject(locationPath, name)
        : { ok: false as const, reason: 'invalid-name' as const }
  )

  ipcMain.handle(WorkbenchProjectHubChannels.removeRecentProject, (_event, path: unknown) =>
    typeof path === 'string' ? hub.removeRecentProject(path) : hub.getState()
  )

  ipcMain.handle(WorkbenchProjectHubChannels.closeProject, () => hub.closeProject())

  hub.onStateChanged((state) => {
    for (const window of BrowserWindow.getAllWindows()) {
      window.webContents.send(WorkbenchProjectHubChannels.stateChanged, state)
    }
  })
}
