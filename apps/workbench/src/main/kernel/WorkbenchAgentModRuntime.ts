import type { AgentModContributionAxisName, AgentModDiagnostic } from '@velaros-ai/agent-protocol'
import type {
  AgentModActivationStatus,
  AgentModHostProfile,
  AgentModLoadReport,
  AgentModPackDescriptorLike,
  AgentModPackReader,
  AgentModSeamDispatcher,
} from '@velaros-ai/agent-runtime'
import { AgentModLoader, assembleAgentMods } from '@velaros-ai/agent-runtime'

/**
 * 两级注册机的宿主侧接缝（Workbench）。
 *
 * 与 Desktop 的关键差异——Workbench 没有 Solo 回退的进程内执行 runtime：聊天的 Agent
 * 执行 100% 委托给共享 Kernel daemon 的 `velaros.agent` 能力（远端如何在 Kernel 侧装载
 * Agent mod 是 Kernel 仓职责，不在本文件范围）。因此本 Loader **目前没有任何本地消费
 * 面**：它只做 pack 发现 + manifest 校验 + 装载报告，为未来的设置页视图打底。
 *
 * 声明全九轴是为了让随包内置 mod（`velaros.agent.builtin`）保持 `active` 而非
 * `partial`（纯报表美观，沿用 Desktop 的先例）。但与 Desktop 不同，Workbench**没有把
 * 任何一根轴接到本地消费面**，因此每个已激活 mod 的全部活跃轴都会被记
 * `workbench.mod.axis-unrouted` 诊断——这是当前架构的如实反映，不是遗漏。
 *
 * 欠账：一旦 Workbench 有了自己的进程内执行路径（或需要在本地渲染 mod 贡献的工具/
 * 提示词/技能列表），把对应轴的落点接进来即可——Loader、报告、诊断管线已经就位。
 */
const WorkbenchAgentModSupportedAxes: readonly AgentModContributionAxisName[] = [
  'tools',
  'toolCategories',
  'promptSegments',
  'skills',
  'spaces',
  'subAgentTypes',
  'turnContextSources',
  'executionModes',
  'hooks',
]

/** Agent 轴 pack 的 provides 令牌（与 `AgentCapability` 同值）。 */
const WorkbenchAgentModPackProvidesId = 'velaros.agent'

interface WorkbenchAgentModHostVersions {
  /** 对 `engines.velaros`：Kernel module API 兼容轴。 */
  velarosVersion: string
  /** 对 `engines.agent`：Agent capability API 兼容轴。 */
  agentApiVersion: string
  /** 对 `engines.shell.workbench`：产品壳兼容第二轴。 */
  shellVersion: string
}

function createWorkbenchAgentModHostProfile(
  versions: WorkbenchAgentModHostVersions
): AgentModHostProfile {
  return {
    hostId: 'workbench',
    velarosVersion: versions.velarosVersion,
    agentApiVersion: versions.agentApiVersion,
    shellId: 'workbench',
    shellVersion: versions.shellVersion,
    supportedAxes: WorkbenchAgentModSupportedAxes,
    // fail-closed：市场签名与本地开发信任级随各自里程碑开闸，v1 只放行随包官方 mod。
    allowedTrustLevels: ['bundled-official'],
  }
}

interface WorkbenchAgentModPackSummary {
  modId: string
  version: string
  /** pack 目录或 bundled 标识。 */
  origin: string
  source: 'bundled' | 'pack'
  trust: string
  status: AgentModActivationStatus | 'rejected'
  /** 已落地的贡献轴。 */
  activeAxes: readonly AgentModContributionAxisName[]
  /** 宿主无落点、被裁剪掉的轴（partial 的原因）。 */
  absentAxes: readonly AgentModContributionAxisName[]
  /** 已装载但 Workbench 目前零本地消费面的轴——当前恒等于 activeAxes，见类头注释。 */
  unroutedAxes: readonly AgentModContributionAxisName[]
  contributionCount: number
  /** 拒载原因（可读诊断正文）。 */
  reasons: readonly string[]
}

interface WorkbenchAgentModOverview {
  generation: number
  /** Kernel 可达且已完成一次装载。 */
  assembled: boolean
  /** 装载被跳过的原因（Kernel 不可用等）；为空表示装载正常。 */
  degradedReason: Nullable<string>
  mods: readonly WorkbenchAgentModPackSummary[]
  diagnostics: readonly AgentModDiagnostic[]
}

/** `WorkbenchKernelClientRuntime.listMods` 的最小结构化契约——避免本文件反向依赖它。 */
interface WorkbenchAgentModPackLister {
  listMods(): Promise<{
    packs: readonly AgentModPackDescriptorLike[]
    error: Nullable<string>
  }>
}

/**
 * Workbench 的 Agent mod 运行时。
 *
 * Loader 在构造期就位，`assemble()` 才做 IO：装配顺序与 Kernel 启动解耦——先接好线，
 * Kernel 起来后再把 pack 装进同一个 Loader。
 */
