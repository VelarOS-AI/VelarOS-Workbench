import { AppError, Log } from '@velaros-ai/core'

import type {
  WorkbenchLanguageGrammarCatalog,
  WorkbenchLanguageGrammarInstallState,
} from '../../contracts/index'
import { workbenchHost,type WorkbenchHostRuntime } from '../../host'

export const WORKBENCH_LANGUAGE_PLUGIN_INSTALL_STATE_CHANGED_EVENT =
  'velaros:workbench-language-plugins-changed'

export interface WorkbenchLanguagePluginInstallRuntimeOptions {
  hostRuntime?: WorkbenchHostRuntime
  /** 仅为旧版 DOM 自定义事件桥接保留。新应用请使用 `subscribe`。 */
  legacyEventTarget?: EventTarget
}

const log = Log.tag('workbench-language-plugin-install-state')

/**
 * 管理一个 Workbench composition root 的语言插件目录、安装状态与主进程订阅。
 */
export class WorkbenchLanguagePluginInstallRuntime {
  private readonly installedIds = new Set<string>()
  private readonly installStates = new Map<string, WorkbenchLanguageGrammarInstallState>()
  private readonly listeners = new Set<() => void>()
  private readonly hostRuntime: WorkbenchHostRuntime
  private readonly legacyEventTarget?: EventTarget
  private unsubscribeCatalog?: () => void
  private generation = 0
  private started = false
  private disposed = false

  public constructor(options: WorkbenchLanguagePluginInstallRuntimeOptions = {}) {
    this.hostRuntime = options.hostRuntime ?? workbenchHost
    this.legacyEventTarget = options.legacyEventTarget
  }

  public readonly subscribe = (listener: () => void): (() => void) => {
    this.assertActive()
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  public readonly readDownloadedPluginIds = (): Set<string> => {
    this.start()
    return new Set(this.installedIds)
  }

  public readonly getInstallState = (
    pluginId: string
  ): Nullable<WorkbenchLanguageGrammarInstallState> =>
    this.installStates.get(pluginId) ?? null

  /**
   * 触发下载安装。已安装真值只接受宿主返回的 catalog，不在渲染进程乐观伪造。
   */
  public readonly install = (pluginId: string): Set<string> => {
    this.start()
    const generation = this.generation
    void this.hostRuntime.kernel.project
      .installWorkbenchLanguageGrammar({ id: pluginId })
      .then((result) => {
        if (!this.disposed && generation === this.generation && result.ok) {
          this.applyCatalog(result.data)
        }
      })
      .catch((error) => {
        if (!this.disposed && generation === this.generation) {
          log.warn('安装语法插件失败', { error, pluginId })
        }
      })
    return new Set(this.installedIds)
  }

  /** 幂等启动目录订阅与首次加载。 */
  public start(): void {
    this.assertActive()
    if (this.started) return
    this.started = true
    const generation = ++this.generation

    try {
      this.unsubscribeCatalog =
        this.hostRuntime.kernel.project.onWorkbenchLanguageGrammarsChanged((catalog) => {
          if (!this.disposed && generation === this.generation) this.applyCatalog(catalog)
        })
      void this.hostRuntime.kernel.project
        .listWorkbenchLanguageGrammars()
        .then((result) => {
          if (!this.disposed && generation === this.generation && result.ok) {
            this.applyCatalog(result.data)
          }
        })
        .catch((error) => {
          if (!this.disposed && generation === this.generation) {
            log.warn('读取语法插件目录失败', error)
          }
        })
    } catch (error) {
      this.started = false
      log.warn('订阅语法插件目录失败', error)
    }
  }

  public dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.generation += 1
    try {
      this.unsubscribeCatalog?.()
    } catch (error) {
      log.warn('取消语法插件目录订阅失败', error)
    }
    this.unsubscribeCatalog = undefined
    this.installedIds.clear()
    this.installStates.clear()
    this.listeners.clear()
  }

  private applyCatalog(catalog: WorkbenchLanguageGrammarCatalog): void {
    this.installedIds.clear()
    this.installStates.clear()
    for (const grammar of catalog.grammars) {
      if (grammar.installed) this.installedIds.add(grammar.id)
      if (grammar.install) this.installStates.set(grammar.id, grammar.install)
    }
    this.listeners.forEach((listener) => listener())
    this.emitLegacyEvent()
  }

  private emitLegacyEvent(target = this.legacyEventTarget): void {
    if (!target || typeof CustomEvent === 'undefined') return
    target.dispatchEvent(
      new CustomEvent(WORKBENCH_LANGUAGE_PLUGIN_INSTALL_STATE_CHANGED_EVENT, {
        detail: { pluginIds: [...this.installedIds].sort() },
      })
    )
  }

  private assertActive(): void {
    if (this.disposed) {
      throw new AppError('INVARIANT', 'Workbench language plugin runtime has been disposed')
    }
  }
}

function getDefaultLegacyTarget(): EventTarget | undefined {
  return typeof window === 'undefined' ? undefined : window
}

/** 旧入口使用的默认实例。 */
export const workbenchLanguagePluginInstallRuntime =
  new WorkbenchLanguagePluginInstallRuntime({
    hostRuntime: workbenchHost,
    legacyEventTarget: getDefaultLegacyTarget(),
  })

/** @deprecated 使用 `WorkbenchLanguagePluginInstallRuntime.readDownloadedPluginIds`。 */
export const readDownloadedWorkbenchLanguagePluginIds =
  workbenchLanguagePluginInstallRuntime.readDownloadedPluginIds
/** @deprecated 使用 `WorkbenchLanguagePluginInstallRuntime.getInstallState`。 */
export const getWorkbenchLanguagePluginInstallState =
  workbenchLanguagePluginInstallRuntime.getInstallState
/** @deprecated 使用 `WorkbenchLanguagePluginInstallRuntime.install`。 */
export const markWorkbenchLanguagePluginDownloaded =
  workbenchLanguagePluginInstallRuntime.install

/** @deprecated 使用运行时的 `subscribe`，不再通过 DOM 事件观察状态。 */
export function emitWorkbenchLanguagePluginInstallStateChanged(
  target: EventTarget = getDefaultLegacyTarget() ?? new EventTarget()
): void {
  if (typeof CustomEvent === 'undefined') return
  target.dispatchEvent(
    new CustomEvent(WORKBENCH_LANGUAGE_PLUGIN_INSTALL_STATE_CHANGED_EVENT, {
      detail: {
        pluginIds: [...workbenchLanguagePluginInstallRuntime.readDownloadedPluginIds()].sort(),
      },
    })
  )
}
