export const WorkbenchAgentModsChannels = {
  getOverview: 'workbench-app:agent-mods:get-overview',
} as const

/**
 * Renderer-safe projection of `AgentModLoadReport` activation status.
 *
 * `'rejected'` 与 `'inactive'` 是 Workbench 侧的补充（不属 Agent runtime 自己的
 * `AgentModActivationStatus` 联合）：前者折入 manifest 校验拒载，后者是本地清单里
 * 登记但被停用 / 未装载的 pack——P6 起 mod 单 owner 在本进程，这两态才有意义。
 */
export type WorkbenchAgentModStatus = 'active' | 'partial' | 'rejected' | 'inactive'

export interface WorkbenchAgentModDiagnostic {
  code: string
  message: string
  path?: string
  modId?: string
  origin?: string
}

export interface WorkbenchAgentModSummary {
  modId: string
  version: string
  /** pack 目录或 bundled 标识。 */
  origin: string
  source: 'bundled' | 'pack'
  /** 本地注册表里的启用位；bundled mod 恒 true。 */
  enabled: boolean
  trust: string
  status: WorkbenchAgentModStatus
  /** 已落地的贡献轴。 */
  activeAxes: readonly string[]
  /** 宿主无落点、被裁剪掉的轴（partial 的原因）。 */
  absentAxes: readonly string[]
  /** 已装载但 Workbench 目前零本地消费面的轴。 */
  unroutedAxes: readonly string[]
  contributionCount: number
  /** 拒载原因（可读诊断正文）。 */
  reasons: readonly string[]
}

export interface WorkbenchAgentModsOverview {
  generation: number
  /** 本地 pack 清单可读且已完成一次装载。 */
  assembled: boolean
  /** 装载被跳过或降级的原因（清单不可读等）；为空表示装载正常。 */
  degradedReason: string | null
  mods: readonly WorkbenchAgentModSummary[]
  diagnostics: readonly WorkbenchAgentModDiagnostic[]
}

export interface WorkbenchAgentModsBridge {
  getOverview: () => Promise<WorkbenchAgentModsOverview>
}
