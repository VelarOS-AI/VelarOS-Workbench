/**
 * 每个会话的滚动位置（Desktop chatConversationScrollPositionStore 的对位件）：切走再切回、面板收起
 * 再打开，都回到上次看的位置，而不是一律跳到底。
 *
 * 跟随到底时每来一段流式内容都会写一次，所以先记在内存里、再合并成一次 localStorage 写入；
 * 只保留最近用过的一批会话，数量有界。
 */
const StorageKey = 'velaros.workbench.chat.scroll-position.v1'
const MaxRememberedSessions = 200
const FlushDelayMs = 400

interface StoredScrollPosition {
  scrollTop: number
  updatedAt: number
}

let positions: Map<string, StoredScrollPosition> | null = null
let flushTimer: ReturnType<typeof setTimeout> | null = null

function loadPositions(): Map<string, StoredScrollPosition> {
  if (positions) return positions
  positions = new Map()
  try {
    const raw = globalThis.localStorage?.getItem(StorageKey)
    const value: unknown = raw ? JSON.parse(raw) : null
    if (typeof value === 'object' && value !== null && !Array.isArray(value))
      for (const [sessionId, entry] of Object.entries(value as Record<string, unknown>)) {
        const record = entry as Partial<StoredScrollPosition> | null
        if (
          typeof record?.scrollTop === 'number'
          && Number.isFinite(record.scrollTop)
          && typeof record.updatedAt === 'number'
        )
          positions.set(sessionId, {
            scrollTop: Math.max(0, Math.floor(record.scrollTop)),
            updatedAt: record.updatedAt,
          })
      }
  } catch {
    // 读不到（被清理、格式坏了）就当没有记过位置。
  }
  return positions
}

function scheduleFlush(): void {
  if (flushTimer) return
  flushTimer = setTimeout(() => {
    flushTimer = null
    const entries = [...loadPositions()]
      .sort(([, left], [, right]) => right.updatedAt - left.updatedAt)
      .slice(0, MaxRememberedSessions)
    positions = new Map(entries)
    try {
      globalThis.localStorage?.setItem(StorageKey, JSON.stringify(Object.fromEntries(entries)))
    } catch {
      // 写不进去只是下次回到底部，不影响聊天本身。
    }
  }, FlushDelayMs)
}

export function readStandaloneChatScrollPosition(sessionId: string): number | null {
  return loadPositions().get(sessionId)?.scrollTop ?? null
}

export function saveStandaloneChatScrollPosition(
  sessionId: string,
  scrollTop: number,
  now = Date.now()
): void {
  if (!sessionId) return
  loadPositions().set(sessionId, { scrollTop: Math.max(0, Math.floor(scrollTop)), updatedAt: now })
  scheduleFlush()
}
