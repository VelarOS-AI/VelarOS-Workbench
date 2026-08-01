/**
 * 最近项目持久化——独立 Workbench 应用自己的数据根，不复用 Desktop chat 存储。
 *
 * 形态：`<dataRoot>/storage/recent-projects.json` 单文件，version 1，按 lastOpenedAt 降序，
 * 上限 12 条。读取宽容（损坏条目丢弃、整文件损坏视为空），写入先写临时文件再原子 rename。
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export interface RecentProjectEntry {
  path: string
  name: string
  lastOpenedAt: number
}

interface RecentProjectsFile {
  version: number
  entries: RecentProjectEntry[]
}

const RecentProjectsFileVersion = 1
const MaxRecentProjects = 12

export class RecentProjectsStore {
  private readonly filePath: string
  private entries: RecentProjectEntry[]

  constructor(dataRootDir: string) {
    this.filePath = join(dataRootDir, 'storage', 'recent-projects.json')
    this.entries = readRecentProjectEntries(this.filePath)
  }

  public list(): RecentProjectEntry[] {
    return [...this.entries]
  }

  /** 打开（或创建）项目后置顶该条目并落盘；同路径去重，超上限从尾部裁掉。 */
  public touch(entry: RecentProjectEntry): void {
    this.entries = [
      entry,
      ...this.entries.filter((existing) => existing.path !== entry.path),
    ].slice(0, MaxRecentProjects)
    this.persist()
  }

  public remove(path: string): void {
    const next = this.entries.filter((existing) => existing.path !== path)
    if (next.length === this.entries.length) return

    this.entries = next
    this.persist()
  }

  private persist(): void {
    const file: RecentProjectsFile = {
      version: RecentProjectsFileVersion,
      entries: this.entries,
    }

    try {
      mkdirSync(dirname(this.filePath), { recursive: true })
      const temporaryPath = `${this.filePath}.tmp`
      writeFileSync(temporaryPath, `${JSON.stringify(file, null, 2)}\n`, 'utf8')
      renameSync(temporaryPath, this.filePath)
    } catch (error) {
      console.error('[workbench-app] failed to persist recent projects', error)
    }
  }
}

function readRecentProjectEntries(filePath: string): RecentProjectEntry[] {
  let raw: string
  try {
    raw = readFileSync(filePath, 'utf8')
  } catch {
    return []
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }

  if (typeof parsed !== 'object' || parsed === null) return []

  const entries = (parsed as Partial<RecentProjectsFile>).entries
  if (!Array.isArray(entries)) return []

  return entries
    .map((entry) => parseRecentProjectEntry(entry))
    .filter((entry): entry is RecentProjectEntry => entry !== null)
    .slice(0, MaxRecentProjects)
}

function parseRecentProjectEntry(value: unknown): Nullable<RecentProjectEntry> {
  if (typeof value !== 'object' || value === null) return null

  const candidate = value as Partial<RecentProjectEntry>
  if (typeof candidate.path !== 'string' || candidate.path.length === 0) return null
  if (typeof candidate.name !== 'string' || candidate.name.length === 0) return null
  if (typeof candidate.lastOpenedAt !== 'number' || !Number.isFinite(candidate.lastOpenedAt)) return null

  return {
    path: candidate.path,
    name: candidate.name,
    lastOpenedAt: candidate.lastOpenedAt,
  }
}
