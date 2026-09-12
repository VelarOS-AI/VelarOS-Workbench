export interface CoalescedRefresh {
  /** 要一次刷新：按下面的节奏排上；刷新进行中再要的等它跑完再补一次。 */
  schedule: () => void
  /** 撤掉排着的那一次和欠着的补刷（卸载、换项目、一轮收尾时）；进行中的 run 照常跑完。 */
  cancel: () => void
}

export interface CoalescedRefreshOptions {
  /** 最后一次触发之后静下来这么久才跑：一串连着来的触发只刷一次。 */
  delayMs: number
  /**
   * 从第一笔还没刷到的触发算起，最迟这么久一定跑一次：触发一直不停时也按这个节奏刷，不会一直憋着。
   * 不给就等于 `delayMs`——固定窗口：第一次触发后 delayMs 跑，窗口里的触发都并进这一次。
   */
  maxDelayMs?: number
  run: () => Promise<void>
}

/**
 * 合并刷新：Git 状态跟工作区改动、「本轮改动」实时采集跟 Agent 写入，都用这一个节奏器。
 *
 * 一串连着来的触发（文件监听一次落好几批、Agent 连着改几个文件）并成一次；同一时刻至多一次在跑，
 * 刷新进行中的触发只记一笔，跑完再按同样的节奏补一次——刷新途中落盘的改动不会漏掉。
 */
export function createCoalescedRefresh({
  delayMs,
  maxDelayMs = delayMs,
  run,
}: CoalescedRefreshOptions): CoalescedRefresh {
  let timer: Nullable<ReturnType<typeof setTimeout>> = null
  let running = false
  /** 还没刷到的第一笔触发的时间；null = 没有欠着的。 */
  let pendingSince: Nullable<number> = null
  let lastTriggeredAt = 0

  function arm(): void {
    if (timer !== null) clearTimeout(timer)
    timer = null
    if (pendingSince === null) return
    const dueAt = Math.min(lastTriggeredAt + delayMs, pendingSince + maxDelayMs)
    timer = setTimeout(fire, Math.max(0, dueAt - Date.now()))
  }

  function fire(): void {
    timer = null
    pendingSince = null
    running = true
    void run().finally(() => {
      running = false
      arm()
    })
  }

  function schedule(): void {
    const now = Date.now()
    lastTriggeredAt = now
    pendingSince ??= now
    if (!running) arm()
  }

  function cancel(): void {
    if (timer !== null) clearTimeout(timer)
    timer = null
    pendingSince = null
  }

  return { schedule, cancel }
}
