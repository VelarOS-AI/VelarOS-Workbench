/** Windows 任务栏右键菜单：用项目名展示同一份最近项目，点击走已有的单实例目录投递。 */
import { dirname } from 'node:path'

import { app, type JumpListCategory, type JumpListItem } from 'electron'

import { onWorkbenchMainLocaleChanged } from '../i18n/workbenchMainLocale'
import { workbenchMainText } from '../i18n/workbenchMainMessages'

import type { WorkbenchWindowManager } from './WorkbenchWindowManager'

export function installWorkbenchWindowsJumpList(windows: WorkbenchWindowManager): void {
  if (process.platform !== 'win32') return

  // Shell 移除后持续隐藏，直到用户在应用中再次打开这个项目。
  const removedProjects = new Map<string, number>()
  let lastProjection: string | undefined
  const rebuild = (): void => {
    try {
      const removedArguments = new Set(
        app.getJumpListSettings().removedItems.map((item) => item.args)
      )
      const items: JumpListItem[] = []
      for (const project of windows.getRecentProjects()) {
        if (project.missing) continue
        const args = (app.isPackaged ? [project.path] : [app.getAppPath(), project.path])
          .map(quoteWindowsArgument)
          .join(' ')
        if (removedArguments.has(args)) removedProjects.set(args, project.lastOpenedAt)
        if (removedProjects.get(args) === project.lastOpenedAt) continue

        items.push({
          type: 'task',
          title: project.name,
          description: project.path.slice(0, 260),
          program: process.execPath,
          args,
          iconPath: process.execPath,
          iconIndex: 0,
          workingDirectory: app.isPackaged ? dirname(process.execPath) : process.cwd(),
        })
      }

      const categories: JumpListCategory[] = items.length
        ? [{ type: 'custom', name: workbenchMainText('menu.recentProjects'), items }]
        : []
      const projection = JSON.stringify(categories)
      if (projection === lastProjection) return

      const result = app.setJumpList(categories)
      if (result === 'ok') lastProjection = projection
      else console.warn('[workbench-app] failed to update Windows recent projects', result)
    } catch (error) {
      console.warn('[workbench-app] failed to update Windows recent projects', error)
    }
  }

  windows.onChanged(rebuild)
  onWorkbenchMainLocaleChanged(rebuild)
  rebuild()
}

/** Windows CommandLineToArgvW：引号前与结尾的反斜杠都必须转义（也包括盘符根目录）。 */
function quoteWindowsArgument(argument: string): string {
  return `"${argument.replace(/(\\*)"/gu, '$1$1\\"').replace(/(\\+)$/u, '$1$1')}"`
}
