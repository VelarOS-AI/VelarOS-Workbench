import {
  ChatContextRetrievalService,
  type ContextGovernanceSessionRegistry,
  type ContextPayloadRecord,
  type ContextPayloadStore,
  type ToolConversationContextApi,
} from '@velaros-ai/agent'
import type {
  ChatSessionPayloadSnapshot,
  ChatSessionToolResultPayload,
} from '@velaros-ai/agent/protocol'

/**
 * Workbench 的上下文召回（`context:recall`）。
 *
 * Platform 的循环在工具结果过大时把原文页出成「摘要 + 可召回句柄」，模型要细看时调 `context:recall`
 * 取回；出核前的地板也要求「请求里出现句柄就必须带着 `context:recall`」——少了它，主 Agent 或子 Agent
 * 读到一个大文件之后的下一次请求会被直接拦下。Desktop 有落盘的会话存储；Workbench 没有，这里给一份
 * 主进程内存里的实现：页出的原文按会话记着（有上限，最旧的先丢），召回服务从同一份里取。
 * 重启后旧句柄取不回，召回会如实报「未找到」，模型改用 project:read 重新读。
 */

/** 最多记这么多条页出的原文、这么多字符；超了从最旧的丢。 */
const MaxStoredPayloads = 400
const MaxStoredChars = 32 * 1024 * 1024

function storeKey(sessionId: string, hash: string): string {
  return `${sessionId}\0${hash}`
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
 * 同一份内存同时满足两头：执行器页出时写（`ContextPayloadStore`），召回服务读
 * （`RetrievalPayloadStorePort` 的 `loadSessionPayloads` / `loadToolPayload`）。
 */
export class WorkbenchContextPayloadStore implements ContextPayloadStore {
  /** 插入顺序即新旧顺序：再次写入同一条会挪到最后。 */
  private readonly records = new Map<string, ContextPayloadRecord>()
  private storedChars = 0

  public async findByHash(sessionId: string, hash: string): Promise<Nullable<ContextPayloadRecord>> {
    return this.records.get(storeKey(sessionId, hash)) ?? null
  }

  public async findManyByHash(
    sessionId: string,
    hashes: readonly string[]
  ): Promise<Map<string, ContextPayloadRecord>> {
    const found = new Map<string, ContextPayloadRecord>()
    for (const hash of new Set(hashes)) {
      const record = this.records.get(storeKey(sessionId, hash))
      if (record) found.set(hash, record)
    }
    return found
  }

  public async put(record: ContextPayloadRecord): Promise<ContextPayloadRecord> {
    const key = storeKey(record.sessionId, record.hash)
    const previous = this.records.get(key)
    if (previous) {
      this.records.delete(key)
      this.storedChars -= previous.serializedResult.length
    }
    this.records.set(key, record)
    this.storedChars += record.serializedResult.length
    this.evictOverflow()
    return record
  }

  public async putMany(records: readonly ContextPayloadRecord[]): Promise<ContextPayloadRecord[]> {
    const stored: ContextPayloadRecord[] = []
    for (const record of records) stored.push(await this.put(record))
    return stored
  }

  public async listForSession(sessionId: string): Promise<ContextPayloadRecord[]> {
    return [...this.records.values()].filter((record) => record.sessionId === sessionId)
  }

  /** 召回的全量扫描口：这个会话页出过的原文，按句柄（payloadRef）排开。 */
  public async loadSessionPayloads(sessionId: string): Promise<ChatSessionPayloadSnapshot> {
    const toolResults: Record<string, ChatSessionToolResultPayload> = {}
    for (const record of await this.listForSession(sessionId))
      toolResults[record.payloadRef] = toToolResultPayload(record)
    return { sessionId, userMessages: {}, assistantMessages: {}, toolResults }
  }

  /**
   * 召回的直读口：`key` 是句柄（`ctx-payload:*`）或工具调用 id。句柄与调用 id 本身就全局唯一，
   * 所以不按会话过滤——子 Agent 页出时记的是它自己的会话键，召回时带的却可能是主会话。
   */
  public async loadToolPayload(
    _sessionId: string,
    key: string
  ): Promise<Nullable<ChatSessionToolResultPayload>> {
    const toolCallId = key.startsWith('tool:') ? key.slice('tool:'.length) : key
    let match: Nullable<ContextPayloadRecord> = null
    for (const record of this.records.values())
      if (record.payloadRef === key || record.toolCallId === toolCallId) match = record
    return match ? toToolResultPayload(match) : null
  }

  private evictOverflow(): void {
    for (const [key, record] of this.records) {
      if (this.records.size <= MaxStoredPayloads && this.storedChars <= MaxStoredChars) return
      this.records.delete(key)
      this.storedChars -= record.serializedResult.length
    }
  }
}

export interface WorkbenchContextRecall {
  readonly payloadStore: WorkbenchContextPayloadStore
  /** 一轮执行的会话口；召回请求一律落到发起这一轮的会话与执行范围上。 */
  conversationFor(input: { sessionId: string; executionId: string }): ToolConversationContextApi
}

export function createWorkbenchContextRecall(
  governanceSessions: ContextGovernanceSessionRegistry
): WorkbenchContextRecall {
  const payloadStore = new WorkbenchContextPayloadStore()
  const service = new ChatContextRetrievalService(
    payloadStore,
    // 会话消息与检索索引不在主进程：历史搜索如实返回空，取回页出的原文不受影响。
    { loadSessionMessages: async () => [], loadSessionMessage: async () => null },
    governanceSessions,
    { loadFresh: async () => null, save: async () => {} }
  )
  return {
    payloadStore,
    conversationFor: ({ sessionId, executionId }) => {
      const scope = { sessionId, retrievalScopeId: executionId }
      return {
        retrieveContextPayload: (input) => service.retrieveContextPayload({ ...input, ...scope }),
        searchConversationHistory: (input) => service.searchConversationHistory({ ...input, ...scope }),
        readEvidence: (input) => service.readEvidence({ ...input, ...scope }),
        readToolPayload: (input) => service.readToolPayload({ ...input, ...scope }),
        searchTerminalOutput: (input) => service.searchTerminalOutput({ ...input, ...scope }),
      }
    },
  }
}
