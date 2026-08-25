import { jsonSchema, tool as defineAiTool, type ToolSet } from 'ai'
import { z } from 'zod'

import type {
  ToolCategoryDefinition,
  ToolCategoryId,
  ToolCategoryOverview,
  ToolDescriptor,
} from '@velaros-ai/agent/protocol'

import type { WorkbenchProjectToolDefinition } from '../workspace/ProjectCapabilityProvider'

/**
 * Workbench 的 Agent 工具注册表。
 *
 * 单一工具来源 = `@velaros-ai/project/agent` 的项目工具族。
 * 每个项目根一份 Project capability，因此注册表也是**每根一实例**。
 *
 * Workbench 把这组产品工具直接内置并全程保持可见，不经过可安装模组或设置页开关。
 */
interface WorkbenchRegisteredTool {
  name: string
  categoryId: ToolCategoryId
  role: string
  description: string
  permissions: readonly string[]
  /**
   * 工具入参 schema。
   *
   * 必须是**判别联合**，不能写成 `{ success: boolean; data?: unknown }`——后者在 `success`
   * 为真时 `data` 仍可缺席，与 Agent 主干 `ToolExecutionPolicy` 要求的 `ToolSchemaResult`
   * 对不上；旧实现靠调用点的 `as never` 把这个不匹配掩盖掉了。
   * 这里结构化对齐平台形状（该类型未从 `@velaros-ai/agent` 导出，只能镜像），
   * Project 工具的 zod schema 返回的正是它。
   */
  schema: {
    safeParse(input: unknown): WorkbenchToolSchemaResult
  }
  isConcurrencySafe?: (input: Record<string, unknown>) => boolean
  execute(input: unknown, toolContext: unknown): Promise<unknown>
}

/** 平台 `ToolSchemaResult` 的结构镜像（该类型未从 `@velaros-ai/agent` 导出）。 */
type WorkbenchToolSchemaResult =
  | { success: true; data: unknown }
  | {
      success: false
      error: {
        issues: Array<{
          path: PropertyKey[]
          message: string
          expected?: unknown
          code?: unknown
        }>
      }
    }

/** SoloStreamLoop 侧要求的注册表切面（listAvailable / getDescriptor / toAiTools / get）。 */
class WorkbenchAgentToolRegistry {
  private readonly tools = new Map<string, WorkbenchRegisteredTool>()

  public constructor(definitions: readonly WorkbenchProjectToolDefinition[]) {
    for (const definition of definitions) {
      this.tools.set(definition.name, {
        name: definition.name,
        categoryId: definition.category,
        role: definition.role,
        description: definition.description,
        permissions: definition.permissions,
        // `@velaros-ai/project/agent` 把 schema 声明成宽松的 `{ success: boolean }`，
        // 而 Agent 主干要求判别联合。两边都是同一批 zod schema，运行期形状一致；
        // 收窄放在这一个入口点,不再靠调用点的 `as never` 整片关掉类型检查。
        // 上游把 ToolSchemaResult 导出后,这个断言就能删掉。
        schema: definition.schema as WorkbenchRegisteredTool['schema'],
        isConcurrencySafe: definition.isConcurrencySafe as WorkbenchRegisteredTool['isConcurrencySafe'],
        execute: definition.execute,
      })
    }
  }

  public get names(): string[] {
    return [...this.tools.keys()]
  }

  public get categoryIds(): ToolCategoryId[] {
    return [...new Set([...this.tools.values()].map((tool) => tool.categoryId))]
  }

  public get toolCategoryToolNames(): Record<ToolCategoryId, string[]> {
    return Object.fromEntries(this.categoryIds.map((categoryId) => [
      categoryId,
      [...this.tools.values()]
        .filter((tool) => tool.categoryId === categoryId)
        .map((tool) => tool.name),
    ]))
  }

  public get(toolName: string): WorkbenchRegisteredTool | undefined {
    return this.tools.get(toolName)
  }

