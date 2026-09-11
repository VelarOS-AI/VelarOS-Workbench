import { createConversationScrollPositionStore } from '@velaros-ai/ui/conversation'

/**
 * 每个会话的滚动位置——与 Desktop 同一个实现（UI 包 `createConversationScrollPositionStore`）：
 * 切走再切回、面板收起再打开，都回到上次看的位置，而不是一律跳到底。跟随到底时每来一段流式
 * 内容都会写一次，先记在内存里、合并成一次 localStorage 写入；只保留最近用过的一批会话。
 */
const standaloneChatScrollPositions = createConversationScrollPositionStore({
  storageKey: 'velaros.workbench.chat.scroll-position.v1',
})

export function readStandaloneChatScrollPosition(sessionId: string): number | null {
  return standaloneChatScrollPositions.read(sessionId)
}

export function saveStandaloneChatScrollPosition(sessionId: string, scrollTop: number): void {
  standaloneChatScrollPositions.save(sessionId, scrollTop)
}
