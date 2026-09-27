/**
 * 文件树的删除：一律移到系统废纸篓（Electron `shell.trashItem`），那里是找回删除内容的正路。
 *
 * 应用内撤销（⌘Z / Ctrl+Z）只给小东西：删除前量一量，总大小与条目数都在上限内的，
 * 先在数据目录里留一份私有副本，撤销时从副本放回原处（废纸篓里那份不动，由用户自己清）。
 * 大的不留副本、没有应用内撤销，界面告诉用户去废纸篓里找。
 *
 * 撤销记录只在内存里，重启后就对不上了：副本按会话分目录存放，启动时 {@link purgePreviousSessions}
 * 清掉以前会话留下的；本会话里也按总量淘汰最早的副本。
 */
import { randomUUID } from 'node:crypto'
import { cp, lstat, mkdir, readdir, rename, rm } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

import { AppError } from '@velaros-ai/core/error'

/** 把一项移到系统废纸篓：应用里是 Electron 的 `shell.trashItem`，测试换成假的。 */
export type WorkbenchMoveToTrash = (absolutePath: string) => Promise<void>

export interface WorkbenchDeleteUndoLimits {
  /** 一次删除要留副本，总字节数不能超过它。 */
  maxEntryBytes: number
  /** 一次删除要留副本，条目数（目录本身与其中每一项）不能超过它。 */
  maxEntryCount: number
  /** 本会话所有副本加起来的上限：超出时淘汰最早的。 */
  maxTotalBytes: number
  maxRecords: number
}

export const DefaultWorkbenchDeleteUndoLimits: WorkbenchDeleteUndoLimits = {
  maxEntryBytes: 16 * 1024 * 1024,
  maxEntryCount: 2_000,
  maxTotalBytes: 128 * 1024 * 1024,
  maxRecords: 100,
}

export interface WorkbenchDeletedEntry {
  projectRoot: string
  /** 相对工程根的路径（报给界面）。 */
  deletedPath: string
  /** 所在目录，相对工程根。 */
  parentPath: string
  /** 被删的那一项的绝对路径：移到废纸篓的是它，撤销时放回这里。 */
  entryPath: string
}

export interface WorkbenchDeleteUndoRecord extends WorkbenchDeletedEntry {
  id: string
  copyPath: string
  bytes: number
}

const CopyOptions = {
  recursive: true,
  // 链接照原样复制：相对路径的目标不改写成绝对路径，也不跟进去复制目标。
  verbatimSymlinks: true,
  errorOnExist: true,
  force: false,
  preserveTimestamps: true,
} as const

function isCrossDeviceError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'EXDEV'
}

/**
 * 量这一项要不要留副本：总字节数与条目数都在上限内时返回字节数；超了（或有读不了、
 * 复制不了的特殊文件）返回 null。只 lstat，不跟链接；一超就停，不把大目录整个走一遍。
 */
async function measureForUndoCopy(
  entryPath: string,
  limits: WorkbenchDeleteUndoLimits
): Promise<Nullable<number>> {
  let bytes = 0
  let count = 0
  const pending = [entryPath]
  while (pending.length > 0) {
    const current = pending.pop()!
    const stats = await lstat(current).catch(() => null)
    if (!stats) return null

    count += 1
    if (stats.isDirectory()) {
      const names = await readdir(current).catch(() => null)
      if (!names || count + pending.length + names.length > limits.maxEntryCount) return null
      for (const name of names) pending.push(join(current, name))
      continue
    }

    if (!stats.isFile() && !stats.isSymbolicLink()) return null
    bytes += stats.size
    if (bytes > limits.maxEntryBytes) return null
  }
  return bytes
}

export class WorkbenchDeleteUndoStore {
  private readonly sessionId = randomUUID()
  /** 按记下的先后排：淘汰从最早的开始。 */
  private readonly records = new Map<string, WorkbenchDeleteUndoRecord>()
  private totalBytes = 0