  public getDescriptor(
    toolName: string
  ): { categoryId: ToolCategoryId; role: 'inspect' | 'act' } | undefined {
    const tool = this.tools.get(toolName)
    return tool
      ? { categoryId: tool.categoryId, role: tool.role === 'inspect' ? 'inspect' : 'act' }
      : undefined
  }

  public listAvailable(
    _toolContext: unknown,
    allowList?: string[]
  ): Array<{ name: string; description: string; categoryId: ToolCategoryId }> {
    return this.listNames(allowList).map((name) => ({
      name,
      description: this.tools.get(name)?.description ?? '',
      categoryId: this.tools.get(name)?.categoryId ?? 'project-files',
    }))
  }

  /**
   * 分类概览。
   *
   * Workbench v1 的工具面是定长、全程可见的（无类别启停租约、无 tool_map 换页），
   * 因此 `enabled` 恒为真。分类的展示元数据（label / description / toolOs）由工具族
   * 自己持有，本注册表拿不到——见 {@link buildCategoryDefinition} 的说明。
   */
  public listCategories(_toolContext: unknown, allowList?: string[]): ToolCategoryOverview[] {
    const names = this.listNames(allowList)
    return this.categoryIds.flatMap((categoryId) => {
      const tools = names
        .filter((name) => this.tools.get(name)?.categoryId === categoryId)
        .map((name) => ({
          name,
          description: this.tools.get(name)?.description ?? '',
          categoryId,
        }) as unknown as ToolDescriptor)
      return tools.length > 0
        ? [{ category: buildCategoryDefinition(categoryId), enabled: true, tools }]
        : []
    })
  }

  /** AI SDK tool set：schema 走 zod → JSON Schema，执行仍回本注册表。 */
  public toAiTools(_toolContext: unknown, allowList?: string[]): ToolSet {
    const toolSet: ToolSet = {}
    for (const name of this.listNames(allowList)) {
      const registered = this.tools.get(name)
      if (!registered) continue

      toolSet[name] = defineAiTool({
        description: registered.description,
        inputSchema: toAiInputSchema(registered.schema),
      })
    }
    return toolSet
  }

  /** loop 的上下文预算估算钩子；缺省会回落到 `tools.length * 800` 启发值。 */
  public estimateToolsSerializedChars(_toolContext: unknown, allowList?: string[]): number {
    let total = 0
    for (const name of this.listNames(allowList)) {
      total += name.length + (this.tools.get(name)?.description.length ?? 0) + 64
    }
    return total
  }

  private listNames(allowList?: string[]): string[] {
    const names = [...this.tools.keys()]
    return allowList ? names.filter((name) => allowList.includes(name)) : names
  }
}

/**
 * zod schema → AI SDK inputSchema。
 *
 * Project 工具的 schema 是 zod v4 实例，AI SDK 直接吃；非 zod（未来的鸭子类型 schema）
 * 回落到「任意对象」JSON Schema，让模型仍能调用而不是整族工具消失。
 */
function toAiInputSchema(schema: WorkbenchRegisteredTool['schema']): never {
  if (schema instanceof z.ZodType) return schema as never
  return jsonSchema({ type: 'object', properties: {}, additionalProperties: true }) as never
}

export { WorkbenchAgentToolRegistry }
/**
 * 从分类 id 造出协议要求的分类定义。
 *
 * **这里是唯一一处「WB 手上没有的数据」**：`label` / `description` / `toolOs` 属于工具族的
 * 展示与 ToolOS 元数据，`@velaros-ai/project/agent` 目前不随工具定义一起交出来。编造
 * `domain` / `defaultState` 的枚举值等于伪造语义，因此这里只把 id 如实带出、其余留空，
 * 并用一次收窄断言把缺口圈在这一个函数里——不是散在调用点的 `as never`。
 * 上游把分类元数据一起导出后，本函数即可换成真实数据。
 */
function buildCategoryDefinition(categoryId: ToolCategoryId): ToolCategoryDefinition {
  return { id: categoryId, label: categoryId, description: '' } as ToolCategoryDefinition
}

export type { WorkbenchRegisteredTool }
