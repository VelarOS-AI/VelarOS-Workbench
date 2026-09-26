import { jsonSchema, tool as defineAiTool, type ToolSet } from 'ai'
import { z } from 'zod'

import { createToolTransportProjection, rewriteCanonicalToolReferences } from '@velaros-ai/agent'
import type {
  AgentModelInputModality,
  ToolAvailabilityScope,
  ToolCapabilitySchema,
  ToolCategoryDefinition,
  ToolCategoryId,
  ToolCategoryOverview,
  ToolDescriptor,
  ToolExposurePolicy,
  ToolPermission,
  ToolProviderKind,
  ToolRole,
  ToolSurfaceProfileId,
} from '@velaros-ai/agent/protocol'
import {
  canonicalizeProviderInputSchema,
  schemaToInputSchema,
  type ToolInputReuseContract,
} from '@velaros-ai/agent/tool-contract'
import { mapDefined } from '@velaros-ai/core'

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

interface WorkbenchAgentToolSchema {
  safeParse(input: unknown): WorkbenchToolSchemaResult
}

interface WorkbenchAgentToolSurfaceDefinition {
  description?: string
  schema: WorkbenchAgentToolSchema
  normalize?: (input: unknown, toolContext: unknown) => unknown
}

/**
 * Workbench 内部统一的 Agent 工具定义。
 *
 * Project 与可插拔 Agent Mod 都先适配到这一层。这里有意保留 VelaTool 中会影响发现、执行、
 * 模型输入兼容性与输出治理的元数据，避免组合时只剩 name/description/category 三个字段。
 */
interface WorkbenchAgentToolDefinition extends ToolInputReuseContract<any> {
  descriptorId?: string
  registrationSignature?: string
  name: string
  categoryId: ToolCategoryId
  role?: ToolRole
  description: string
  permissions: readonly ToolPermission[]
  capabilities?: ToolCapabilitySchema
  requiredModelInputModalities?: readonly AgentModelInputModality[]
  exposure?: ToolExposurePolicy
  usageSkillId?: string
  outputInline?: boolean
  hideWhenUnavailable?: boolean
  isAvailable?: (toolContext: unknown) => boolean
  unavailableReason?: (toolContext: unknown) => string | null | undefined
  providerId?: string
  providerKind?: ToolProviderKind
  schema: WorkbenchAgentToolSchema
  surfaces?: Partial<Record<ToolSurfaceProfileId, WorkbenchAgentToolSurfaceDefinition>>
  isConcurrencySafe?: (input: Record<string, unknown>) => boolean
  execute(input: unknown, toolContext: unknown): Promise<unknown> | unknown
}

interface WorkbenchRegisteredTool extends WorkbenchAgentToolDefinition {
  permissions: ToolPermission[]
  requiredModelInputModalities?: AgentModelInputModality[]
}

interface WorkbenchProviderToolSurface {
  jsonSchema: unknown
  inputSchema: ReturnType<typeof jsonSchema>
  serializedChars: number
}

/** SoloStreamLoop 侧要求的注册表切面。每个实例都是一份实际 Mod 工具面的冻结投影。 */
class WorkbenchAgentToolRegistry {
  private readonly tools = new Map<string, WorkbenchRegisteredTool>()
  private readonly categories = new Map<ToolCategoryId, ToolCategoryDefinition>()
  /** 工具替换、移除或恢复会重建 Registry；缓存只归属当前冻结工具面。 */
  private readonly providerSurfaces = new Map<string, WorkbenchProviderToolSurface>()

