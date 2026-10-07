import {
  createMemoryStore,
  type MemoryEntry,
  type MemoryRemoved,
  type MemoryScopeApi,
  type MemoryStoreApi,
} from '@velaros-ai/velaros/memory'

/** 一轮运行接的长期记忆作用域，由模型按需召回。 */
export interface ConversationMemory {
  scope: MemoryScopeApi
}

/**
 * 长期记忆（与 Desktop 的记忆服务同一套，Platform ADR 0010）：一个作用域一个目录的 Markdown，模型在对话里用
 * memory.recall / save / remove 读写，按需召回这个作用域的内容。
 *
 * Workbench 只有项目会话：作用域按项目根的真实路径各一份（`project:<路径>`，与 Desktop 项目会话同一分格）。
 * 设置里关掉记忆时一轮都不接，已有的记忆留在盘上。
 */
export interface WorkbenchMemoryServiceApi {
  /** 这一轮运行接的记忆；`workspace` 是项目根的真实路径。 */
  forRun(workspace: string): Promise<ConversationMemory>
  /** 一个项目的全部记忆，最近更新的在前。 */
  listEntries(workspace: string): Promise<MemoryEntry[]>
  /** 删掉一条；本来就没有时 `removed` 为假。 */
  removeEntry(workspace: string, id: string): Promise<MemoryRemoved>
}

export class WorkbenchMemoryService implements WorkbenchMemoryServiceApi {
  private readonly store: MemoryStoreApi

  public constructor(root: string) {
    this.store = createMemoryStore({ root })
  }

  public async forRun(workspace: string): Promise<ConversationMemory> {
    const scope = this.scope(workspace)
    return { scope }
  }

  public listEntries(workspace: string): Promise<MemoryEntry[]> {
    return this.scope(workspace).list()
  }

  public removeEntry(workspace: string, id: string): Promise<MemoryRemoved> {
    return this.scope(workspace).remove({ id })
  }

  private scope(workspace: string): MemoryScopeApi {
    return this.store.scope(`project:${workspace}`)
  }
}
