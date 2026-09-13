import type { ContextPayloadRecord, ContextPayloadStore } from '@velaros-ai/agent'
import type {
  ChatSessionPayloadSnapshot,
  ChatSessionToolResultPayload,
} from '@velaros-ai/agent/protocol'

import { WorkbenchContextPayloadDiskStore } from './WorkbenchContextPayloadDiskStore'

/** 内存缓存上限；生产环境淘汰后仍可从磁盘召回。 */
const MaxStoredPayloads = 400
const MaxStoredChars = 32 * 1024 * 1024

function storeKey(sessionId: string, hash: string): string {
  return JSON.stringify([sessionId, hash])
}

function toToolResultPayload(record: ContextPayloadRecord): ChatSessionToolResultPayload {
  return {
    serializedResult: record.serializedResult,
    displayResult: null,
    toolCallId: record.toolCallId,
    toolName: record.toolName,
    payloadRef: record.payloadRef,
    hash: record.hash,
  }
}

/**
 * 执行器等待原文持久化后再继续；召回服务与执行器使用同一份存储
 * （`RetrievalPayloadStorePort` 的 `loadSessionPayloads` / `loadToolPayload`）。
 */
export class WorkbenchContextPayloadStore implements ContextPayloadStore {
  /** 插入顺序即新旧顺序：再次写入同一条会挪到最后。 */
  private readonly records = new Map<string, ContextPayloadRecord>()
  private storedChars = 0
  private pending: Promise<unknown> = Promise.resolve()
  private readonly disk: WorkbenchContextPayloadDiskStore | null

  constructor(directory: (() => string) | null = null) {
    this.disk = directory ? new WorkbenchContextPayloadDiskStore(directory) : null
  }

  private serialize<T>(task: () => Promise<T>): Promise<T> {
    const next = this.pending.then(task, task)
    this.pending = next.then(
      () => undefined,
      () => undefined,
    )
    return next
  }

  public deleteSession(sessionId: string): Promise<void> {
    return this.serialize(async () => {
      // Evict even if on-disk cleanup fails; never retain deleted data in the cache.
      for (const [key, record] of this.records) {
        if (record.sessionId !== sessionId) continue
        this.records.delete(key)
        this.storedChars -= record.serializedResult.length
      }
      await this.disk?.deleteSession(sessionId)
    })
  }

  public findByHash(sessionId: string, hash: string): Promise<Nullable<ContextPayloadRecord>> {
    return this.serialize(() => this.readByHash(sessionId, hash))
  }

  private async readByHash(sessionId: string, hash: string): Promise<ContextPayloadRecord | null> {
    const cached = this.records.get(storeKey(sessionId, hash))
    if (cached) return { ...cached }
    const stored = await this.disk?.read(sessionId, hash)
    if (!stored) return null
    this.cache(stored)
    return { ...stored }
  }

  public findManyByHash(
    sessionId: string,
    hashes: readonly string[],
  ): Promise<Map<string, ContextPayloadRecord>> {
    return this.serialize(async () => {
      const found = new Map<string, ContextPayloadRecord>()
      for (const hash of new Set(hashes)) {
        const record = await this.readByHash(sessionId, hash)
        if (record) found.set(hash, record)
      }
      return found
    })
  }

  public put(record: ContextPayloadRecord): Promise<ContextPayloadRecord> {
    return this.serialize(() => this.save(record))
  }

  private async save(record: ContextPayloadRecord): Promise<ContextPayloadRecord> {
    const copy = { ...record, chars: record.serializedResult.length }
    const stored = this.disk ? await this.disk.write(copy) : copy
    this.cache(stored)
    return { ...stored }
  }

  private cache(record: ContextPayloadRecord): void {
    const key = storeKey(record.sessionId, record.hash)
    const previous = this.records.get(key)
    if (previous) {
      this.records.delete(key)
      this.storedChars -= previous.serializedResult.length
    }
    this.records.set(key, { ...record })
    this.storedChars += record.serializedResult.length
    this.evictOverflow()
  }

  public putMany(records: readonly ContextPayloadRecord[]): Promise<ContextPayloadRecord[]> {
    return this.serialize(async () => {
      const stored: ContextPayloadRecord[] = []
      for (const record of records) stored.push(await this.save(record))
      return stored
    })
  }

  public listForSession(sessionId: string): Promise<ContextPayloadRecord[]> {
    return this.serialize(async () =>
      this.disk
        ? this.disk.list(sessionId)
        : [...this.records.values()]
            .filter((record) => record.sessionId === sessionId)
            .map((record) => ({ ...record })),
    )
  }

  /** 召回的全量扫描口：这个会话页出过的原文，按句柄（payloadRef）排开。 */
  public async loadSessionPayloads(sessionId: string): Promise<ChatSessionPayloadSnapshot> {
    const toolResults: Record<string, ChatSessionToolResultPayload> = {}
    for (const record of await this.listForSession(sessionId))
      toolResults[record.payloadRef] = toToolResultPayload(record)
    return { sessionId, userMessages: {}, assistantMessages: {}, toolResults }
  }

  /**
   * 召回的直读口：`key` 是句柄（`ctx-payload:*`）或工具调用 id。优先匹配当前会话，
   * 完整 payloadRef 可以明确指向其他会话；调用 id 始终限定在当前会话。
   */
  public async loadToolPayload(
    sessionId: string,
    key: string,
  ): Promise<Nullable<ChatSessionToolResultPayload>> {
    return this.serialize(async () => {
      const toolCallId = key.startsWith('tool:') ? key.slice('tool:'.length) : key
      let match: Nullable<ContextPayloadRecord> = null
      // Durable reference lookup is authoritative, including after cache eviction or restart.
      if (this.disk) match = await this.disk.lookup(toolCallId, sessionId)
      else
        for (const record of this.records.values())
          if (
            record.payloadRef === key ||
            (record.sessionId === sessionId && record.toolCallId === toolCallId)
          ) {
            if (!match || record.sessionId === sessionId) match = record
          }
      return match ? toToolResultPayload(match) : null
    })
  }

  private evictOverflow(): void {
    for (const [key, record] of this.records) {
      if (this.records.size <= MaxStoredPayloads && this.storedChars <= MaxStoredChars) return
      this.records.delete(key)
      this.storedChars -= record.serializedResult.length
    }
  }
}
