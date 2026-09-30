import { describe, expect, mock, test } from 'bun:test'
import type { MenuItemConstructorOptions } from 'electron'

/** 每次重建菜单交给 Menu.buildFromTemplate 的模板（macOS 上还有 Dock 菜单）。 */
const builtTemplates: MenuItemConstructorOptions[][] = []

mock.module('electron', () => ({
  app: {
    getPreferredSystemLanguages: () => ['en-GB'],
    getLocale: () => 'en-GB',
    dock: { setMenu: () => undefined },
  },
  Menu: {
    buildFromTemplate: (template: MenuItemConstructorOptions[]) => {
      builtTemplates.push(template)
      return template
    },
    setApplicationMenu: () => undefined,
  },
}))

function labelsSince(start: number): string[] {
  const collect = (items: MenuItemConstructorOptions[]): string[] =>
    items.flatMap((item) => [
      ...(item.label ? [item.label] : []),
      ...(Array.isArray(item.submenu) ? collect(item.submenu) : []),
    ])
  return builtTemplates.slice(start).flatMap(collect)
}

describe('main-process text follows the interface language', () => {
  test('the application menu starts in the system language and switches with the interface', async () => {
    const { installProjectHubMenu } = await import('../src/main/projects/ProjectHubMenu')
    const { getWorkbenchMainLocale, setWorkbenchMainLocale } = await import(
      '../src/main/i18n/workbenchMainLocale'
    )
    const windows = {
      onChanged: () => () => undefined,
      getFocusedState: () => ({ currentProject: null, recentProjects: [] }),
    }

    // 还没有窗口报过界面语言：按系统语言（英语）。
    expect(getWorkbenchMainLocale()).toBe('en-US')
    installProjectHubMenu(windows as never)
    expect(labelsSince(0)).toEqual(
      expect.arrayContaining(['File', 'New Project…', 'Recent Projects', 'No Recent Projects', 'View'])
    )

    const beforeSwitch = builtTemplates.length
    setWorkbenchMainLocale('zh-CN')
    expect(labelsSince(beforeSwitch)).toEqual(
      expect.arrayContaining(['文件', '新建项目…', '最近项目', '暂无最近项目', '视图'])
    )
    expect(labelsSince(beforeSwitch)).not.toContain('File')

    // 同一种语言再报一次不重建。
    const afterSwitch = builtTemplates.length
    setWorkbenchMainLocale('zh-CN')
    expect(builtTemplates.length).toBe(afterSwitch)
  })
})
