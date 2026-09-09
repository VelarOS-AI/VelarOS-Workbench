import type {
  AgentRoleResolution,
  PrimaryAgentProfile,
  ResolveAgentRoleOptions,
  SubAgentTypeDescriptor,
  SubAgentTypeProvider,
  TeamModelRoutingPort,
} from '@velaros-ai/agent'
import type { AgentRoleId, ToolCategoryId } from '@velaros-ai/agent/protocol'
import { asRecord } from '@velaros-ai/core/utils/unknownJsonRecord'
import type { ModelRuntimeComposition } from '@velaros-ai/model/node'

/**
 * 子 Agent 的**只读边界文案**。
 *
 * 只读不是靠提示词兜住的——类别里没有 `project-changes` 才是硬约束，这句话只是让模型别把时间
 * 花在注定失败的写尝试上。两者缺一不可：光有文案是许愿，光有类别会让模型反复撞墙。
 */
const WorkbenchReadonlyBoundary =
  '你没有写盘能力：不要尝试编辑、创建或删除文件，把需要改动的地方写进结论交回给主 Agent。'

/** 项目写租约作用域：拿到编辑能力的子 Agent 一律领这把租约，写路径由此串行化。 */
const WorkbenchProjectMutateLeaseScope = 'project-mutate'

/**
 * 每个子 Agent 都看得到的控制面类别。
 *
 * 少了它子 Agent 连「换入工具、读上下文、交付结果」都做不到——它不是能力，是活着的最低要求。
 */
const WorkbenchSharedControlCategoryIds: readonly ToolCategoryId[] = ['agent-control']

/**
 * Workbench 的子 Agent 类型表。
 *
 * 比 Desktop 窄：Workbench 只有项目与浏览器两族工具，没有 computer / office / memory，
 * 因此这里只保留能在这些类别上真正干活的四种。类型是**宿主产品语义**（路由、阶段、安全边界
 * 文案的家），不是共享能力——两端各自声明自己的表，形状由 Platform 的 SubAgentTypeDescriptor 统一。
 */
const WorkbenchSubAgentDescriptors: readonly SubAgentTypeDescriptor[] = [
  {
    id: 'explore',
    workerType: 'scout',
    roleId: 'operator',
    routeCategory: 'scout',
    workerPhase: 'researching',
    toolCategories: [
      'project-files',
      'development-code',
      ...WorkbenchSharedControlCategoryIds,
    ],
    toolNames: [],
    resourceLeaseScope: null,
    readonlyDefault: true,
    promptAppend: `只读探索：快速搜索、阅读并归纳代码结构。\n${WorkbenchReadonlyBoundary}`,
  },
  {
    id: 'edit',
    workerType: 'coder',
    roleId: 'coder',
    routeCategory: 'writer',
    workerPhase: 'executing',
    toolCategories: [
      'project-files',
      'project-changes',
      'project-execution',
      'development-code',
      ...WorkbenchSharedControlCategoryIds,
    ],
    toolNames: [],
    resourceLeaseScope: WorkbenchProjectMutateLeaseScope,
    readonlyDefault: false,
    promptAppend: null,
  },
  {
    id: 'verify',
    workerType: 'verifier',
    roleId: 'coder',
    routeCategory: 'verifier',
    workerPhase: 'verifying',
    toolCategories: [
      'project-files',
      'project-execution',
      ...WorkbenchSharedControlCategoryIds,
    ],
    toolNames: [],
    // 不领写租约是**判决不是遗漏**：类别里没有 project-changes，它写不了盘；
    // 只读者持写锁只会白白阻塞真正的写者。
    resourceLeaseScope: null,
    readonlyDefault: true,
    promptAppend: `验证模式：运行能证明结果的检查并报告命令证据；不要修改项目文件。\n${WorkbenchReadonlyBoundary}`,
  },
  {
    id: 'general',
    workerType: 'synthesizer',
    roleId: 'chat',
    routeCategory: 'synthesizer',
    workerPhase: 'executing',
    toolCategories: ['project-files', ...WorkbenchSharedControlCategoryIds],
    toolNames: [],
    resourceLeaseScope: null,
    readonlyDefault: false,
    promptAppend: null,
  },
]

