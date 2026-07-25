/**
 * 工作台本地历史：每次保存把文件内容存一份带时间戳的快照，独立于 Git。
 *
 * 照搬 desktop `workspace/workbench/LocalHistoryStore.ts`；唯一适配：desktop 的模块级
 * 单例依赖 `storagePathService`，独立应用改为构造注入 `WorkbenchAppStoragePaths`
 * （数据根随应用入口而定），快照区布局与裁剪语义保形。
 *
 * 布局：`<workbench-local-history>/<bucket>/{index.json, <id>.snap}`，bucket 由
 * 项目根+文件相对路径哈希得到；index 里 entries 按新→旧排列，超过上限自动裁剪。
 */
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { isNumber, isObject, isString, Log } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'
import type {
  WorkbenchListLocalHistoryResult,
  WorkbenchLocalHistoryEntry,
  WorkbenchReadLocalHistorySnapshotResult,
} from '@velaros-ai/core/types'

import type { WorkbenchAppStoragePaths } from './StoragePaths'

const MAX_SNAPSHOTS_PER_FILE = 50
/** 超过该大小的文件不进入本地历史，避免快照区膨胀。 */
const MAX_SNAPSHOT_CHARS = 2_000_000
const INDEX_FILE_NAME = 'index.json'
const SNAPSHOT_ID_PATTERN = /^[a-z0-9-]+$/

interface StoredLocalHistoryEntry extends WorkbenchLocalHistoryEntry {
  hash: string
}

interface LocalHistoryIndex {
  path: string
  entries: StoredLocalHistoryEntry[]
}

class WorkbenchLocalHistoryStore {
  private readonly log = Log.tag('WorkbenchLocalHistoryStore')

  constructor(private readonly storagePaths: WorkbenchAppStoragePaths) {}

  /**
   * 保存成功后调用：为文件追加一份快照（与上一份相同则跳过）。绝不因失败影响保存。
   *
   * minIntervalMs：节流窗口（毫秒）。距上一份快照不足该间隔则跳过——用户手打的高频自动保存
   * 用它来省内存；AI/工具改动传 0（默认）表示每次都存。
   */
  public capture(
    projectRoot: string,
    path: string,
    content: string,
    options: { minIntervalMs?: number } = {}
  ): void {
    if (content.length > MAX_SNAPSHOT_CHARS) return

    try {
      const bucketDir = this.bucketDir(projectRoot, path)
      const index = this.readIndex(bucketDir, path)
      const hash = this.hashContent(content)
      if (index.entries[0]?.hash === hash) return

      const minIntervalMs = options.minIntervalMs ?? 0
      if (
        minIntervalMs > 0 &&
        index.entries[0] &&
        Date.now() - index.entries[0].savedAt < minIntervalMs
      )
        return

      mkdirSync(bucketDir, { recursive: true })
      const id = this.createSnapshotId()
      writeFileSync(join(bucketDir, `${id}.snap`), content, 'utf8')

      index.path = path
      index.entries.unshift({ id, savedAt: Date.now(), size: content.length, hash })
      this.pruneExcessSnapshots(bucketDir, index)
      writeFileSync(join(bucketDir, INDEX_FILE_NAME), JSON.stringify(index), 'utf8')
    } catch (error) {
      this.log.warn('写入本地历史快照失败', { projectRoot, path, error })
    }
  }

  public list(projectRoot: string, path: string): WorkbenchListLocalHistoryResult {
    const bucketDir = this.bucketDir(projectRoot, path)
    const index = this.readIndex(bucketDir, path)
    const entries: WorkbenchLocalHistoryEntry[] = index.entries.map((entry) => ({
      id: entry.id,
      savedAt: entry.savedAt,
      size: entry.size,
    }))
    return { path, entries }
  }

  public read(
    projectRoot: string,
    path: string,
    id: string
  ): WorkbenchReadLocalHistorySnapshotResult {
    if (!SNAPSHOT_ID_PATTERN.test(id)) {
      throw new AppError('VALIDATION', '无效的本地历史快照标识。')
    }

    const snapshotPath = join(this.bucketDir(projectRoot, path), `${id}.snap`)
    if (!existsSync(snapshotPath)) {
      throw new AppError('NOT_FOUND', '本地历史快照不存在或已被清理。')
    }

    return { path, id, content: readFileSync(snapshotPath, 'utf8') }
  }

  private pruneExcessSnapshots(bucketDir: string, index: LocalHistoryIndex): void {
    if (index.entries.length <= MAX_SNAPSHOTS_PER_FILE) return

    const removed = index.entries.splice(MAX_SNAPSHOTS_PER_FILE)
    for (const entry of removed) {
      try {
        rmSync(join(bucketDir, `${entry.id}.snap`), { force: true })
      } catch (error) {
        this.log.warn('清理过期本地历史快照失败', { id: entry.id, error })
      }
    }
  }

  private readIndex(bucketDir: string, path: string): LocalHistoryIndex {
    const indexPath = join(bucketDir, INDEX_FILE_NAME)
    if (!existsSync(indexPath)) return { path, entries: [] }

    try {
      const parsed = JSON.parse(readFileSync(indexPath, 'utf8')) as Partial<LocalHistoryIndex>
      const entries = Array.isArray(parsed.entries)
        ? parsed.entries.filter(
            (entry): entry is StoredLocalHistoryEntry =>
              isObject(entry) && isString(entry.id) && isNumber(entry.savedAt)
          )
        : []
      return { path, entries }
    } catch (error) {
      this.log.warn('读取本地历史索引失败，按空历史处理', { path, error })
      return { path, entries: [] }
    }
  }

  private bucketDir(projectRoot: string, path: string): string {
    const key = createHash('sha1').update(`${projectRoot}\u0000${path}`).digest('hex')
    return join(this.storagePaths.getWorkbenchLocalHistoryDir(), key)
  }

  private hashContent(content: string): string {
    return createHash('sha1').update(content).digest('hex')
  }

  private createSnapshotId(): string {
    return `${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`
  }
}

export { WorkbenchLocalHistoryStore }
