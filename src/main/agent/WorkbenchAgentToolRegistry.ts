import { jsonSchema, tool as defineAiTool,type ToolSet } from 'ai'
import { z } from 'zod'

import type { ToolCategoryId, ToolDescriptor } from '@velaros-ai/agent/protocol'

import type { WorkbenchProjectToolDefinition } from '../workspace/ProjectCapabilityProvider'

/**
 * Workbench 的 Agent 工具注册表。
 *
 * 单一工具来源 = `@velaros-ai/project/agent` 的项目工具族。
 * 每个项目根一份 Project capability，因此注册表也是**每根一实例**。
 *
 * 与 Desktop 的 ToolRegistry 相比这里刻意极窄：没有 provider 生命周期、没有 MCP 注入、
 * 没有类别启停租约——Workbench v1 的工具面是一根固定分类下的定长工具集，全程可见。
 * 类别启停与分页（tool_map / 换入换出）留欠账，见 docs/agent-mod-trunk.md。
 */
interface WorkbenchRegisteredTool {
  name: string
  categoryId: ToolCategoryId
  role: string
  description: string
  permissions: readonly string[]
  schema: { safeParse(input: unknown): { success: boolean; data?: unknown; error?: unknown } }
  isConcurrencySafe?: (input: never) => boolean
  execute(input: unknown, toolContext: unknown): Promise<unknown>
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
        schema: definition.schema,
        isConcurrencySafe: definition.isConcurrencySafe,
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

  public listCategories(
    _toolContext: unknown,
    allowList?: string[]
  ): Array<{ category: { id: ToolCategoryId }; tools: ToolDescriptor[] }> {
    const names = this.listNames(allowList)
    return this.categoryIds.flatMap((categoryId) => {
      const tools = names
        .filter((name) => this.tools.get(name)?.categoryId === categoryId)
        .map((name) => ({
          name,
          description: this.tools.get(name)?.description ?? '',
          categoryId,
        }) as unknown as ToolDescriptor)
      return tools.length > 0 ? [{ category: { id: categoryId }, tools }] : []
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
export type { WorkbenchRegisteredTool }
