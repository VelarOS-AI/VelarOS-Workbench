/**
 * 应用菜单跟随项目状态：文件菜单提供新建 / 打开 / 最近项目 / 关闭项目，与起手页同一套动作面。
 *
 * 「新建项目…」需要 renderer 收集项目名，走 menuCommand 发送到焦点窗口；关闭项目同样先让
 * renderer 完成未保存检查。其余动作直接驱动窗口管理器。状态变化与窗口聚焦都会重建菜单。
 */
import { Menu, type MenuItemConstructorOptions } from 'electron'

import { type WorkbenchRecentProject } from '../../shared/projectHub'

import type { WorkbenchWindowManager } from './WorkbenchWindowManager'

export function installProjectHubMenu(windows: WorkbenchWindowManager): void {
  const rebuild = (): void => {
    Menu.setApplicationMenu(buildApplicationMenu(windows))
  }

  windows.onChanged(rebuild)
  rebuild()
}

function buildApplicationMenu(windows: WorkbenchWindowManager): Menu {
  const state = windows.getFocusedState()
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
            windows.sendMenuCommand('new-project')
          },
        },
        {
          label: '打开项目…',
          accelerator: 'CmdOrCtrl+O',
          click: () => {
            void windows.openProjectViaDialog(windows.getFocusedWindow())
          },
        },
        {
          label: '最近项目',
          submenu: buildRecentProjectItems(windows, state.recentProjects),
        },
        { type: 'separator' },
        {
          label: '关闭项目',
          enabled: state.currentProject !== null,
          click: () => {
            windows.sendMenuCommand('close-project')
          },
        },
      ],
    },
    { role: 'editMenu' },
    {
      label: '视图',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        {
          label: '放大编辑器',
          accelerator: 'CmdOrCtrl+Plus',
          enabled: state.currentProject !== null,
          click: () => {
            windows.sendMenuCommand('zoom-editor-in')
          },
        },
        {
          label: '缩小编辑器',
          accelerator: 'CmdOrCtrl+-',
          enabled: state.currentProject !== null,
          click: () => {
            windows.sendMenuCommand('zoom-editor-out')
          },
        },
        {
          label: '重置编辑器缩放',
          accelerator: 'CmdOrCtrl+0',
          enabled: state.currentProject !== null,
          click: () => {
            windows.sendMenuCommand('zoom-editor-reset')
          },
        },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    { role: 'windowMenu' }
  )

  return Menu.buildFromTemplate(template)
}

function buildRecentProjectItems(
  windows: WorkbenchWindowManager,
  recentProjects: WorkbenchRecentProject[]
): MenuItemConstructorOptions[] {
  if (recentProjects.length === 0) return [{ label: '暂无最近项目', enabled: false }]

  return recentProjects.map((project) => ({
    label: project.name,
    sublabel: project.path,
    enabled: !project.missing,
    click: () => {
      void windows.openProjectPath(windows.getFocusedWindow()?.webContents ?? null, project.path)
    },
  }))
}