  public constructor(
    definitions: readonly WorkbenchAgentToolDefinition[],
    categoryDefinitions: Readonly<Record<ToolCategoryId, ToolCategoryDefinition>>,
    private readonly capabilityRevision: number
  ) {
    for (const [categoryId, definition] of Object.entries(categoryDefinitions)) {
      if (definition.id !== categoryId) {
        throw new Error(
          `Workbench Agent 工具分类键 ${categoryId} 与定义 id ${definition.id} 不一致。`
        )
      }
      this.categories.set(categoryId, cloneCategoryDefinition(definition))
    }

    for (const definition of definitions) {
      if (this.tools.has(definition.name)) {
        throw new Error(`Workbench Agent 工具重复注册：${definition.name}`)
      }
      if (!this.categories.has(definition.categoryId)) {
        throw new Error(
          `Workbench Agent 工具 ${definition.name} 缺少分类定义：${definition.categoryId}`
        )
      }
      this.tools.set(definition.name, cloneToolDefinition(definition))
    }
  }

  public get names(): string[] {
    return [...this.tools.keys()]
  }

  public get categoryIds(): ToolCategoryId[] {
    return [...new Set([...this.tools.values()].map((tool) => tool.categoryId))]
  }

  public get categoryDefinitions(): Readonly<Record<ToolCategoryId, ToolCategoryDefinition>> {
    return Object.fromEntries(this.categories)
  }

  public get toolCategoryToolNames(): Record<ToolCategoryId, string[]> {
    return Object.fromEntries(this.categoryIds.map((categoryId) => [
      categoryId,
      [...this.tools.values()]
        .filter((tool) => tool.categoryId === categoryId)
        .map((tool) => tool.name),
    ]))
  }

  /** Run planner 用它把当前冻结装配与下一份实际工具面隔开。 */
  public getCapabilityRevision(): number {
    return this.capabilityRevision
  }

  public get(toolName: string): WorkbenchRegisteredTool | undefined {
    return this.tools.get(toolName)
  }

  public getRegistrationSignature(toolName: string): string | undefined {
    const tool = this.tools.get(toolName)
    if (!tool) return undefined
    return tool.registrationSignature
      ?? `${this.capabilityRevision}:${tool.providerId ?? 'workbench'}:${toolName}`
  }

  /** 注册表实例不可变；当前签名与本轮发布签名相同。实时禁用由工具 owner 的执行闸门裁决。 */
  public getCurrentRegistrationSignature(toolName: string): string | undefined {
    return this.getRegistrationSignature(toolName)
  }

  public getDescriptor(toolName: string): ToolDescriptor | undefined {
    const tool = this.tools.get(toolName)
    return tool ? createToolDescriptor(tool) : undefined
  }

  public listAvailable(
    toolContext: unknown,
    allowList?: string[],
    scope: ToolAvailabilityScope = 'enabled'
  ): ToolDescriptor[] {
    return this.listNames(toolContext, allowList, scope)
      .map((name) => this.tools.get(name))
      .filter((tool): tool is WorkbenchRegisteredTool => tool !== undefined)
      .map(createToolDescriptor)
  }

  public listCategories(
    toolContext: unknown,
    allowList?: string[],
    scope: ToolAvailabilityScope = 'enabled'
  ): ToolCategoryOverview[] {
    const descriptors = this.listAvailable(toolContext, allowList, scope)
    return this.categoryIds.flatMap((categoryId) => {
      const category = this.categories.get(categoryId)
      if (!category) return []
      const tools = descriptors.filter((tool) => tool.categoryId === categoryId)
      return tools.length > 0
        ? [{
            category,
            enabled: isCategoryEnabled(toolContext, categoryId),
            tools,
          }]
        : []
    })
  }

