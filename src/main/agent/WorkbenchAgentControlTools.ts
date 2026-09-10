import {
  backgroundJobTools,
  dispatchAgentTools,
  goalTools,
  plansTools,
  type VelaTool,
} from '@velaros-ai/agent'
import type { ToolCategoryDefinition, ToolCategoryId } from '@velaros-ai/agent/protocol'

import type { WorkbenchAgentToolDefinition } from './WorkbenchAgentToolRegistry'

/** 控制面类别 id；子 Agent 类型表把它写进每一种 worker 的可见类别（见 WorkbenchSubAgentPolicy）。 */
const WorkbenchAgentControlCategoryId: ToolCategoryId = 'agent-control'
/** 目标与计划，与 Desktop 同名；只给主 Agent，子 Agent 的类型表不含它。 */
const WorkbenchAgentPlanningCategoryId: ToolCategoryId = 'planning'

const WorkbenchAgentControlCategory: Readonly<Record<ToolCategoryId, ToolCategoryDefinition>> =
  Object.freeze({
    [WorkbenchAgentControlCategoryId]: Object.freeze({
      id: WorkbenchAgentControlCategoryId,
      label: '智能体调度',
      description: '把可独立完成的子任务派给子 Agent，并收束它们的运行结果。',
    }) as ToolCategoryDefinition,
    [WorkbenchAgentPlanningCategoryId]: Object.freeze({
      id: WorkbenchAgentPlanningCategoryId,
      label: '目标与计划',
      description: '长任务的活动目标与可见执行计划：建立、推进、完成。',
    }) as ToolCategoryDefinition,
  })

/**
 * Platform 内置工具在 Workbench 注册表里的统一形状。
 *
 * `VelaTool` 与 Project 工具是同一个 `ToolContractRuntimeSpec`，因此这里的适配与
 * `ProjectCapabilityProvider.bindProjectTools` 逐字段对齐——区别只有一个：内置工具的执行
 * 上下文就是 Workbench 的工具上下文本身，不需要再套一层领域适配。
 */
function adoptBuiltinTool(
  tool: VelaTool,
  categoryId: ToolCategoryId
): WorkbenchAgentToolDefinition {
  return {
    name: tool.name,
    categoryId,
    role: tool.role,
    description: tool.description,
    permissions: [...tool.permissions],
    capabilities: tool.capabilities,
    requiredModelInputModalities: tool.requiredModelInputModalities,
    exposure: tool.exposure,
    usageSkillId: tool.usageSkillId,
    outputInline: tool.outputInline,
    hideWhenUnavailable: tool.hideWhenUnavailable,
    providerId: 'velaros.agent',
    schema: tool.schema as WorkbenchAgentToolDefinition['schema'],
    isAvailable: tool.isAvailable
      ? (toolContext) => tool.isAvailable?.(toolContext as never) ?? true
      : undefined,
    unavailableReason: tool.unavailableReason
      ? (toolContext) => tool.unavailableReason?.(toolContext as never)
      : undefined,
    isConcurrencySafe:
      tool.isConcurrencySafe as WorkbenchAgentToolDefinition['isConcurrencySafe'],
    execute: (input, toolContext) =>
      Promise.resolve(tool.execute(input as never, toolContext as never)),
  }
}

/**
 * Workbench 执行栈自有的工具，不属于项目也不属于任何 Mod：
 *
 * - 智能体调度：`agent:dispatch` 自带可用性门（`isAvailable: ctx => !!ctx.dispatchSubAgent`），
 *   未装派发器的宿主上它自动隐身；`job:*` 是异步派发的收束路径，与派发同页登记。
 * - 目标与计划：`goal:*` / `plan:*` 读写会话的活动上下文（WorkbenchActiveContextStore）。
 *   目标模式、计划模式和模型自主建计划都靠它们，目标卡与计划卡也由它们的结果驱动。
 */
const WorkbenchAgentControlTools: readonly WorkbenchAgentToolDefinition[] = Object.freeze([
  ...[...Object.values(dispatchAgentTools), ...Object.values(backgroundJobTools)].map((tool) =>
    adoptBuiltinTool(tool as VelaTool, WorkbenchAgentControlCategoryId)
  ),
  ...[...Object.values(goalTools), ...Object.values(plansTools)].map((tool) =>
    adoptBuiltinTool(tool as VelaTool, WorkbenchAgentPlanningCategoryId)
  ),
])

const WorkbenchAgentControlToolNames: readonly string[] = Object.freeze(
  WorkbenchAgentControlTools.map((tool) => tool.name)
)

/** 两个类别都启用且常驻（与 Desktop 相同）：模型看不见这些选项，就谈不上去选它们。 */
const WorkbenchAgentControlCategoryIds: readonly ToolCategoryId[] = Object.freeze([
  WorkbenchAgentControlCategoryId,
  WorkbenchAgentPlanningCategoryId,
])

export {
  WorkbenchAgentControlCategory,
  WorkbenchAgentControlCategoryId,
  WorkbenchAgentControlCategoryIds,
  WorkbenchAgentControlToolNames,
  WorkbenchAgentControlTools,
}