const WorkbenchSubAgentDescriptorsById = new Map(
  WorkbenchSubAgentDescriptors.map((descriptor) => [descriptor.id, descriptor])
)

class WorkbenchSubAgentTypeProvider implements SubAgentTypeProvider {
  public readonly defaultTypeId = 'general'

  public listDescriptors(): readonly SubAgentTypeDescriptor[] {
    return WorkbenchSubAgentDescriptors
  }

  public getDescriptor(id: string): Nullable<SubAgentTypeDescriptor> {
    return WorkbenchSubAgentDescriptorsById.get(id) ?? null
  }
}

/** 子 Agent 角色的展示与职责说明；`chat` 与主 Agent 同名，兜底给未知锁定角色。 */
const WorkbenchSubAgentRoleCopy: Readonly<Record<string, { label: string; description: string }>> =
  {
    operator: {
      label: '探索者',
      description: '在项目里搜索、阅读并归纳结构，不改动任何文件。',
    },
    coder: {
      label: '执行者',
      description: '在授权范围内改动项目文件并运行验证命令。',
    },
    chat: {
      label: '通用子 Agent',
      description: '承接一段可独立完成的子任务并交回结论。',
    },
  }

/**
 * QueryLoop 的角色引擎。
 *
 * Platform 的完整 `AgentRoleEngine` 要宿主注入角色表与工具绑定两套端口；Workbench 只有一张
 * 四行的子 Agent 类型表，为它建一整套角色注册表是纯仪式。这里直接复用主 Agent 的解析结果，
 * 只把身份换成锁定角色——工具边界随后由 `resolveSubAgentToolScope` 按类型描述符收窄，
 * 那才是真正管辖子 Agent 能碰什么的地方。
 */
function createWorkbenchQueryRoleEngine(primaryAgentProfile: PrimaryAgentProfile): {
  resolve(options: ResolveAgentRoleOptions): AgentRoleResolution
} {
  return {
    resolve: (options) => {
      const resolution = primaryAgentProfile.resolve({
        knownToolNames: options.knownToolNames,
        selectedSkillIds: options.selectedSkillIds ?? [],
        // 子 Agent 不再往下派：嵌套派发在 Workbench 这一档没有收益，只会让并发账更难读。
        allowSubAgents: false,
        ...(options.promptFeatures ? { promptFeatures: options.promptFeatures } : {}),
        ...(options.activeCapabilityScope
          ? { activeCapabilityScope: options.activeCapabilityScope }
          : {}),
      })
      const lockedRoleId = options.lockedRoleId?.trim()
      if (!lockedRoleId) return resolution
      const copy = WorkbenchSubAgentRoleCopy[lockedRoleId]
      return {
        ...resolution,
        id: lockedRoleId satisfies AgentRoleId,
        label: copy?.label ?? resolution.label,
        description: copy?.description ?? resolution.description,
      }
    },
  }
}

/**
 * 把 Workbench 当轮的模型选择适配成团队路由端口。
 *
 * Workbench 是纯 BYOK：没有按 worker 类型分模型的候选表，子 Agent 一律沿用主 Agent 这一次的
 * provider/model。`trace` 如实写明「跟随当前选择」，免得以后有人从日志里读出并不存在的路由策略。
 */
function createWorkbenchTeamModelRoutingPort(
  modelRuntime: ModelRuntimeComposition
): TeamModelRoutingPort {
  return {
    resolve: ({ selection, workerType, category }) => {
      const record = asRecord(selection)
      const providerId = typeof record?.provider === 'string' && record.provider.trim()
        ? record.provider
        : 'unknown'
      const model = typeof record?.model === 'string' && record.model.trim()
        ? record.model
        : 'unknown'
      return {
        runtimeOverride: {
          provider: modelRuntime.agentModelRuntime.createAgentProvider(selection),
          providerId,
          model,
        },
        trace: {
          source: 'workbench-current-selection',
          workerType,
          category,
          providerId,
          model,
        },
      }
    },
  }
}

export {
  createWorkbenchQueryRoleEngine,
  createWorkbenchTeamModelRoutingPort,
  WorkbenchProjectMutateLeaseScope,
  WorkbenchReadonlyBoundary,
  WorkbenchSubAgentDescriptors,
  WorkbenchSubAgentTypeProvider,
}
