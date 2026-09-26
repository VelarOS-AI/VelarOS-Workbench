import type { ChatMessage } from '@shared/contracts'

/**
 * 每轮开跑前拍下的检查点：对话边界 + 项目工作树的 git 影子提交。「本轮改动」拿它与这一轮收尾时的工作树
 * 比对（记录 id 就是检查点 id）；不做回溯。
 */
export interface StandaloneChatCheckpoint {
  readonly id: string
  /** 捕获瞬间 messages 的长度（= 本轮那条用户消息的下标），**永不推进**。 */
  readonly captureMessageCount: number
  readonly createdAt: number
  /** null：项目不是 git 仓库或捕获失败——这一轮没有「本轮改动」。 */
  readonly commitId: string | null
}

/** 单个会话保留的检查点上限；超出时淘汰最旧的（其影子 ref 交由调用方清理）。 */
const MaxRetainedCheckpoints = 80

export function appendStandaloneCheckpoint(
  checkpoints: readonly StandaloneChatCheckpoint[],
  checkpoint: StandaloneChatCheckpoint
): { checkpoints: StandaloneChatCheckpoint[]; evicted: StandaloneChatCheckpoint[] } {
  const combined = [...checkpoints, checkpoint]
  const overflow = Math.max(0, combined.length - MaxRetainedCheckpoints)
  return { checkpoints: combined.slice(overflow), evicted: combined.slice(0, overflow) }
}

export function isStoredStandaloneCheckpoint(value: unknown): value is StandaloneChatCheckpoint {
  return isRecord(value)
    && typeof value.id === 'string'
    && typeof value.captureMessageCount === 'number'
    && Number.isInteger(value.captureMessageCount)
    && value.captureMessageCount >= 0
    && typeof value.createdAt === 'number'
    && (value.commitId === null || typeof value.commitId === 'string')
}

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
