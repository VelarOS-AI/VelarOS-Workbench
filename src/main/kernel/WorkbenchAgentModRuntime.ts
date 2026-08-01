import type {
  AgentModActivationStatus,
  AgentModHostProfile,
  AgentModLoadReport,
  AgentModPackDescriptorLike,
  AgentModPackReader,
  AgentModSeamDispatcher,
} from '@velaros-ai/agent'
import { AgentModLoader, assembleAgentMods } from '@velaros-ai/agent'
import type { AgentModContributionAxisName, AgentModDiagnostic } from '@velaros-ai/agent/protocol'

/**
 * 两级注册机的宿主侧接缝（Workbench）。
 *
 * P6 起 Workbench 是完整宿主：Agent 执行在本进程跑（见 `WorkbenchAgentExecutionStack`），
 * 因此 Loader 的**拦截 seam 轴（hooks）已经接到本地消费面**——`loader.seams` 直接注入
 * ContextBuilder 与 SoloStreamLoop，mod 注册的 `tool-call:before` / `tool-result:after` /
 * `session:*` 钩子在主链上真派发。
 *
 * 其余八根贡献轴（tools / toolCategories / promptSegments / skills / spaces /
 * subAgentTypes / turnContextSources / executionModes）**仍无本地落点**：Workbench v1 的
 * 工具面固定来自 `@velaros-ai/workspace` bridge，提示词段只有内置注册表，没有技能库。
 * 这些轴照旧记 `workbench.mod.axis-unrouted` 诊断——如实反映，不静默吞掉。
 *
 * 声明全九轴是为了让随包内置 mod 保持 `active` 而非 `partial`（沿用 Desktop 先例）。
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

/** 已接到本地消费面的贡献轴；其余轴装载但不生效（见类头注释）。 */
const WorkbenchAgentModRoutedAxes: readonly AgentModContributionAxisName[] = ['hooks']

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
   * 装载一批本地 pack（内置 mod 恒加载）。
   *
   * `packs` 缺省或为空即只装 builtin：清单为空时行为与「从未接线」逐项一致。
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

  /** 本地清单读不动时的降级留痕：只装 builtin，装配链照常起。 */
  public async assembleDegraded(reason: string): Promise<WorkbenchAgentModOverview> {
    this.degradedReason = reason
    return this.assemble()
  }

  /**
   * 增量装载一个 pack（启用 / 安装的当场生效路径）。
   *
   * Loader 的 `load()` 在既有注册表之上追加，因此这里只喂这一个 pack、显式关掉 bundled，
   * 已激活的 mod 不会被重复注册。返回是否真的进了激活表——没进（拒载 / 不含 Agent 轴）
   * 由调用方回落「重启后生效」提示。
   */
  public async activatePack(pack: AgentModPackDescriptorLike): Promise<boolean> {
    if (!pack.provides.includes(WorkbenchAgentModPackProvidesId)) return false

    await assembleAgentMods({
      host: this.host,
      loader: this.loader,
      bundled: [],
      packs: [pack],
      reader: this.reader,
    })
    this.assembled = true
    return this.loader.getReport().activated.some((state) => state.origin === pack.specifier)
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
      unroutedAxes: listUnroutedAxes(state.activeAxes),
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

/** 装载了但没有本地落点的轴；已接线的轴（{@link WorkbenchAgentModRoutedAxes}）不计。 */
function listUnroutedAxes(
  activeAxes: readonly AgentModContributionAxisName[]
): readonly AgentModContributionAxisName[] {
  return activeAxes.filter((axis) => !WorkbenchAgentModRoutedAxes.includes(axis))
}

/** 无本地消费面的轴如实登记，绝不静默吞掉。 */
function buildUnroutedDiagnostics(report: AgentModLoadReport): AgentModDiagnostic[] {
  const diagnostics: AgentModDiagnostic[] = []
  for (const state of report.activated) {
    for (const axis of listUnroutedAxes(state.activeAxes)) {
      diagnostics.push({
        code: 'workbench.mod.axis-unrouted',
        message:
          `mod「${state.modId}」的 ${axis} 轴已装载，但 Workbench 目前没有本地消费面，`
          + '本次不生效。',
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
  WorkbenchAgentModRoutedAxes,
  WorkbenchAgentModRuntime,
  WorkbenchAgentModSupportedAxes,
}
export type {
  WorkbenchAgentModHostVersions,
  WorkbenchAgentModOverview,
  WorkbenchAgentModPackSummary,
}
