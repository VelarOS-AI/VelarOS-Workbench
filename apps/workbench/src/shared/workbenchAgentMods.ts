export const WorkbenchAgentModsChannels = {
  getOverview: 'workbench-app:agent-mods:get-overview',
} as const

/**
 * Renderer-safe projection of `AgentModLoadReport` activation status.
 *
 * `'rejected'` is a Workbench-side addition (not part of the Agent runtime's own
 * `AgentModActivationStatus` union) folding manifest-validation rejections into the
 * same list the settings view renders.
 */
export type WorkbenchAgentModStatus = 'active' | 'partial' | 'rejected'

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
  /** Kernel 可达且已完成一次装载。 */
  assembled: boolean
  /** 装载被跳过的原因（Kernel 不可用等）；为空表示装载正常。 */
  degradedReason: string | null
  mods: readonly WorkbenchAgentModSummary[]
  diagnostics: readonly WorkbenchAgentModDiagnostic[]
}

export interface WorkbenchAgentModsBridge {
  getOverview: () => Promise<WorkbenchAgentModsOverview>
}
