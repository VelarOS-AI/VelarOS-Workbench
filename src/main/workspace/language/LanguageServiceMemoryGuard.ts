/**
 * 语言服务 worker 的内存看守：纯决策，不碰任何服务。
 *
 * 2026-09-16 的闪退：Workbench 跑了 39 小时后，语言服务 worker 的 V8 堆（默认上限 = 物理内存 / 4，16GB 机器
 * 上 4GB）耗尽，Node 的 OOM 处理直接 abort() 整个主进程。monorepo 里每个包一个 TypeScript 服务、每个
 * 200–250MB，加上类型感知 ESLint 的整仓程序 600MB，一路打开就到了上限。
 *
 * 两层保护：worker 建时给 `resourceLimits`——堆耗尽时 Node 只终止 worker（ERR_WORKER_OUT_OF_MEMORY），
 * 主进程活着、下一次请求重建；worker 里定期看堆用量，逼近上限先自己减负，避免反复撞墙重启。
 */

const MiB = 1024 * 1024
const MinWorkerHeapMb = 1_024
const MaxWorkerHeapMb = 4_096

/** 与 V8 默认一致（物理内存 / 4，上限 4GB），但显式设置后 OOM 才是可恢复的 worker 终止而不是进程 abort。 */
export function computeWorkbenchLanguageWorkerHeapLimitMb(totalMemoryBytes: number): number {
  const quarter = Math.floor(totalMemoryBytes / 4 / MiB)
  return Math.min(MaxWorkerHeapMb, Math.max(MinWorkerHeapMb, quarter))
}

export type WorkbenchLanguageMemoryAction = 'none' | 'semantic' | 'inactive' | 'all'

export interface WorkbenchLanguageMemorySample {
  heapUsedBytes: number
  heapLimitBytes: number
  /** 距上一次语言请求多久。 */
  idleMs: number
  /** 这段空闲期里已经做过的最重的一次减负；再次空闲减负要比它更重才有意义。 */
  idleTrimDone: WorkbenchLanguageMemoryAction
}

/** 堆用到上限的这个比例：丢掉最近没用的服务与 ESLint 程序。 */
export const PressureTrimRatio = 0.6
/** 到这个比例：全部丢掉（减负后仍然这么高，说明单个服务就很大）。 */
export const PressureDropAllRatio = 0.8
/** 空闲这么久：只丢类型检查缓存，回来第一次请求慢半秒。 */
export const IdleSemanticTrimMs = 10 * 60 * 1_000
/** 空闲这么久：全部丢掉，回来重建几秒。 */
export const IdleDropAllMs = 30 * 60 * 1_000

export function decideWorkbenchLanguageMemoryAction(
  sample: WorkbenchLanguageMemorySample
): WorkbenchLanguageMemoryAction {
  const ratio = sample.heapLimitBytes > 0 ? sample.heapUsedBytes / sample.heapLimitBytes : 0
  if (ratio >= PressureDropAllRatio) return 'all'
  if (ratio >= PressureTrimRatio) return 'inactive'
  if (sample.idleMs >= IdleDropAllMs && sample.idleTrimDone !== 'all') return 'all'
  if (sample.idleMs >= IdleSemanticTrimMs && sample.idleTrimDone === 'none') return 'semantic'
  return 'none'
}

/** worker → 主进程的内存通报（日志用）；没有 id，不是请求的答复。 */
export interface WorkbenchLanguageMemoryNotification {
  notification: 'memory'
  heapUsedMb: number
  heapLimitMb: number
  rssMb: number
  projects: number
  files: number
  eslintInstances: number
  action: WorkbenchLanguageMemoryAction
  reason: 'pressure' | 'idle' | 'heartbeat'
}

export function isWorkbenchLanguageMemoryNotification(
  value: unknown
): value is WorkbenchLanguageMemoryNotification {
  return (
    typeof value === 'object'
    && value !== null
    && (value as { notification?: unknown }).notification === 'memory'
  )
}