  constructor(
    /** 所有会话的副本都在这个目录下，一个会话一个子目录。 */
    private readonly getRootDir: () => string,
    private readonly moveToTrash: WorkbenchMoveToTrash,
    private readonly limits: WorkbenchDeleteUndoLimits = DefaultWorkbenchDeleteUndoLimits
  ) {
    if (typeof moveToTrash !== 'function') {
      throw new AppError('INVARIANT', '删除需要系统废纸篓：没有提供移到废纸篓的方法。')
    }
  }

  /**
   * 把这一项移到系统废纸篓。小的先留一份私有副本，返回撤销记录的 id；没留副本时返回 null
   * （只能去废纸篓里找回）。移不进废纸篓就原样保留并报错——绝不退回成永久删除。
   */
  public async trash(entry: WorkbenchDeletedEntry): Promise<Nullable<string>> {
    const copy = await this.keepCopy(entry.entryPath)
    try {
      await this.moveToTrash(entry.entryPath)
    } catch (error) {
      if (copy) await rm(dirname(copy.copyPath), { recursive: true, force: true })
      throw new AppError(
        'PLATFORM',
        `没能移到系统废纸篓，文件原样保留：${AppError.getMessage(error)}`,
        error
      )
    }

    if (!copy) return null
    this.remember({ ...entry, ...copy })
    return copy.id
  }

  public find(projectRoot: string, id: string): Nullable<WorkbenchDeleteUndoRecord> {
    const record = this.records.get(id)
    return record?.projectRoot === projectRoot ? record : null
  }

  /** 把副本放回原处（调用方已确认那里空着、父目录还在）；放回之后记录与副本一并清掉。 */
  public async restore(record: WorkbenchDeleteUndoRecord): Promise<void> {
    try {
      await rename(record.copyPath, record.entryPath)
    } catch (error) {
      if (!isCrossDeviceError(error)) throw error
      // 数据目录与工程不在同一个卷上：副本本来就小，复制回去再删副本。
      await cp(record.copyPath, record.entryPath, CopyOptions)
    }
    await this.forget(record)
  }

  /** 启动时清掉以前会话留下的副本（撤销记录只在内存里，它们已经没有用了）。 */
  public async purgePreviousSessions(): Promise<void> {
    const rootDir = this.getRootDir()
    const names = await readdir(rootDir).catch(() => [])
    await Promise.all(
      names
        .filter((name) => name !== this.sessionId)
        .map((name) =>
          rm(join(rootDir, name), { recursive: true, force: true }).catch(() => undefined)
        )
    )
  }

  private async keepCopy(
    entryPath: string
  ): Promise<Nullable<Pick<WorkbenchDeleteUndoRecord, 'id' | 'copyPath' | 'bytes'>>> {
    const bytes = await measureForUndoCopy(entryPath, this.limits)
    if (bytes === null) return null

    const id = randomUUID()
    const copyPath = join(this.getRootDir(), this.sessionId, id, basename(entryPath))
    try {
      await mkdir(dirname(copyPath), { recursive: true })
      await cp(entryPath, copyPath, CopyOptions)
      return { id, copyPath, bytes }
    } catch {
      // 复制不成（权限、复制途中变了）就不留副本：删除照常进废纸篓，只是没有应用内撤销。
      await rm(dirname(copyPath), { recursive: true, force: true }).catch(() => undefined)
      return null
    }
  }

  private remember(record: WorkbenchDeleteUndoRecord): void {
    this.records.set(record.id, record)
    this.totalBytes += record.bytes
    for (const oldest of this.records.values()) {
      const withinLimits =
        this.records.size <= this.limits.maxRecords && this.totalBytes <= this.limits.maxTotalBytes
      if (withinLimits || oldest.id === record.id) break
      void this.forget(oldest)
    }
  }

  private async forget(record: WorkbenchDeleteUndoRecord): Promise<void> {
    if (!this.records.delete(record.id)) return
    this.totalBytes -= record.bytes
    await rm(dirname(record.copyPath), { recursive: true, force: true }).catch(() => undefined)
  }
}
