import {
  type WorkbenchHost,
  WorkbenchHostRuntime,
} from '../host'
import {
  WorkbenchCommentStore,
  type WorkbenchCommentStoreOptions,
} from '../models/comments/workbenchCommentStore'

export interface WorkbenchRuntimeOptions {
  host: WorkbenchHost
  comments?: WorkbenchCommentStoreOptions
}

/**
 * 一个完整且可销毁的 Workbench composition root。
 *
 * 它集中拥有宿主端口与评论状态，适合多窗口、多 React root 与测试隔离。
 */
export class WorkbenchRuntime {
  public readonly host: WorkbenchHostRuntime
  public readonly comments: WorkbenchCommentStore
  private disposed = false

  public constructor(options: WorkbenchRuntimeOptions) {
    this.host = new WorkbenchHostRuntime(options.host)
    this.comments = new WorkbenchCommentStore(options.comments)
  }

  public dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.comments.dispose()
    this.host.dispose()
  }
}
