import { Log } from '@velaros-ai/core'

import type {
  WorkbenchAgentModsOverview,
  WorkbenchAgentModSummary,
} from '../../shared/workbenchAgentMods'

import type {
  WorkbenchAgentModPackRecord,
  WorkbenchAgentModPackStore,
} from './WorkbenchAgentModPackStore'
import type {
  WorkbenchAgentModOverview,
  WorkbenchAgentModRuntime,
} from './WorkbenchAgentModRuntime'

type WorkbenchModPack = WorkbenchAgentModPackRecord

/**
 * mod 门面（Workbench）。
 *
 * 单 owner（kernel-contract §15.1 原则三）：pack 的发现 / 启停 / 安装住本地
 * {@link WorkbenchAgentModPackStore}，领域轴的装载结果住 Agent 领域 Loader。
 * 两级注册机语义不变，只是第一级从跨进程 Kernel ModStore 收回了本进程。
 */
class WorkbenchModService {
  private readonly log = Log.tag('WorkbenchModService')

  public constructor(
    private readonly packStore: WorkbenchAgentModPackStore,
    private readonly agentModRuntime: WorkbenchAgentModRuntime
  ) {}

  /** 本地 pack 清单；读不动时返回空清单并留降级原因。 */
  public async listPacks(): Promise<{
    packs: readonly WorkbenchModPack[]
    error: Nullable<string>
  }> {
    try {
      return { packs: await this.packStore.list(), error: null }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.log.warn('mods.list_failed', { error: message })
      return { packs: [], error: message }
    }
  }

  /**
   * 启停一个 pack：持久位先落盘，领域贡献当场生效。
   *
   * 进程内单 owner 后启停不再需要重启——停用即摘除贡献（数据按孤儿保全语义保留），
   * 启用即把该 pack 增量装进同一个 Loader。只有增量装载没成功（pack 不在清单里 / 拒载）
   * 才回 `reloadRequired`，让用户重启走完整装载。
   */
  public async setEnabled(
    id: string,
    enabled: boolean
  ): Promise<{ ok: boolean; reloadRequired: boolean }> {
    const ok = await this.packStore.setEnabled(id, enabled)
    if (!enabled) {
      this.agentModRuntime.deactivate(id)
      return { ok, reloadRequired: false }
    }
    const { packs } = await this.listPacks()
    const pack = packs.find((candidate) => candidate.id === id)
    if (!pack) return { ok, reloadRequired: true }
    return { ok, reloadRequired: !(await this.agentModRuntime.activatePack(pack)) }
  }

  public async installFromDirectory(
    directory: string
  ): Promise<{ pack: WorkbenchModPack; reloadRequired: boolean }> {
    const pack = await this.packStore.installFromDirectory(directory)
    if (!pack.enabled) return { pack, reloadRequired: false }
    return { pack, reloadRequired: !(await this.agentModRuntime.activatePack(pack)) }
  }

  /**
   * 设置页「模组」视图的投影。
   *
   * 已装载的 mod 走 Agent 领域报告；本地清单里登记但没进激活表的 pack（被停用 / 拒载 /
   * 不含 Agent 轴）补成 `inactive` 行——单 owner 之后「装了什么」与「生效了什么」在
   * 同一张表里对照，不再靠两处推断。
   */
  public async getSettingsOverview(): Promise<WorkbenchAgentModsOverview> {
    const { packs, error } = await this.listPacks()
    const agent = this.agentModRuntime.getOverview()
    const loaded = new Set(agent.mods.map((summary) => summary.modId))
    const enabledById = new Map(packs.map((pack) => [pack.id, pack.enabled]))
    const mods: WorkbenchAgentModSummary[] = agent.mods.map((summary) => ({
      ...summary,
      enabled: enabledById.get(summary.modId) ?? true,
    }))
    for (const pack of packs) {
      if (loaded.has(pack.id)) continue

      mods.push({
        modId: pack.id,
        version: pack.version,
        origin: pack.specifier,
        source: 'pack',
        enabled: pack.enabled,
        trust: '',
        status: 'inactive',
        activeAxes: [],
        absentAxes: [],
        unroutedAxes: [],
        contributionCount: 0,
        reasons: [],
      })
    }
    return {
      generation: agent.generation,
      assembled: agent.assembled,
      degradedReason: error ?? agent.degradedReason,
      mods,
      diagnostics: agent.diagnostics,
    }
  }

  /** 启动后的一次性装载：本地 pack 清单 → Agent 领域 Loader。 */
  public async assembleAgentAxis(): Promise<WorkbenchAgentModOverview> {
    const { packs, error } = await this.listPacks()
    if (error !== null) return this.agentModRuntime.assembleDegraded(error)
    return this.agentModRuntime.assemble({ packs })
  }
}

export { WorkbenchModService }
export type { WorkbenchModPack }
