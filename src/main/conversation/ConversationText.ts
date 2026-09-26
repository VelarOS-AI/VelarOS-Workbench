import type { ConversationTextProjection } from '../../shared/workbenchConversation'

/** 同一次运行里两次正文预览至少隔多久，毫秒；与思考同一个节奏。 */
const PreviewPublishIntervalMs = 150

/**
 * 一次运行里每个模型回合的正文。Platform 每来一段文字就给一次到目前为止的整段预览，每段都整段落盘、
 * 下发太重：这里只记每个回合最新的预览，节流后整段发出，渲染层按前后两次快照的差量逐字揭示。一个回合
 * 的第一段预览立即发出，之后最多每 150 毫秒发一次；接纳与撤回立即发出，这一回合还欠着的预览不再发。
 * 别的事件发出前先调 flush 把欠的发掉，正文因此排在同一回合随后的脚本卡前面。
 */
export class ConversationTextBoard {
  /** 还没发出的最新预览，按正文身份。 */
  private readonly owed = new Map<string, ConversationTextProjection>()
  /** 已经发过预览的正文：撤回只对它们有意义。 */
  private readonly previewed = new Set<string>()
  private timer?: ReturnType<typeof setTimeout>
  private publishedAt = 0

  public constructor(private readonly emit: (projection: ConversationTextProjection) => void) {}

  /** 这一回合的正文预览又长了。 */
  public preview(projection: ConversationTextProjection): void {
    this.owed.set(projection.id, projection)
    if (!this.previewed.has(projection.id)) {
      this.flush()
      return
    }
    this.timer ??= setTimeout(
      () => this.flush(),
      Math.max(0, this.publishedAt + PreviewPublishIntervalMs - Date.now())
    )
  }

  /** 正文被接纳或撤回：先发完别的回合欠着的预览，再立即发出；没发过预览的正文撤回时什么也不发。 */
  public settle(projection: ConversationTextProjection): void {
    this.owed.delete(projection.id)
    this.flush()
    const previewed = this.previewed.delete(projection.id)
    if (projection.phase === 'rejected' && !previewed) return
    this.emit(projection)
  }

  /** 把还没发出的预览全部发出。 */
  public flush(): void {
    clearTimeout(this.timer)
    this.timer = undefined
    for (const projection of this.owed.values()) {
      this.previewed.add(projection.id)
      this.publishedAt = Date.now()
      this.emit(projection)
    }
    this.owed.clear()
  }
}
