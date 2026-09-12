import { useEffect, useState } from 'react'

import type { WorkbenchChatRunChangesRecord } from '@shared/workbenchGit'

/**
 * 「本轮改动」记录的读取口：回答末尾的改动卡、左侧「AI 改动」面板和改动对比标签页读的是同一份记录。
 *
 * 补丁全文在主进程数据区的记录文件里（不进 localStorage），这里只在内存里留最近读过的几份：会话列表
 * 是虚拟滚动的，卡片滚出去再回来、面板收起再展开，都不必重读磁盘。同一份记录同时被几处要时只读一次。
 *
 * 还在跑的一轮会被反复采集、覆盖同一条记录。读的一方带上摘要里的采集时刻（`capturedAt`，即记录的
 * 版本）：缓存里那份比它旧就作废重读，重读期间仍显示旧的那份，不闪成「读取中」。
 */
const RecordCacheLimit = 24
const BaseFileCacheLimit = 16

const recordCache = new Map<string, WorkbenchChatRunChangesRecord>()
const recordRequests = new Map<string, Promise<WorkbenchChatRunChangesRecord | null>>()
const baseFileCache = new Map<string, string | null>()

function remember<T>(cache: Map<string, T>, key: string, value: T, limit: number): void {
  cache.delete(key)
  cache.set(key, value)
  const oldest = cache.keys().next()
  if (cache.size > limit && !oldest.done) cache.delete(oldest.value)
}

function recall<T>(cache: Map<string, T>, key: string): T | undefined {
  if (!cache.has(key)) return undefined
  const value = cache.get(key) as T
  cache.delete(key)
  cache.set(key, value)
  return value
}

function recordKey(projectRoot: string, sessionId: string, recordId: string): string {
  return `${projectRoot}\0${sessionId}\0${recordId}`
}

/** 缓存里不比 `capturedAt` 旧的那份记录。 */
function recallFresh(key: string, capturedAt: number): WorkbenchChatRunChangesRecord | undefined {
  const cached = recall(recordCache, key)
  return cached && cached.capturedAt >= capturedAt ? cached : undefined
}

/**
 * 读一轮的改动记录（不旧于 `capturedAt` 那次采集）；记录不在（已清理、这一轮没改文件）或读失败时为
 * null。
 */
export function readWorkbenchRunChangeRecord(
  projectRoot: string,
  sessionId: string,
  recordId: string,
  capturedAt: number
): Promise<WorkbenchChatRunChangesRecord | null> {
  const key = recordKey(projectRoot, sessionId, recordId)
  const cached = recallFresh(key, capturedAt)
  if (cached) return Promise.resolve(cached)
  const requestKey = `${key}\0${capturedAt}`
  const inFlight = recordRequests.get(requestKey)
  if (inFlight) return inFlight

  const request = window.velarosWorkbenchGit
    .readChatRunChanges({ workspaceRoot: projectRoot, sessionId, recordId })
    .then(
      (result) => {
        const record = result.ok ? result.value : null
        // 先发后到的旧读取不能把缓存里更新的那份换下去。
        if (record && record.capturedAt >= (recordCache.get(key)?.capturedAt ?? 0))
          remember(recordCache, key, record, RecordCacheLimit)
        return record
      },
      () => null
    )
    .finally(() => recordRequests.delete(requestKey))
  recordRequests.set(requestKey, request)
  return request
}

/** 这一轮改动前这个文件的全文（按记录里的起点提交读）；读不到时为 null，查看器退回只看补丁。 */
export async function readWorkbenchRunChangeBaseFile(
  projectRoot: string,
  sessionId: string,
  recordId: string,
  path: string
): Promise<string | null> {
  const key = `${recordKey(projectRoot, sessionId, recordId)}\0${path}`
  const cached = recall(baseFileCache, key)
  if (cached !== undefined) return cached
  const result = await window.velarosWorkbenchGit
    .readChatRunChangeBaseFile({ workspaceRoot: projectRoot, sessionId, recordId, path })
    .catch(() => null)
  const content = result?.ok ? result.value.content : null
  if (result?.ok) remember(baseFileCache, key, content, BaseFileCacheLimit)
  return content
}

interface RecordLoad {
  readonly key: string
  readonly record: WorkbenchChatRunChangesRecord | null
}

/**
 * 按记录 id 读一轮改动；recordId 为 null 时什么都不读。`capturedAt` 变了（这一轮又采了一次）就重读，
 * 新的一份到之前照旧给出手上这份。
 */
export function useWorkbenchRunChangeRecord(
  projectRoot: string,
  sessionId: string,
  recordId: string | null,
  capturedAt: number
): { record: WorkbenchChatRunChangesRecord | null; loading: boolean; failed: boolean } {
  const key = recordId ? recordKey(projectRoot, sessionId, recordId) : null
  const [load, setLoad] = useState<RecordLoad | null>(() => {
    const cached = key ? recallFresh(key, capturedAt) : undefined
    return key && cached ? { key, record: cached } : null
  })

  useEffect(() => {
    if (!key || !recordId) return undefined
    let cancelled = false
    void readWorkbenchRunChangeRecord(projectRoot, sessionId, recordId, capturedAt).then((record) => {
      if (!cancelled) setLoad({ key, record })
    })
    return () => {
      cancelled = true
    }
  }, [capturedAt, key, projectRoot, recordId, sessionId])

  const current = load?.key === key ? load : null
  return {
    record: current?.record ?? null,
    loading: !!key && !current,
    failed: !!current && !current.record,
  }
}
