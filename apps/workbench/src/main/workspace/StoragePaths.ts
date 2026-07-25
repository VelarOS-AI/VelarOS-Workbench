/**
 * 独立 Workbench 应用的数据区路径服务（desktop `storagePathService` 的最小对位件）。
 *
 * 只承载片1 两个消费点：删除回收站（delete-undo）与本地历史快照区。目录名与 desktop
 * 保持一致（`@velaros-ai/core/constants/storage` 的 StoragePaths 单源），未来若数据迁移
 * 可直接搬目录。数据根由 main 入口注入（prod=userData，dev=cwd/.data/workbench-app）。
 */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

import { StoragePaths } from '@velaros-ai/core/constants/storage'

class WorkbenchAppStoragePaths {
  constructor(private readonly dataRootDir: string) {}

  public getRootDir(): string {
    return this.dataRootDir
  }

  public getWorkbenchLocalHistoryDir(): string {
    return this.ensureDir(join(this.dataRootDir, StoragePaths.WORKBENCH_LOCAL_HISTORY_DIR))
  }

  public getLanguageGrammarsDir(): string {
    return this.ensureDir(join(this.dataRootDir, StoragePaths.LANGUAGE_GRAMMARS_DIR))
  }

  private ensureDir(path: string): string {
    mkdirSync(path, { recursive: true })
    return path
  }
}

export { WorkbenchAppStoragePaths }