  /** AI SDK tool set：schema 走 zod → JSON Schema，执行仍回本注册表。 */
  public toAiTools(toolContext: unknown, allowList?: string[]): ToolSet {
    const toolSet: ToolSet = {}
    const visibleNames = this.listNames(toolContext, allowList, 'enabled')
    const projection = createToolTransportProjection(this.names, visibleNames)
    if (toolContext && typeof toolContext === 'object') {
      const publisher = toolContext as {
        setCurrentVisibleToolTransportNames?: (names: Readonly<Record<string, string>>) => void
      }
      publisher.setCurrentVisibleToolTransportNames?.(projection.visibleCanonicalToProvider)
    }
    for (const name of visibleNames) {
      const registered = this.tools.get(name)
      if (!registered) continue

      toolSet[projection.visibleCanonicalToProvider[name]!] = defineAiTool({
        description: rewriteCanonicalToolReferences(
          registered.description,
          projection.plan.canonicalToProvider
        ),
        inputSchema: this.getProviderSurface(registered).inputSchema,
      })
    }
    return toolSet
  }

  /** 请求审计与模型工具集读取同一份已物化的 schema。 */
  public describeToolInputSchema(toolName: string): unknown {
    const registered = this.tools.get(toolName)
    return registered ? this.getProviderSurface(registered).jsonSchema : undefined
  }

  /** loop 的上下文预算估算钩子。 */
  public estimateToolsSerializedChars(toolContext: unknown, allowList?: string[]): number {
    return Object.values(this.estimateToolSerializedCharsByName(toolContext, allowList))
      .reduce((total, size) => total + size, 0)
  }

  public estimateToolSerializedCharsByName(
    toolContext: unknown,
    allowList?: string[]
  ): Record<string, number> {
    const charsByName: Record<string, number> = {}
    for (const name of this.listNames(toolContext, allowList, 'enabled')) {
      const registered = this.tools.get(name)
      if (registered) charsByName[name] = this.getProviderSurface(registered).serializedChars
    }
    return charsByName
  }

  private getProviderSurface(tool: WorkbenchRegisteredTool): WorkbenchProviderToolSurface {
    const cached = this.providerSurfaces.get(tool.name)
    if (cached) return cached
    const surface = createProviderToolSurface(tool)
    this.providerSurfaces.set(tool.name, surface)
    return surface
  }

  private listNames(
    toolContext: unknown,
    allowList: string[] | undefined,
    scope: ToolAvailabilityScope
  ): string[] {
    const allowSet = allowList ? new Set(allowList) : null
    const supportedInputModalities = readSupportedModelInputModalities(toolContext)

    return [...this.tools.values()].filter((tool) => {
      if (allowSet && !allowSet.has(tool.name)) return false
      if (!isCategoryAllowed(toolContext, tool.categoryId)) return false
      if (scope === 'enabled' && !isCategoryEnabled(toolContext, tool.categoryId)) return false
      if (
        supportedInputModalities
        && !(tool.requiredModelInputModalities ?? [])
          .every((modality) => supportedInputModalities.has(modality))
      ) return false

      const available = tool.isAvailable?.(toolContext) ?? true
      if (available) return true
      return scope === 'catalog' && tool.hideWhenUnavailable !== true
    }).map((tool) => tool.name)
  }
}

function cloneCategoryDefinition(definition: ToolCategoryDefinition): ToolCategoryDefinition {
  return {
    ...definition,
    toolOs: { ...definition.toolOs },
  }
}

/** 副本与原件同形：工具没声明 profiles 时副本里也没有这个键。 */
function cloneToolExposure(exposure: ToolExposurePolicy): ToolExposurePolicy {
  const clone: ToolExposurePolicy = { ...exposure }
  if (exposure.profiles) clone.profiles = { ...exposure.profiles }
  return clone
}

function cloneToolDefinition(definition: WorkbenchAgentToolDefinition): WorkbenchRegisteredTool {
  return {
    ...definition,
    inputReuseSourceTools: definition.inputReuseSourceTools ? [...definition.inputReuseSourceTools] : undefined,
    permissions: [...definition.permissions],
    requiredModelInputModalities: definition.requiredModelInputModalities
      ? [...definition.requiredModelInputModalities]
      : undefined,
    exposure: mapDefined(definition.exposure, cloneToolExposure),
    surfaces: definition.surfaces ? { ...definition.surfaces } : undefined,
  }
}

