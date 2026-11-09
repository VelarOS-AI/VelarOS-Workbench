/**
 * 独立 Workbench 应用的数据区路径服务。
 *
 * 文件备份、会话、改动记录、记忆与浏览器资源由各产品服务分别持有，数据根由 main 入口注入
 * （prod=userData，dev=cwd/.velaros/data/workbench-app）。
 */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

const WorkbenchStorageDirectory = {
  localHistory: 'workbench-local-history',
  /**
   * 文件树删除的私有副本（只给小的留，供应用内撤销），一个会话一个子目录；
   * 删掉的东西本身在系统废纸篓里。启动时清掉以前会话的。
   */
  deleteUndo: 'workbench-delete-undo',
  /**
   * 聊天历史的落盘备份区。**不是会话权威**——权威仍在 renderer 的 localStorage，
   * 这里只兜住「localStorage 被清空或撞配额」的数据丢失。会话权威上收后整个目录可弃。
   */
  chatHistoryBackups: 'chat-history-backups',
  /** 「本轮改动」检查点的持久影子 index（每个项目根一份，只是 `git add -A` 的 stat 缓存，可随时删）。 */
  chatCheckpointIndexes: 'chat-checkpoint-indexes',
  /**
   * 每轮「本轮改动」的补丁记录（按项目根、会话分目录）。补丁全文只落在这里——会话历史在
   * localStorage，放不下；运行标记上只记摘要和记录 id。
   */
  chatRunChanges: 'chat-run-changes',
  /**
   * Platform 会话数据（上下文、运行状态、目标与项目事务），一个会话一个目录（与 Desktop 同名）。
   * 必须在任何项目之外：Platform 拒绝放在工作区里的数据目录。
   */
  conversationRuntime: 'conversation-runtime',
  /** 长期记忆（Platform 的记忆库）：一个作用域一个目录的 Markdown，项目按项目根的真实路径各一份。 */
  memory: 'memory',
  /** Agent 浏览器的站点工作区（截图、下载、PDF）：按站点分格，在任何项目之外。 */
  browserSites: 'browser-sites',
} as const

class WorkbenchAppStoragePaths {
  constructor(private readonly dataRootDir: string) {}

  /** 删除撤销副本区（见 {@link WorkbenchStorageDirectory.deleteUndo}）。 */
  public getDeleteUndoDir(): string {
    return this.ensureDir(join(this.dataRootDir, WorkbenchStorageDirectory.deleteUndo))
  }

  public getWorkbenchLocalHistoryDir(): string {
    return this.ensureDir(join(this.dataRootDir, WorkbenchStorageDirectory.localHistory))
  }

  /** 聊天历史备份区（见 {@link WorkbenchStorageDirectory.chatHistoryBackups}）。 */
  public getChatHistoryBackupsDir(): string {
    return this.ensureDir(join(this.dataRootDir, WorkbenchStorageDirectory.chatHistoryBackups))
  }

  /** 「本轮改动」检查点的影子 index 区（见 {@link WorkbenchStorageDirectory.chatCheckpointIndexes}）。 */
  public getChatCheckpointIndexesDir(): string {
    return this.ensureDir(join(this.dataRootDir, WorkbenchStorageDirectory.chatCheckpointIndexes))
  }

  /** 本轮改动记录区（见 {@link WorkbenchStorageDirectory.chatRunChanges}）。 */
  public getChatRunChangesDir(): string {
    return this.ensureDir(join(this.dataRootDir, WorkbenchStorageDirectory.chatRunChanges))
  }

  /** Platform 会话数据区（见 {@link WorkbenchStorageDirectory.conversationRuntime}）。 */
  public getConversationRuntimeDir(): string {
    return this.ensureDir(join(this.dataRootDir, WorkbenchStorageDirectory.conversationRuntime))
  }

  /** Agent 浏览器的站点工作区根（见 {@link WorkbenchStorageDirectory.browserSites}）。 */
  public getBrowserSitesDir(): string {
    return this.ensureDir(join(this.dataRootDir, WorkbenchStorageDirectory.browserSites))
  }

  /** 长期记忆库根目录（见 {@link WorkbenchStorageDirectory.memory}）。 */
  public getMemoryDir(): string {
    return this.ensureDir(join(this.dataRootDir, WorkbenchStorageDirectory.memory))
  }

  private ensureDir(path: string): string {
    mkdirSync(path, { recursive: true })
    return path
  }
}

export { WorkbenchAppStoragePaths }
