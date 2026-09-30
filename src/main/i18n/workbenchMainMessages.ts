/**
 * main 进程给用户看的文字（应用菜单、Dock 菜单……），按 {@link getWorkbenchMainLocale} 出中文或英文。英文表的键与
 * 中文表一一对应，少一个就编译不过。`{name}` 这样的占位按参数替换。
 */
import type { AppLocale } from '@shared/contracts'

import { getWorkbenchMainLocale } from './workbenchMainLocale'

const zhCN = {
  'menu.file': '文件',
  'menu.newProject': '新建项目…',
  'menu.openProject': '打开项目…',
  'menu.recentProjects': '最近项目',
  'menu.noRecentProjects': '暂无最近项目',
  'menu.closeEditor': '关闭编辑器',
  'menu.closeWindow': '关闭窗口',
  'menu.closeProject': '关闭项目',
  'menu.view': '视图',
  'menu.zoomEditorIn': '放大编辑器',
  'menu.zoomEditorOut': '缩小编辑器',
  'menu.zoomEditorReset': '重置编辑器缩放',
  'menu.openProjectInNewWindow': '在新窗口打开项目…',
} as const

export type WorkbenchMainMessageKey = keyof typeof zhCN

const enUS: Record<WorkbenchMainMessageKey, string> = {
  'menu.file': 'File',
  'menu.newProject': 'New Project…',
  'menu.openProject': 'Open Project…',
  'menu.recentProjects': 'Recent Projects',
  'menu.noRecentProjects': 'No Recent Projects',
  'menu.closeEditor': 'Close Editor',
  'menu.closeWindow': 'Close Window',
  'menu.closeProject': 'Close Project',
  'menu.view': 'View',
  'menu.zoomEditorIn': 'Zoom In Editor',
  'menu.zoomEditorOut': 'Zoom Out Editor',
  'menu.zoomEditorReset': 'Reset Editor Zoom',
  'menu.openProjectInNewWindow': 'Open Project in New Window…',
}

const messages: Record<AppLocale, Record<WorkbenchMainMessageKey, string>> = {
  'zh-CN': zhCN,
  'en-US': enUS,
}

export function workbenchMainText(
  key: WorkbenchMainMessageKey,
  params?: Readonly<Record<string, string | number>>
): string {
  const template = messages[getWorkbenchMainLocale()][key]
  return params
    ? template.replace(/\{(\w+)\}/gu, (placeholder, name: string) =>
        params[name] === undefined ? placeholder : String(params[name])
      )
    : template
}
