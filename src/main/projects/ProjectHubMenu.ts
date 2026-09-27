/**
 * 应用菜单与 macOS Dock 菜单跟随项目状态：文件菜单提供新建 / 打开 /
 * 最近项目 / 关闭项目，Dock 从同一份最近项目投影打开或聚焦项目窗口。
 *
 * 「新建项目…」需要 renderer 收集项目名，走 menuCommand 发送到焦点窗口；关闭项目同样先让
 * renderer 完成未保存检查。其余动作直接驱动窗口管理器。状态变化与窗口聚焦都会重建菜单。
 */
import { app, Menu, type MenuItemConstructorOptions } from 'electron'

import { type WorkbenchRecentProject } from '../../shared/projectHub'

import type { WorkbenchWindowManager } from './WorkbenchWindowManager'

export function installProjectHubMenu(windows: WorkbenchWindowManager): void {
  const rebuild = (): void => {
    Menu.setApplicationMenu(buildApplicationMenu(windows))
    if (process.platform === 'darwin') {
      app.dock?.setMenu(buildDockMenu(windows))
    }
  }

  windows.onChanged(rebuild)
  rebuild()
}

function buildDockMenu(windows: WorkbenchWindowManager): Menu {
  const recentProjects = windows.getFocusedState().recentProjects
  return Menu.buildFromTemplate([
    {
      label: '最近项目',
      submenu: buildRecentProjectItems(windows, recentProjects, 'new-window'),
    },
    { type: 'separator' },
    {
      label: '在新窗口打开项目…',
      click: () => {
        void windows.openProjectInNewWindowViaDialog(windows.getFocusedWindow())
      },
    },
  ])
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
          // 同 VS Code：⌘W / Ctrl+W 关编辑区当前的标签，没有标签时什么也不做，不会把项目窗口关掉。
          label: '关闭编辑器',
          accelerator: 'CmdOrCtrl+W',
          enabled: state.currentProject !== null,
          click: (_item, window) => {
            windows.sendMenuCommandToWindow(window ?? null, 'close-editor')
          },
        },
        {
          // 关窗走窗口的 close：有未保存改动时先确认（见 WorkbenchWindowCloseGuard）。
          label: '关闭窗口',
          accelerator: 'CmdOrCtrl+Shift+W',
          click: (_item, window) => {
            window?.close()
          },
        },
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
    {
      // 不用内置的 windowMenu：它在 Windows / Linux 上带着占用 Ctrl+W 的「关闭」，会把整个窗口关掉。
      role: 'window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        ...(process.platform === 'darwin'
          ? ([{ type: 'separator' }, { role: 'front' }] satisfies MenuItemConstructorOptions[])
          : []),
      ],
    }
  )

  return Menu.buildFromTemplate(template)
}

function buildRecentProjectItems(
  windows: WorkbenchWindowManager,
  recentProjects: WorkbenchRecentProject[],
  disposition: 'focused-window' | 'new-window' = 'focused-window'
): MenuItemConstructorOptions[] {
  if (recentProjects.length === 0) return [{ label: '暂无最近项目', enabled: false }]

  return recentProjects.map((project) => ({
    label: project.name,
    sublabel: project.path,
    enabled: !project.missing,
    click: () => {
      void (disposition === 'new-window'
        ? windows.openProjectPathInNewWindow(project.path)
        : windows.openProjectPath(windows.getFocusedWindow()?.webContents ?? null, project.path))
    },
  }))
}
