import { backgroundJobTools, dispatchAgentTools } from '@velaros-ai/agent'
import type { ToolCategoryDefinition, ToolCategoryId } from '@velaros-ai/agent/protocol'

import type { WorkbenchAgentToolDefinition } from './WorkbenchAgentToolRegistry'

/** 控制面类别 id；子 Agent 类型表把它写进每一种 worker 的可见类别（见 WorkbenchSubAgentPolicy）。 */
const WorkbenchAgentControlCategoryId: ToolCategoryId = 'agent-control'

const WorkbenchAgentControlCategory: Readonly<Record<ToolCategoryId, ToolCategoryDefinition>> =
  Object.freeze({
    [WorkbenchAgentControlCategoryId]: Object.freeze({
      id: WorkbenchAgentControlCategoryId,
      label: '智能体调度',
      description: '把可独立完成的子任务派给子 Agent，并收束它们的运行结果。',
    }) as ToolCategoryDefinition,
  })

/**
 * Platform 内置工具在 Workbench 注册表里的统一形状。
 *
 * `VelaTool` 与 Project 工具是同一个 `ToolContractRuntimeSpec`，因此这里的适配与
 * `ProjectCapabilityProvider.bindProjectTools` 逐字段对齐——区别只有一个：内置工具的执行
 * 上下文就是 Workbench 的工具上下文本身，不需要再套一层领域适配。
 */
type BuiltinToolSpec = (typeof dispatchAgentTools)[keyof typeof dispatchAgentTools]

function adoptBuiltinTool(tool: BuiltinToolSpec): WorkbenchAgentToolDefinition {
  return {
    name: tool.name,
    categoryId: WorkbenchAgentControlCategoryId,
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
 * Workbench 的智能体控制面工具。
 *
 * `agent:dispatch` 自带可用性门（`isAvailable: ctx => !!ctx.dispatchSubAgent`），所以未装派发器
 * 的宿主上它自动隐身——不需要在这里再判一次。`job:*` 是异步派发的收束路径，与派发同页登记。
 */
const WorkbenchAgentControlTools: readonly WorkbenchAgentToolDefinition[] = Object.freeze(
  [...Object.values(dispatchAgentTools), ...Object.values(backgroundJobTools)].map(
    (tool) => adoptBuiltinTool(tool as BuiltinToolSpec)
  )
)

const WorkbenchAgentControlToolNames: readonly string[] = Object.freeze(
  WorkbenchAgentControlTools.map((tool) => tool.name)
)

export {
  WorkbenchAgentControlCategory,
  WorkbenchAgentControlCategoryId,
  WorkbenchAgentControlToolNames,
  WorkbenchAgentControlTools,
}
