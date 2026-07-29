/**
 * 独立 Workbench 应用的数据区路径服务（desktop `storagePathService` 的最小对位件）。
 *
 * 只承载片1 两个消费点：删除回收站（delete-undo）与本地历史快照区。目录名与 desktop
 * 保持与 Desktop 已发布目录名一致；这两个目录由独立 Workbench 自己拥有。
 * 可直接搬目录。数据根由 main 入口注入（prod=userData，dev=cwd/.data/workbench-app）。
 */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

const WorkbenchStorageDirectory = {
  localHistory: 'workbench-local-history',
  languageGrammars: 'language-grammars',
  /** mod pack 安装根 + 注册表（P6：Workbench 自持 mod 单 owner）。 */
  modPacks: 'mods',
} as const

class WorkbenchAppStoragePaths {
  constructor(private readonly dataRootDir: string) {}

  public getRootDir(): string {
    return this.dataRootDir
  }

  public getWorkbenchLocalHistoryDir(): string {
    return this.ensureDir(join(this.dataRootDir, WorkbenchStorageDirectory.localHistory))
  }

  public getLanguageGrammarsDir(): string {
    return this.ensureDir(join(this.dataRootDir, WorkbenchStorageDirectory.languageGrammars))
  }

  /** mod pack 安装根；扫描此目录的每个子目录取 velaros.mod.json。 */
  public getModPacksDir(): string {
    return this.ensureDir(join(this.dataRootDir, WorkbenchStorageDirectory.modPacks))
  }

  /** mod 注册表（停用位 + 外部原地安装目录）。 */
  public getModRegistryPath(): string {
    return join(this.getModPacksDir(), 'mod-registry.json')
  }

  private ensureDir(path: string): string {
    mkdirSync(path, { recursive: true })
    return path
  }
}

export { WorkbenchAppStoragePaths }
