import { mkdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'

import type {
  ActiveContextArtifact,
  ActiveContextArtifactKind,
  ActiveContextArtifactStatus,
  ActiveContextListOptions,
  ActiveContextUpsertInput,
} from '@velaros-ai/agent/protocol'
import { AppError } from '@velaros-ai/core/error'
import { writeJsonFileAtomically } from '@velaros-ai/core/utils/FilePersistence'

const StoreFileVersion = 1
/** 会话 id 直接当文件名用，只收保守字符。 */
const SessionFileNamePattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/u
const ArtifactKinds = new Set<unknown>(['plan', 'decision', 'requirement'])
const ArtifactStatuses = new Set<unknown>(['active', 'completed', 'archived'])

interface StoredActiveContextFile {
  version: typeof StoreFileVersion
  artifacts: ActiveContextArtifact[]
}

/** Agent 工具读写活动上下文的端口（工具上下文的 `activeContext` 面）。 */
export interface WorkbenchActiveContextPort {
  listActiveContextArtifacts(options?: ActiveContextListOptions): Promise<ActiveContextArtifact[]>
  upsertActiveContextArtifact(input: ActiveContextUpsertInput): Promise<ActiveContextArtifact>
}

/**
 * 会话的活动上下文制品：目标模式的目标、`plan:update` 写下的执行计划。它们要跨轮、跨压缩一直在场，
 * 目标卡也从这里读。
 *
 * 是 Desktop `ActiveContextStore` 的 list / upsert 子集，id 与合并规则逐条对齐（没有治理建议那一面）。
 * 每个会话一个 JSON 文件，同一会话的写入排队执行；不给目录（探针、测试）时只放内存。
 */
export class WorkbenchActiveContextStore {
  private readonly loaded = new Map<string, ActiveContextArtifact[]>()
  private readonly sessionQueues = new Map<string, Promise<unknown>>()

  constructor(private readonly directory: (() => string) | null = null) {}

  public forSession(sessionId: string): WorkbenchActiveContextPort {
    return {
      listActiveContextArtifacts: (options) => this.list(sessionId, options),
      upsertActiveContextArtifact: (input) => this.upsert(sessionId, input),
    }
  }

  /** 与 Desktop 同一口径：默认只列 active，按创建时间排。 */
  public async list(
    sessionId: string,
    options: ActiveContextListOptions = {}
  ): Promise<ActiveContextArtifact[]> {
    const status = options.status ?? 'active'
    const kinds = new Set(options.kinds ?? [])
    const resourceId = options.resourceId?.trim() || null
    return (await this.load(sessionId))
      .filter((artifact) => status === 'all' || artifact.status === status)
      .filter((artifact) => kinds.size === 0 || kinds.has(artifact.kind))
      .filter(
        (artifact) =>
          !resourceId || artifact.scope !== 'workspace' || artifact.resourceId === resourceId
      )
      .sort((left, right) => left.createdAt - right.createdAt)
  }

  /** 新增或覆盖一条制品：同一职责的条目（同 id）原位更新，字段缺省时沿用已有值。 */
  public upsert(sessionId: string, input: ActiveContextUpsertInput): Promise<ActiveContextArtifact> {
    return this.serialize(sessionId, async () => {
      const artifacts = await this.load(sessionId)
      const now = Date.now()
      const id = resolveArtifactId(input, sessionId)
      const existing = artifacts.find((artifact) => artifact.id === id) ?? null
      const title = input.title.trim()
      const content = input.content.trim()
      if (!title || !content) throw new AppError('VALIDATION', '活动上下文条目无效。')
      const artifact: ActiveContextArtifact = {
        id,
        kind: input.kind,
        scope: input.scope ?? existing?.scope ?? 'session',
        status: input.status ?? existing?.status ?? 'active',
        sessionId,
        resourceId: input.resourceId?.trim() || existing?.resourceId || null,
        title,
        content,
        sourceMessageId: input.sourceMessageId?.trim() || existing?.sourceMessageId || null,
        metadata: input.metadata ?? existing?.metadata ?? {},
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      }
      const next = existing
        ? artifacts.map((candidate) => (candidate === existing ? artifact : candidate))
        : [...artifacts, artifact]
      await this.save(sessionId, next)
      return artifact
    })
  }

  /** 会话被移除时一并删掉它的制品。 */
  public deleteSession(sessionId: string): Promise<void> {
    return this.serialize(sessionId, async () => {
      const file = this.sessionFile(sessionId)
      if (file) await rm(file, { force: true })
      this.loaded.delete(sessionId)
    })
  }

  private async load(sessionId: string): Promise<ActiveContextArtifact[]> {
    const cached = this.loaded.get(sessionId)
    if (cached) return cached
    const file = this.sessionFile(sessionId)
    const artifacts = file ? await readStoredArtifacts(file, sessionId) : []
    // 读盘期间可能已有写入落进缓存；以缓存为准。
    const current = this.loaded.get(sessionId)
    if (current) return current
    this.loaded.set(sessionId, artifacts)
    return artifacts
  }

  private async save(sessionId: string, artifacts: ActiveContextArtifact[]): Promise<void> {
    const file = this.sessionFile(sessionId)
    if (file) {
      await mkdir(this.directory!(), { recursive: true })
      await writeJsonFileAtomically<StoredActiveContextFile>(file, {
        version: StoreFileVersion,
        artifacts,
      })
    }
    this.loaded.set(sessionId, artifacts)
  }

  private sessionFile(sessionId: string): string | null {
    if (!SessionFileNamePattern.test(sessionId)) throw new AppError('VALIDATION', '无效的会话 id。')
    return this.directory ? join(this.directory(), `${sessionId}.json`) : null
  }

  private serialize<T>(sessionId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.sessionQueues.get(sessionId) ?? Promise.resolve()
    const next = previous.catch(() => undefined).then(task)
    const settled = next.catch(() => undefined)
    this.sessionQueues.set(sessionId, settled)
    void settled.then(() => {
      if (this.sessionQueues.get(sessionId) === settled) this.sessionQueues.delete(sessionId)
    })
    return next
  }
}

/** 没有显式 id 时按 kind + scope + 会话（或工作区）生成稳定 id：同一职责的条目覆盖而不重复插入。 */
function resolveArtifactId(input: ActiveContextUpsertInput, sessionId: string): string {
  const explicitId = input.id?.trim()
  if (explicitId) return explicitId
  const scope = input.scope ?? 'session'
  const workspaceKey = input.resourceId?.trim()
    ? input.resourceId.trim().toLowerCase().replace(/[^a-z0-9]+/gu, '-')
    : 'session'
  return `${input.kind}:${scope}:${scope === 'workspace' ? workspaceKey : sessionId}`
}

/** 文件是外来数据：读不到、形状不对的条目一律丢掉，不让一条坏数据拖垮整个会话。 */
async function readStoredArtifacts(
  file: string,
  sessionId: string
): Promise<ActiveContextArtifact[]> {
  let value: unknown
  try {
    value = JSON.parse(await readFile(file, 'utf8'))
  } catch {
    return []
  }
  if (!isPlainRecord(value) || value.version !== StoreFileVersion || !Array.isArray(value.artifacts))
    return []
  return value.artifacts.flatMap((candidate): ActiveContextArtifact[] => {
    if (!isPlainRecord(candidate)) return []
    const { id, kind, scope, status, title, content, createdAt, updatedAt } = candidate
    if (
      typeof id !== 'string' || !id.trim()
      || !ArtifactKinds.has(kind)
      || typeof scope !== 'string' || !scope.trim()
      || !ArtifactStatuses.has(status)
      || typeof title !== 'string' || !title.trim()
      || typeof content !== 'string' || !content.trim()
    )
      return []
    return [{
      id,
      kind: kind as ActiveContextArtifactKind,
      scope,
      status: status as ActiveContextArtifactStatus,
      sessionId,
      resourceId: typeof candidate.resourceId === 'string' ? candidate.resourceId : null,
      title,
      content,
      sourceMessageId:
        typeof candidate.sourceMessageId === 'string' ? candidate.sourceMessageId : null,
      metadata: isPlainRecord(candidate.metadata) ? candidate.metadata : {},
      createdAt: typeof createdAt === 'number' ? createdAt : 0,
      updatedAt: typeof updatedAt === 'number' ? updatedAt : 0,
    }]
  })
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
