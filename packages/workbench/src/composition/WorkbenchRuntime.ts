import {
  type WorkbenchHost,
  WorkbenchHostRuntime,
} from '../host'
import {
  WorkbenchCommentStore,
  type WorkbenchCommentStoreOptions,
} from '../models/comments/workbenchCommentStore'
import { WorkbenchLanguagePluginInstallRuntime } from '../models/editor/workbenchLanguagePluginInstallState'

export interface WorkbenchRuntimeOptions {
  host: WorkbenchHost
  comments?: WorkbenchCommentStoreOptions
  legacyLanguagePluginEventTarget?: EventTarget
}

/**
 * 一个完整且可销毁的 Workbench composition root。
 *
 * 它集中拥有宿主端口、评论状态和语言插件状态，适合多窗口、多 React root 与测试隔离。
 */
export class WorkbenchRuntime {
  public readonly host: WorkbenchHostRuntime
  public readonly comments: WorkbenchCommentStore
  public readonly languagePlugins: WorkbenchLanguagePluginInstallRuntime
  private disposed = false

  public constructor(options: WorkbenchRuntimeOptions) {
    this.host = new WorkbenchHostRuntime(options.host)
    this.comments = new WorkbenchCommentStore(options.comments)
    this.languagePlugins = new WorkbenchLanguagePluginInstallRuntime({
      hostRuntime: this.host,
      legacyEventTarget: options.legacyLanguagePluginEventTarget,
    })
  }

  public dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.languagePlugins.dispose()
    this.comments.dispose()
    this.host.dispose()
  }
}
