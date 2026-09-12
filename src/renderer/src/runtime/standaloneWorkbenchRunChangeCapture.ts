import { type CoalescedRefreshOptions, createCoalescedRefresh } from '../support/coalescedRefresh'

/**
 * 运行中的「本轮改动」实时采集：一轮跑着的时候，Agent 每写一次项目文件（识别见
 * workbenchAgentProjectWrites）就按节奏重新采一次，「AI 改动」面板跟着实时刷新；收尾时停下，
 * 由最终采集覆盖同一条记录。
 *
 * 节奏用合并刷新（coalescedRefresh）：一串编辑停下来 800ms 才采，只采最后那一下；写入一直不停
 * （并行的子 Agent 连着改）时最迟 3 秒也采一次，面板不会在整段写入期间一动不动。在途的采集至多一次，
 * 采集期间又有写入就等它回来再补一次。
 *
 * 收尾（`finish`）只生效一次：挂着的采集作废、之后回来的结果不再交出，并当场发出最终采集——正常结束、
 * 停止、失败，以及停止超时或控制失败时会话面提前了结这一轮，都走这一个口子。主进程按会话把这一轮的
 * 全部采集排队写盘，最终采集一定最后落地。
 */

export const StandaloneRunChangeCaptureTiming: Pick<CoalescedRefreshOptions, 'delayMs' | 'maxDelayMs'> = {
  delayMs: 800,
  maxDelayMs: 3_000,
}

export interface StandaloneRunChangeCapture {
  /** 这一轮的 Agent 又写了项目文件：按节奏排上一次实时采集。 */
  request: () => void
  /** 这一轮收尾：取消挂着的采集、丢掉晚到的结果，发出最终采集。只生效一次。 */
  finish: () => void
}

export function createStandaloneRunChangeCapture<T>(options: {
  timing: Pick<CoalescedRefreshOptions, 'delayMs' | 'maxDelayMs'>
  /** 采一次；失败时为 null（下一次写入再试）。不 reject。 */
  capture: () => Promise<T | null>
  /** 运行中采到的结果（收尾之后才回来的不再交出）。 */
  onCaptured: (result: T) => void
  /** 最终采集：按正常收尾规则把「进行中」那一轮落定到运行标记上，或撤下。 */
  settle: () => void
}): StandaloneRunChangeCapture {
  let finished = false
  const live = createCoalescedRefresh({
    ...options.timing,
    run: async () => {
      const result = await options.capture()
      if (!finished && result !== null) options.onCaptured(result)
    },
  })

  return {
    request: () => {
      if (!finished) live.schedule()
    },
    finish: () => {
      if (finished) return
      finished = true
      live.cancel()
      options.settle()
    },
  }
}