class WorkbenchAgentModRuntime {
  public readonly loader: AgentModLoader

  private readonly host: AgentModHostProfile
  private readonly reader: AgentModPackReader
  private assembled = false
  private degradedReason: Nullable<string> = null

  public constructor(options: {
    versions: WorkbenchAgentModHostVersions
    /** pack 目录读取端口（IO 全注入）。 */
    reader: AgentModPackReader
    onDiagnostic?: (diagnostic: AgentModDiagnostic) => void
  }) {
    this.host = createWorkbenchAgentModHostProfile(options.versions)
    this.reader = options.reader
    this.loader = new AgentModLoader({
      host: this.host,
      ...(options.onDiagnostic ? { onDiagnostic: options.onDiagnostic } : {}),
    })
  }

  /** 拦截 seam 派发器：当前无本地调用点消费它，随 Loader 一并暴露供未来使用。 */
  public get seams(): AgentModSeamDispatcher {
    return this.loader.seams
  }

  /**
   * 装载一批 Kernel pack（内置 mod 恒加载）。
   *
   * `packs` 缺省或为空即只装 builtin：Kernel 不可达时行为与「从未接线」逐项一致。
   */
  public async assemble(
    input: { packs?: readonly AgentModPackDescriptorLike[] } = {}
  ): Promise<WorkbenchAgentModOverview> {
    const packs = (input.packs ?? []).filter((pack) =>
      pack.provides.includes(WorkbenchAgentModPackProvidesId)
    )
    await assembleAgentMods({
      host: this.host,
      loader: this.loader,
      ...(packs.length > 0 ? { packs, reader: this.reader } : {}),
    })
    this.assembled = true
    return this.getOverview()
  }

  /** Kernel 不可达时的降级留痕：只装 builtin，装配链照常起。 */
  public async assembleWithoutKernel(reason: string): Promise<WorkbenchAgentModOverview> {
    this.degradedReason = reason
    return this.assemble()
  }

  /** Kernel 启动后的一次性装载：pack 清单 → Agent 领域 Loader。 */
  public async assembleFromKernel(
    kernel: WorkbenchAgentModPackLister
  ): Promise<WorkbenchAgentModOverview> {
    const { packs, error } = await kernel.listMods()
    if (error !== null) return this.assembleWithoutKernel(error)
    return this.assemble({ packs })
  }

  /** 停用一个 mod：贡献摘除，持久化数据按孤儿保全语义保留。 */
  public deactivate(modId: string): boolean {
    return this.loader.deactivate(modId)
  }

  public getOverview(): WorkbenchAgentModOverview {
    const report = this.loader.getReport()
    const mods: WorkbenchAgentModPackSummary[] = report.activated.map((state) => ({
      modId: state.modId,
      version: state.version,
      origin: state.origin,
      source: state.source,
      trust: state.trust,
      status: state.status,
      activeAxes: state.activeAxes,
      absentAxes: state.absentAxes,
      unroutedAxes: state.activeAxes,
      contributionCount: state.contributionCount,
      reasons: [],
    }))
    for (const rejection of report.rejected) {
      mods.push({
        modId: rejection.modId ?? rejection.origin,
        version: '',
        origin: rejection.origin,
        source: 'pack',
        trust: '',
        status: 'rejected',
        activeAxes: [],
        absentAxes: [],
        unroutedAxes: [],
        contributionCount: 0,
        reasons: rejection.diagnostics.map((diagnostic) => diagnostic.message),
      })
    }

    return {
      generation: report.generation,
      assembled: this.assembled,
      degradedReason: this.degradedReason,
      mods,
      diagnostics: [...report.diagnostics, ...buildUnroutedDiagnostics(report)],
    }
  }
}

/** 每个已激活 mod 的全部活跃轴都零本地消费面——如实登记，绝不静默吞掉。 */
function buildUnroutedDiagnostics(report: AgentModLoadReport): AgentModDiagnostic[] {
  const diagnostics: AgentModDiagnostic[] = []
  for (const state of report.activated) {
    for (const axis of state.activeAxes) {
      diagnostics.push({
        code: 'workbench.mod.axis-unrouted',
        message:
          `mod「${state.modId}」的 ${axis} 轴已装载，但 Workbench 目前没有本地消费面`
          + `（Agent 执行委托远端 Kernel daemon），本次不生效。`,
        path: `contributes.${axis}`,
        modId: state.modId,
        origin: state.origin,
      })
    }
  }
  return diagnostics
}

export {
  createWorkbenchAgentModHostProfile,
  WorkbenchAgentModPackProvidesId,
  WorkbenchAgentModRuntime,
  WorkbenchAgentModSupportedAxes,
}
export type {
  WorkbenchAgentModHostVersions,
  WorkbenchAgentModOverview,
  WorkbenchAgentModPackSummary,
}
