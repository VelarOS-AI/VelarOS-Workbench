import { Log, toNullable } from '@velaros-ai/core'

import type {
  WorkbenchLanguageGrammarCatalog,
  WorkbenchLanguageGrammarInstallState,
} from '../../contracts/index'
import { workbenchHost } from '../../host'

export const WORKBENCH_LANGUAGE_PLUGIN_INSTALL_STATE_CHANGED_EVENT =
  'velaros:workbench-language-plugins-changed'
const log = Log.tag('workbench-language-plugin-install-state')

// 语法插件的「已安装」真值来自主进程 catalog（userData 下的实际文件），不再是本地 localStorage 标记。
// 本模块维护一份内存缓存 + 首次访问时接上 IPC 订阅，并保留旧的自定义事件供 UI 监听刷新。
const installedIds = new Set<string>()
const installStates = new Map<string, WorkbenchLanguageGrammarInstallState>()
let started = false

function applyCatalog(catalog: WorkbenchLanguageGrammarCatalog): void {
  installedIds.clear()
  installStates.clear()
  for (const grammar of catalog.grammars) {
    if (grammar.installed) installedIds.add(grammar.id)
    if (grammar.install) installStates.set(grammar.id, grammar.install)
  }
  emitWorkbenchLanguagePluginInstallStateChanged()
}

function ensureStarted(): void {
  if (started) return
  started = true
  try {
    workbenchHost.kernel.project.onWorkbenchLanguageGrammarsChanged(applyCatalog)
    void workbenchHost.kernel.project.listWorkbenchLanguageGrammars().then((result) => {
      if (result.ok) applyCatalog(result.data)
    })
  } catch (error) {
    log.warn('订阅语法插件目录失败', error)
  }
}

export function readDownloadedWorkbenchLanguagePluginIds(): Set<string> {
  ensureStarted()
  return new Set(installedIds)
}

export function getWorkbenchLanguagePluginInstallState(
  pluginId: string
): Nullable<WorkbenchLanguageGrammarInstallState> {
  return toNullable(installStates.get(pluginId))
}

/**
 * 触发下载安装。真正的「已安装」状态由主进程 catalog 事件回填；此处乐观返回当前集合，
 * 进度/完成经 onWorkbenchLanguageGrammarsChanged → applyCatalog → 自定义事件驱动 UI。
 */
export function markWorkbenchLanguagePluginDownloaded(pluginId: string): Set<string> {
  ensureStarted()
  void workbenchHost.kernel.project.installWorkbenchLanguageGrammar({ id: pluginId }).then((result) => {
    if (result.ok) applyCatalog(result.data)
  })
  return new Set(installedIds)
}

export function emitWorkbenchLanguagePluginInstallStateChanged(target: Window = window): void {
  target.dispatchEvent(
    new CustomEvent(WORKBENCH_LANGUAGE_PLUGIN_INSTALL_STATE_CHANGED_EVENT, {
      detail: { pluginIds: [...installedIds].sort() },
    })
  )
}