function createToolDescriptor(tool: WorkbenchRegisteredTool): ToolDescriptor {
  return {
    descriptorId: tool.descriptorId ?? tool.name,
    name: tool.name,
    description: tool.description,
    role: tool.role,
    permissions: [...tool.permissions],
    capabilities: tool.capabilities,
    requiredModelInputModalities: tool.requiredModelInputModalities,
    exposure: tool.exposure,
    usageSkillId: tool.usageSkillId,
    outputInline: tool.outputInline,
    categoryId: tool.categoryId,
    systemEnabled: true,
    providerId: tool.providerId,
    providerKind: tool.providerKind,
    registrationStatus: 'active',
  }
}

function readCodingSession(toolContext: unknown): Record<string, unknown> | undefined {
  if (!toolContext || typeof toolContext !== 'object') return undefined
  const codingSession = (toolContext as { codingSession?: unknown }).codingSession
  return codingSession && typeof codingSession === 'object'
    ? codingSession as Record<string, unknown>
    : undefined
}

function isCategoryAllowed(toolContext: unknown, categoryId: ToolCategoryId): boolean {
  const codingSession = readCodingSession(toolContext)
  const predicate = codingSession?.['isToolCategoryAllowed']
  return typeof predicate !== 'function'
    || predicate.call(codingSession, categoryId) !== false
}

function isCategoryEnabled(toolContext: unknown, categoryId: ToolCategoryId): boolean {
  const codingSession = readCodingSession(toolContext)
  const hasAccess = codingSession?.['hasToolCategoryAccess']
  const hasActiveAccess = codingSession?.['hasActiveToolCategoryAccess']
  return (
    (typeof hasAccess !== 'function' || hasAccess.call(codingSession, categoryId) !== false)
    && (
      typeof hasActiveAccess !== 'function'
      || hasActiveAccess.call(codingSession, categoryId) !== false
    )
  )
}

function readSupportedModelInputModalities(
  toolContext: unknown
): Set<AgentModelInputModality> | undefined {
  if (!toolContext || typeof toolContext !== 'object') return undefined
  const getter = (toolContext as Record<string, unknown>)['getSupportedModelInputModalities']
  if (typeof getter !== 'function') return undefined
  const modalities = getter.call(toolContext)
  return Array.isArray(modalities)
    ? new Set(modalities.filter(
        (modality): modality is AgentModelInputModality =>
          modality === 'text' || modality === 'image' || modality === 'audio'
      ))
    : undefined
}

/**
 * 模型请求和预算共用同一份物化 schema，避免预算遗漏参数、描述、枚举或嵌套结构。
 *
 * 非 zod 的鸭子类型 schema 保留「任意对象」发现面，执行前仍走原 schema.safeParse。
 */
function createProviderToolSurface(tool: WorkbenchRegisteredTool): WorkbenchProviderToolSurface {
  const schema = tool.schema
  const providerSchema = schema instanceof z.ZodType
    ? canonicalizeProviderInputSchema(schemaToInputSchema(schema))
    : { type: 'object', properties: {}, additionalProperties: true }
  const inputSchema = jsonSchema(providerSchema, schema instanceof z.ZodType ? {
    validate: async (value) => {
      const result = await schema.safeParseAsync(value)
      return result.success
        ? { success: true, value: result.data }
        : { success: false, error: result.error }
    },
  } : undefined)

  return {
    jsonSchema: providerSchema,
    inputSchema,
    // 与 Desktop ToolSurfaceCatalog 使用相同的工具信封开销和 schema 字符预算。
    serializedChars: tool.name.length + tool.description.length + 50
      + JSON.stringify(providerSchema).length,
  }
}

export { WorkbenchAgentToolRegistry }
export type {
  WorkbenchAgentToolDefinition,
  WorkbenchAgentToolSchema,
  WorkbenchAgentToolSurfaceDefinition,
  WorkbenchRegisteredTool,
}
