/**
 * 应用菜单跟随项目状态：文件菜单提供新建 / 打开 / 最近项目 / 关闭项目，与起手页同一套动作面。
 *
 * 「新建项目…」需要 renderer 收集项目名，走 menuCommand 广播让起手页 / 工作台打开创建对话框；
 * 其余动作直接驱动 main 侧枢纽服务。状态每次变更整体重建菜单（最近列表与关闭项可用性跟随）。
 */
import { BrowserWindow, Menu, type MenuItemConstructorOptions } from 'electron'

import {
  WorkbenchProjectHubChannels,
  type WorkbenchProjectHubMenuCommand,
  type WorkbenchRecentProject,
} from '../../shared/projectHub'

import type { WorkbenchProjectHub } from './ProjectHub'

export function installProjectHubMenu(hub: WorkbenchProjectHub): void {
  const rebuild = (): void => {
    Menu.setApplicationMenu(buildApplicationMenu(hub))
  }

  hub.onStateChanged(rebuild)
  rebuild()
}

function buildApplicationMenu(hub: WorkbenchProjectHub): Menu {
  const state = hub.getState()
  const template: MenuItemConstructorOptions[] = []

  if (process.platform === 'darwin') template.push({ role: 'appMenu' })

  template.push(
    {
      label: '文件',
      submenu: [
        {
          label: '新建项目…',
          accelerator: 'CmdOrCtrl+Shift+N',
          click: () => {
            broadcastMenuCommand('new-project')
          },
        },
        {
          label: '打开项目…',
          accelerator: 'CmdOrCtrl+O',
          click: () => {
            void hub.openProjectViaDialog(BrowserWindow.getFocusedWindow())
          },
        },
        {
          label: '最近项目',
          submenu: buildRecentProjectItems(hub, state.recentProjects),
        },
        { type: 'separator' },
        {
          label: '关闭项目',
          enabled: state.currentProject !== null,
          click: () => {
            hub.closeProject()
          },
        },
      ],
    },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' }
  )

  return Menu.buildFromTemplate(template)
}

function buildRecentProjectItems(
  hub: WorkbenchProjectHub,
  recentProjects: WorkbenchRecentProject[]
): MenuItemConstructorOptions[] {
  if (recentProjects.length === 0) return [{ label: '暂无最近项目', enabled: false }]

  return recentProjects.map((project) => ({
    label: project.name,
    sublabel: project.path,
    enabled: !project.missing,
    click: () => {
      hub.openProjectPath(project.path)
    },
  }))
}

function broadcastMenuCommand(command: WorkbenchProjectHubMenuCommand): void {
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send(WorkbenchProjectHubChannels.menuCommand, command)
  }
}
