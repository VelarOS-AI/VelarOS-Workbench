import { isEmpty } from '@velaros-ai/core'

/** 两次定时重读追踪至少隔多久，毫秒。 */
const RefreshIntervalMs = 1_000

/**
 * 一次运行里对回合追踪的读取。回合边界、定时重读与收尾都排进同一条队，一次读完再读下一次，卡片不会被
 * 较早的快照改回去。运行期间每秒问一次哪些回合要重读（执行中的当前回合、还有子任务在跑的回合），挨个
 * 重读；上一轮定时重读还在队里时不再叠加。
 */
export class ConversationTraceQueue {
  private tail: Promise<void> = Promise.resolve()
  private timer?: ReturnType<typeof setInterval>
  private queued = false

  /** project 自己兜住读取失败，队不会因为一次失败断掉。 */
  public constructor(private readonly project: (turnId: string, final: boolean) => Promise<void>) {}

  /** 排队读一次这一回合，读完时兑现。 */
  public read(turnId: string, final: boolean): Promise<void> {
    this.tail = this.tail.then(() => this.project(turnId, final))
    return this.tail
  }

  /** 开始定时重读 due 给出的回合，直到 stop；已经在定时时什么也不做。 */
  public watch(due: () => readonly string[]): void {
    this.timer ??= setInterval(() => {
      const turns = due()
      if (this.queued || isEmpty(turns)) return
      this.queued = true
      void Promise.all(turns.map((turnId) => this.read(turnId, false))).finally(() => {
        this.queued = false
      })
    }, RefreshIntervalMs)
  }

  /** 运行收尾：不再定时重读；已经排进队的读取照常读完。 */
  public stop(): void {
    clearInterval(this.timer)
    this.timer = undefined
  }
}
