/**
 * 项目枢纽 IPC 装配：根据 event.sender 路由到对应窗口的项目状态。
 *
 * IPC 入参是边界外来数据，在此解析一次（非字符串一律按无效路径处理），枢纽服务内部只见类型。
 */
import { BrowserWindow, ipcMain, shell } from 'electron'

import { WorkbenchProjectHubChannels } from '../../shared/projectHub'

import { pickDirectory } from './ProjectPicker'
import type { WorkbenchWindowManager } from './WorkbenchWindowManager'

export function registerProjectHubIpc(windows: WorkbenchWindowManager): void {
  ipcMain.handle(
    WorkbenchProjectHubChannels.getState,
    (event) => windows.getHubForWebContents(event.sender)?.getState() ?? emptyState()
  )

  ipcMain.handle(WorkbenchProjectHubChannels.openProjectDialog, (event) =>
    windows.openProjectViaDialog(BrowserWindow.fromWebContents(event.sender))
  )

  ipcMain.handle(WorkbenchProjectHubChannels.openProjectPath, (event, path: unknown) =>
    typeof path === 'string' && path.length > 0
      ? windows.openProjectPath(event.sender, path)
      : { ok: false as const, reason: 'missing' as const }
  )

  ipcMain.handle(WorkbenchProjectHubChannels.switchProjectDialog, (event) =>
    windows.switchProjectViaDialog(event.sender)
  )

  ipcMain.handle(WorkbenchProjectHubChannels.switchProjectPath, (event, path: unknown) =>
    typeof path === 'string' && path.length > 0
      ? windows.switchProjectPath(event.sender, path)
      : { ok: false as const, reason: 'missing' as const }
  )

  ipcMain.handle(WorkbenchProjectHubChannels.openProjectDialogInNewWindow, (event) =>
    windows.openProjectInNewWindowViaDialog(BrowserWindow.fromWebContents(event.sender))
  )

  ipcMain.handle(WorkbenchProjectHubChannels.openProjectPathInNewWindow, (_event, path: unknown) =>
    typeof path === 'string' && path.length > 0
      ? windows.openProjectPathInNewWindow(path)
      : { ok: false as const, reason: 'missing' as const }
  )

  ipcMain.handle(WorkbenchProjectHubChannels.cloneProjectInNewWindow, (event, remoteUrl: unknown) =>
    typeof remoteUrl === 'string'
      ? windows.cloneProjectInNewWindow(event.sender, remoteUrl)
      : { ok: false as const, reason: 'invalid-remote' as const }
  )

  ipcMain.handle(WorkbenchProjectHubChannels.validateProjectPath, (_event, path: unknown) =>
    typeof path === 'string' && path.length > 0
      ? windows.validateProjectPath(path)
      : { ok: false as const, reason: 'missing' as const }
  )

  ipcMain.handle(WorkbenchProjectHubChannels.openDroppedPaths, (event, paths: unknown) =>
    Array.isArray(paths) && paths.length <= 32 && paths.every((path) => typeof path === 'string')
      ? windows.openDroppedPaths(event.sender, paths)
      : { opened: [], openedFiles: [], rejected: [] }
  )

  ipcMain.handle(WorkbenchProjectHubChannels.acknowledgeFileOpen, (event, id: unknown) =>
    typeof id === 'number' && Number.isSafeInteger(id) && id > 0
      ? windows.acknowledgeFileOpen(event.sender, id)
      : (windows.getHubForWebContents(event.sender)?.getState() ?? emptyState())
  )

  ipcMain.handle(WorkbenchProjectHubChannels.openSystemPath, async (_event, path: unknown) => {
    if (typeof path !== 'string' || path.trim().length === 0) return { opened: false, error: 'Path is required.' }
    const error = await shell.openPath(path)
    return error ? { opened: false, error } : { opened: true }
  })

  ipcMain.handle(WorkbenchProjectHubChannels.pickNewProjectLocation, async (event) => {
    const picked = await pickDirectory(
      BrowserWindow.fromWebContents(event.sender),
      '选择项目位置'
    )
    return picked
      ? { ok: true as const, path: picked }
      : { ok: false as const, reason: 'canceled' as const }
  })

  ipcMain.handle(
    WorkbenchProjectHubChannels.createProject,
    (event, locationPath: unknown, name: unknown) =>
      typeof locationPath === 'string' && typeof name === 'string'
        ? windows.createProject(event.sender, locationPath, name)
        : { ok: false as const, reason: 'invalid-name' as const }
  )

  ipcMain.handle(WorkbenchProjectHubChannels.removeRecentProject, (event, path: unknown) =>
    typeof path === 'string'
      ? windows.removeRecentProject(event.sender, path)
      : (windows.getHubForWebContents(event.sender)?.getState() ?? emptyState())
  )

  ipcMain.handle(WorkbenchProjectHubChannels.closeProject, (event) =>
    windows.closeProject(event.sender)
  )
  ipcMain.handle(WorkbenchProjectHubChannels.returnToEntry, (event) =>
    windows.returnToEntry(event.sender)
  )
}

function emptyState() {
  return { currentProject: null, recentProjects: [], pendingFileOpen: null }
}
