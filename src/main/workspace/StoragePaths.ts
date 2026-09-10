/**
 * 独立 Workbench 应用的数据区路径服务（desktop `storagePathService` 的最小对位件）。
 *
 * 只承载片1 两个消费点：删除回收站（delete-undo）与本地历史快照区。目录名与 desktop
 * 保持与 Desktop 已发布目录名一致；这两个目录由独立 Workbench 自己拥有。
 * 可直接搬目录。数据根由 main 入口注入（prod=userData，dev=cwd/.velaros/data/workbench-app）。
 */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

const WorkbenchStorageDirectory = {
  localHistory: 'workbench-local-history',
  /**
   * 聊天历史的落盘备份区。**不是会话权威**——权威仍在 renderer 的 localStorage，
   * 这里只兜住「localStorage 被清空或撞配额」的数据丢失。会话权威上收后整个目录可弃。
   */
  chatHistoryBackups: 'chat-history-backups',
  /** 聊天回溯检查点的持久影子 index（每个项目根一份，只是 `git add -A` 的 stat 缓存，可随时删）。 */
  chatCheckpointIndexes: 'chat-checkpoint-indexes',
} as const

class WorkbenchAppStoragePaths {
  constructor(private readonly dataRootDir: string) {}

  public getRootDir(): string {
    return this.dataRootDir
  }

  public getWorkbenchLocalHistoryDir(): string {
    return this.ensureDir(join(this.dataRootDir, WorkbenchStorageDirectory.localHistory))
  }

  /** 聊天历史备份区（见 {@link WorkbenchStorageDirectory.chatHistoryBackups}）。 */
  public getChatHistoryBackupsDir(): string {
    return this.ensureDir(join(this.dataRootDir, WorkbenchStorageDirectory.chatHistoryBackups))
  }

  /** 聊天回溯检查点的影子 index 区（见 {@link WorkbenchStorageDirectory.chatCheckpointIndexes}）。 */
  public getChatCheckpointIndexesDir(): string {
    return this.ensureDir(join(this.dataRootDir, WorkbenchStorageDirectory.chatCheckpointIndexes))
  }

  private ensureDir(path: string): string {
    mkdirSync(path, { recursive: true })
    return path
  }
}

export { WorkbenchAppStoragePaths }
