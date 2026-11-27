import { type ChatMessage } from '@velaros-ai/ui/conversation/contracts'

/**
 * 宿主写的留痕：user role 传输、`system-notice` 语义（目标自动续跑的说明）。`kind` 只决定通知行的图标。
 */
export function createStandaloneSystemNotice(input: {
  id: string
  summary: string
  detail: string
  timestamp: number
  kind?: ChatMessage['systemNoticeKind']
}): ChatMessage {
  return {
    id: input.id,
    role: 'user',
    conversationKind: 'system-notice',
    systemNoticeKind: input.kind,
    blocks: [
      { type: 'text', text: input.summary },
      { type: 'text', text: input.detail },
    ],
    timestamp: input.timestamp,
  }
}
