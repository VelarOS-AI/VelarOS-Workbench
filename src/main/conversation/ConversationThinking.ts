import {
  ConversationThinkingMaxChars,
  type ConversationThinkingProjection,
} from '../../shared/workbenchConversation'

/** 同一次运行里两次思考快照至少隔多久，毫秒。 */
const ThinkingPublishIntervalMs = 150

interface ThinkingSegment {
  runId: string
  text: string
  /** 已经发出去的长度；没有新内容就不发。 */
  delivered: number
}

/**
 * 一次运行里每个模型回合的思考摘要。思考逐字到达，每个增量都整段落盘、下发太重：这里按回合累积全文，
 * 节流后整段发出，渲染层直接替换，恢复重放幂等。一个回合的第一段思考立即发出；之后最多每 150 毫秒
 * 发一次。别的事件发出前先调 flush 把欠的发掉，思考块因此排在同一回合的正文和脚本卡前面。
 */
export class ConversationThinkingBoard {
  private readonly segments = new Map<string, ThinkingSegment>()
  private timer?: ReturnType<typeof setTimeout>
  private publishedAt = 0

  public constructor(private readonly emit: (projection: ConversationThinkingProjection) => void) {}

  /** 这一回合又到了一段思考。 */
  public append(turnId: string, runId: string, text: string): void {
    const segment = this.segments.get(turnId) ?? { runId, text: '', delivered: 0 }
    this.segments.set(turnId, segment)
    if (segment.text.length >= ConversationThinkingMaxChars) return
    segment.text = (segment.text + text).slice(0, ConversationThinkingMaxChars)
    if (segment.delivered === 0) {
      this.flush()
      return
    }
    this.timer ??= setTimeout(
      () => this.flush(),
      Math.max(0, this.publishedAt + ThinkingPublishIntervalMs - Date.now())
    )
  }

  /** 把还没发出的思考全部发出。 */
  public flush(): void {
    clearTimeout(this.timer)
    this.timer = undefined
    for (const [turnId, segment] of this.segments) {
      if (segment.delivered === segment.text.length) continue
      segment.delivered = segment.text.length
      this.publishedAt = Date.now()
      this.emit({
        id: thinkingId(segment.runId, turnId),
        runId: segment.runId,
        turnId,
        phase: 'update',
        text: segment.text,
      })
    }
  }

  /** 这一回合的响应作废（协议没通过、被新输入抢占）：撤掉它已经发出的思考。 */
  public reject(turnId: string): void {
    const segment = this.segments.get(turnId)
    if (!segment) return
    this.segments.delete(turnId)
    if (segment.delivered > 0)
      this.emit({
        id: thinkingId(segment.runId, turnId),
        runId: segment.runId,
        turnId,
        phase: 'rejected',
        text: '',
      })
  }
}

function thinkingId(runId: string, turnId: string): string {
  return `conversation:thinking:${runId}:${turnId}`
}
