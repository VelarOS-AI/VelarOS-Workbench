export interface CoalescedRefresh {
  /** 要一次刷新：delayMs 后跑；等待期间再要的并进这一次，刷新进行中再要的等它跑完再补一次。 */
  schedule: () => void
  /** 撤掉排着的那一次和欠着的补刷（卸载、换项目时）；进行中的 run 照常跑完。 */
  cancel: () => void
}

/**
 * 合并刷新：一串连着来的触发（文件监听一次落好几批、Agent 连着改几个文件）只刷一次，最迟 delayMs 后开刷。
 * 刷新进行中不叠一次并行刷新，只记一笔，跑完再排一次——刷新途中落盘的改动不会漏掉。
 */
export function createCoalescedRefresh(delayMs: number, run: () => Promise<void>): CoalescedRefresh {
  let timer: Nullable<ReturnType<typeof setTimeout>> = null
  let running = false
  let rerunRequested = false

  function schedule(): void {
    if (running) {
      rerunRequested = true
      return
    }
    if (timer !== null) return
    timer = setTimeout(() => {
      timer = null
      running = true
      void run().finally(() => {
        running = false
        if (!rerunRequested) return
        rerunRequested = false
        schedule()
      })
    }, delayMs)
  }

  function cancel(): void {
    if (timer !== null) clearTimeout(timer)
    timer = null
    rerunRequested = false
  }

  return { schedule, cancel }
}
