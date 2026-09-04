import { createHash } from 'node:crypto'

import type { ModelMessage } from 'ai'

import {
  type AgentExecutionConfig,
  type AgentRuntimeCapabilityPorts,
  CodingSessionTracker,
  ContextBuilder,
  ContextGovernanceSessionRegistry,
  createBuiltInPromptRegistry,
  defaultRuntimePromptFeaturePolicy,
  defaultUnsupportedInteractionPort,
  type ExecutionEventBus,
  ModelRuntime,
  PrimaryAgentProfile,
  RunContext,
  type SoloLoopToolContext,
  SoloStreamLoop,
  TurnRunner,
} from '@velaros-ai/agent'
import type {
  AgentModelInputModality,
  ToolAvailabilityScope,
  ToolCategoryDefinition,
  ToolCategoryId,
} from '@velaros-ai/agent/protocol'
import { Log } from '@velaros-ai/core'
import { logRuntime } from '@velaros-ai/core/logger'
import {
  createModelRuntimeComposition,
  type ModelRuntimeComposition,
} from '@velaros-ai/model/node'

import type {
  WorkbenchProjectCapability,
  WorkbenchProjectCapabilityProvider,
} from '../workspace/ProjectCapabilityProvider'

import {
  type WorkbenchAgentToolDefinition,
  WorkbenchAgentToolRegistry,
} from './WorkbenchAgentToolRegistry'

/**
 * Workbench 的**进程内** Agent 执行栈。
 *
 * kernel-contract §15：完整宿主自持执行栈——聊天不再委托远端 `velaros.agent`，而是在本进程
 * 直接跑 `@velaros-ai/agent` 的 {@link SoloStreamLoop}。
 *
 * ## 组装链
 * ```
 * WorkbenchAgentCapabilityRuntime.execute        （Kernel 能力入口，解析 v1 信封）
 *   → WorkbenchAgentExecutionStack.run           （本类：按 session + Mod surface 取装配）
 *     → SoloStreamLoop.execute                   （Agent 主循环）
 *       ├ ModelRuntime      ← @velaros-ai/model 的 agentModelRuntime（BYOK 选择走 config）
 *       ├ TurnRunner        ← 单轮流式 + 工具执行
 *       ├ RunContext        ← ContextBuilder 的内置提示词段注册表
 *       └ ToolRegistry      ← Project 工具 + 当前全局启用 Agent Mod 的冻结工具面
 * ```
 *
 * ## 与 Desktop 的差异（有意为之的裁剪，非遗漏）
 * Desktop 的 `createExecutionRuntime` 还装了 ExecutionService / SoloExecutionService（执行记录
 * 持久化、会话互斥、pending input、审批往返）、SubAgentDispatcher + QueryLoop（子 Agent 派发）、
 * 技能库、记忆/知识域、执行观测账本。Workbench v1 **一个都不装**：一次 execute 就是一轮
 * 前台 solo 运行，abort 靠 Kernel 能力信号，历史由调用方（renderer）持有。
 * 当前实现保留 Workbench 的单项目、前台执行边界；Mod 工具面在每次 run 开始时冻结。
 */
const WorkbenchAgentRunId = 'workbench-solo'
const WorkbenchDefaultThinkingDepth = 'balanced'

interface WorkbenchAgentRunInput {
  sessionId: string
  /** 项目根：Project capability 与会话装配都按它分桶。 */
  projectRoot: Nullable<string>
  messages: ModelMessage[]
  config: AgentExecutionConfig
  events: ExecutionEventBus
  abortSignal: AbortSignal
}

type WorkbenchAgentRunResult = { status: 'completed' } | { status: 'aborted' | 'error' }

/**
 * 当前全局启用的 Agent Mod 对一次 run 发布的工具面。
 *
 * generation 是 provider 的观察修订号，可能还包含页面 URL/title/load 等 UI 状态变化。
 * Workbench 只在 run 开始时捕获一次，再从快照内容派生稳定工具面签名：真正的 Mod
 * 工具/分类/常驻面变化才会为下一轮重建 Registry/Loop，单纯 UI 修订不会丢掉
 * CodingSessionTracker。本轮后续所有 Turn 始终使用同一份冻结装配。
 */
interface WorkbenchAgentModSurfaceSnapshot {
  readonly generation: number
  /** 已绑定宿主上下文的定义；execute/isAvailable 不得再依赖 capability 包的裸 context。 */
  readonly tools: readonly WorkbenchAgentToolDefinition[]
  readonly categoryDefinitions: Readonly<Record<ToolCategoryId, ToolCategoryDefinition>>
  readonly enabledCategoryIds: readonly ToolCategoryId[]
  readonly residentCategoryIds: readonly ToolCategoryId[]
  /** 真正进入项目空间常驻工作集的工具；其余工具仍保留在 catalog，可按需换入。 */
  readonly initialVisibleToolNames: readonly string[]
}

interface WorkbenchAgentModSurfaceCaptureInput {
  readonly sessionId: string
  readonly projectRoot: string
  readonly abortSignal: AbortSignal
}

interface WorkbenchAgentModSurfaceProvider {
  captureSnapshot(
    input: WorkbenchAgentModSurfaceCaptureInput
  ): Promise<WorkbenchAgentModSurfaceSnapshot> | WorkbenchAgentModSurfaceSnapshot
}

interface WorkbenchAgentRunToolSnapshot extends WorkbenchAgentModSurfaceSnapshot {
  /** 不含 provider/UI generation 的稳定工具面身份。 */
  readonly surfaceSignature: string
}

/** 一个会话 + 一份等价 Mod 工具面的可复用装配。 */
interface WorkbenchAgentSession {
  projectRoot: string
  /** 创建这份装配时的 provider 修订号，仅供 Registry 缓存隔离。 */
  generation: number
  surfaceSignature: string
  tracker: CodingSessionTracker
  registry: WorkbenchAgentToolRegistry
  loop: SoloStreamLoop
  enabledCategoryIds: readonly ToolCategoryId[]
  initialVisibleToolNames: readonly string[]
}

const EmptyWorkbenchAgentModSurfaceSnapshot: WorkbenchAgentModSurfaceSnapshot = Object.freeze({
  generation: 0,
  tools: Object.freeze([]),
  categoryDefinitions: Object.freeze({}),
  enabledCategoryIds: Object.freeze([]),
  residentCategoryIds: Object.freeze([]),
  initialVisibleToolNames: Object.freeze([]),
})

const EmptyWorkbenchAgentModSurfaceProvider: WorkbenchAgentModSurfaceProvider = Object.freeze({
  captureSnapshot: () => EmptyWorkbenchAgentModSurfaceSnapshot,
})

class WorkbenchAgentExecutionStack {
  private readonly log = Log.tag('WorkbenchAgentExecutionStack')
  private readonly runtimeHelper: ModelRuntime
  private readonly runContextHelper: RunContext
  private readonly contextGovernanceSessions = new ContextGovernanceSessionRegistry()
  private readonly sessions = new Map<string, WorkbenchAgentSession>()

  public constructor(
    private readonly projectProvider: WorkbenchProjectCapabilityProvider,
    modelComposition: ModelRuntimeComposition = createModelRuntimeComposition(),
    private readonly modSurfaceProvider: WorkbenchAgentModSurfaceProvider =
      EmptyWorkbenchAgentModSurfaceProvider
  ) {
    // Model 是宿主注入的能力：Agent 不自己发现 provider registry。
    // config.modelSelection 是不透明选择，Workbench 原样转交 Model 包解析（BYOK）。
    this.runtimeHelper = new ModelRuntime(modelComposition.agentModelRuntime)
    this.runContextHelper = new RunContext(
      new ContextBuilder(createBuiltInPromptRegistry(), null),
      defaultRuntimePromptFeaturePolicy
    )
  }

  /** 跑一轮主 Agent。返回 loop 的终态，事件流已经在过程中经 events 出去了。 */
  public async run(input: WorkbenchAgentRunInput): Promise<WorkbenchAgentRunResult> {
    const projectRoot = input.projectRoot?.trim()
    if (!projectRoot) {
      throw new Error('Workbench Agent 执行需要一个项目根（scopeMetadata.resourceId）。')
    }
    const session = await this.resolveSession({
      sessionId: input.sessionId,
      projectRoot,
      abortSignal: input.abortSignal,
    })
    const abortController = new AbortController()
    const unbindAbort = bindAbortSignal(input.abortSignal, abortController)
    const toolContext = createWorkbenchToolContext({
      sessionId: input.sessionId,
      projectRoot,
      abortSignal: abortController.signal,
      tracker: session.tracker,
      registry: session.registry,
      enabledCategoryIds: session.enabledCategoryIds,
      initialVisibleToolNames: session.initialVisibleToolNames,
    })
    session.tracker.attachToolContext(toolContext as never)
    const primaryAgentProfile = new PrimaryAgentProfile(EmptySkillRepository, {
      getToolCategoryId: (toolName) =>
        session.registry.getDescriptor(toolName)?.categoryId ?? 'project-files',
    })
    const resolution = primaryAgentProfile.resolve({
      knownToolNames: session.registry.names,
      allowSubAgents: false,
    })

    try {
      return (await session.loop.execute({
        history: input.messages,
        config: { ...input.config, sessionId: input.sessionId, abortController },
        chatConfig: {
          modelSelection: input.config.modelSelection,
          systemPromptAppend: '',
        },
        systemConfig: {
          thinkingDepth: input.config.thinkingDepth ?? WorkbenchDefaultThinkingDepth,
          reasoningLanguage: 'auto',
          disabledToolNames: [],
          prompt: { segmentOverrides: [] },
          advancedRuntime: {},
          // Model 包要求显式上下文。Workbench 是纯 BYOK：provider 的 key / baseURL 直接
          // 走 config.modelSelection，因此没有 provider 运行时配置表，这里给空集。
          modelRuntimeContext: {
            providerRuntimeConfigs: [],
            openRouter: { useFreeModelsForDebug: false },
          },
        },
        abortController,
        toolContext: toolContext as never,
        resolution,
        events: input.events as never,
      } as never)) as WorkbenchAgentRunResult
    } finally {
      unbindAbort()
    }
  }

  public async dispose(): Promise<void> {
    this.sessions.clear()
    await this.projectProvider.dispose().catch((error: unknown) => {
      this.log.warn('agent.project_provider_dispose_failed', {
        error: error instanceof Error ? error.message : String(error),
      })
    })
  }

  /** Loop 与冻结 Registry 同生命周期，不能按 projectRoot 复用首个 session 的注册表。 */
  private createLoop(registry: WorkbenchAgentToolRegistry): SoloStreamLoop {
    return new SoloStreamLoop(
      this.runtimeHelper,
      // 显式给出 loop 的上下文类型：TurnRunner 的默认泛型比 SoloStreamLoop 要求的窄
      // （缺 AutoVerification 那一面），不指名就会推成不兼容的默认值。
      new TurnRunner<SoloLoopToolContext>(registry, this.contextGovernanceSessions),
      this.contextGovernanceSessions,
      // 唯一保留的断言,且只包这一个参数。
      // 上游不一致:平台的 `RunContext` 要求 `RunContextToolContext.sessionId: string`,
      // 而 `SoloLoopToolContext.sessionId` 是可选的——于是平台自己的 RunContext 不满足
      // 平台自己的 `SoloLoopRunContext<SoloLoopToolContext>`。RunContext 又不是泛型类,
      // 宿主侧无法指名收窄。上游对齐 sessionId 可选性后删掉本断言。
      this.runContextHelper as unknown as ConstructorParameters<typeof SoloStreamLoop>[3],
      registry,
      null,
      {},
      null
    )
  }

  private async resolveSession(
    input: WorkbenchAgentModSurfaceCaptureInput
  ): Promise<WorkbenchAgentSession> {
    const [project, modSurface] = await Promise.all([
      this.projectProvider.resolveProject(input.projectRoot),
      this.modSurfaceProvider.captureSnapshot(input),
    ])
    input.abortSignal.throwIfAborted()

    const snapshot = composeWorkbenchAgentRunToolSnapshot(project, modSurface)
    const existing = this.sessions.get(input.sessionId)
    if (
      existing
      && existing.projectRoot === input.projectRoot
      && existing.surfaceSignature === snapshot.surfaceSignature
    ) return existing

    const registry = new WorkbenchAgentToolRegistry(
      snapshot.tools,
      snapshot.categoryDefinitions,
      snapshot.generation
    )
    const tracker = new CodingSessionTracker(
      [...snapshot.enabledCategoryIds],
      undefined,
      [...snapshot.enabledCategoryIds],
      [],
      {
        toolCategoryToolNames: registry.toolCategoryToolNames,
        residentToolCategories: snapshot.residentCategoryIds,
        activeCapabilityScope: 'project',
      }
    )
    const created: WorkbenchAgentSession = {
      projectRoot: input.projectRoot,
      generation: snapshot.generation,
      surfaceSignature: snapshot.surfaceSignature,
      tracker,
      registry,
      loop: this.createLoop(registry),
      enabledCategoryIds: snapshot.enabledCategoryIds,
      initialVisibleToolNames: snapshot.initialVisibleToolNames,
    }
    this.sessions.set(input.sessionId, created)
    return created
  }
}

/** Project 固有工具 + 当前全局启用 Mod 工具，合成为本次 run 的不可变输入。 */
function composeWorkbenchAgentRunToolSnapshot(
  project: WorkbenchProjectCapability,
  modSurface: WorkbenchAgentModSurfaceSnapshot
): WorkbenchAgentRunToolSnapshot {
  if (!Number.isSafeInteger(modSurface.generation) || modSurface.generation < 0) {
    throw new Error('Workbench Agent Mod surface generation 必须是非负安全整数。')
  }

  const categoryDefinitions = mergeCategoryDefinitions(
    project.categoryDefinitions,
    modSurface.categoryDefinitions
  )
  const tools = Object.freeze([...project.tools, ...modSurface.tools])
  const toolsByName = new Map<string, WorkbenchAgentToolDefinition>()
  for (const tool of tools) {
    if (toolsByName.has(tool.name)) {
      throw new Error(`Workbench Agent Mod surface 工具名冲突：${tool.name}`)
    }
    if (!categoryDefinitions[tool.categoryId]) {
      throw new Error(
        `Workbench Agent Mod surface 工具 ${tool.name} 缺少分类定义：${tool.categoryId}`
      )
    }
    toolsByName.set(tool.name, tool)
  }

  const enabledCategoryIds = uniqueStrings([
    ...project.enabledCategoryIds,
    ...modSurface.enabledCategoryIds,
  ])
  const enabledCategorySet = new Set(enabledCategoryIds)
  for (const categoryId of enabledCategoryIds) {
    if (!categoryDefinitions[categoryId]) {
      throw new Error(`Workbench Agent Mod surface 启用了未知分类：${categoryId}`)
    }
  }

  const residentCategoryIds = uniqueStrings([
    ...project.residentCategoryIds,
    ...modSurface.residentCategoryIds,
  ])
  for (const categoryId of residentCategoryIds) {
    if (!enabledCategorySet.has(categoryId)) {
      throw new Error(`Workbench Agent Mod surface 常驻分类未启用：${categoryId}`)
    }
  }

  const initialVisibleToolNames = uniqueStrings([
    ...project.initialVisibleToolNames,
    ...modSurface.initialVisibleToolNames,
  ])
  for (const toolName of initialVisibleToolNames) {
    const tool = toolsByName.get(toolName)
    if (!tool) {
      throw new Error(`Workbench Agent Mod surface 常驻工具未注册：${toolName}`)
    }
    if (!enabledCategorySet.has(tool.categoryId)) {
      throw new Error(`Workbench Agent Mod surface 常驻工具分类未启用：${toolName}`)
    }
  }

  return Object.freeze({
    generation: modSurface.generation,
    surfaceSignature: createWorkbenchAgentModSurfaceSignature(modSurface),
    tools,
    categoryDefinitions: Object.freeze(categoryDefinitions),
    enabledCategoryIds: Object.freeze(enabledCategoryIds),
    residentCategoryIds: Object.freeze(residentCategoryIds),
    initialVisibleToolNames: Object.freeze(initialVisibleToolNames),
  })
}

/**
 * Mod provider 可用同一个 generation 通知 renderer 页面变化与 Agent 工具面变化。
 * 这里只投影会影响 Registry/Tracker 装配的结构。工具 execute/isAvailable 是宿主实时闸门，
 * 其函数包装器每次 capture 都可以重建，不应被当成新工具面。
 */
function createWorkbenchAgentModSurfaceSignature(
  modSurface: WorkbenchAgentModSurfaceSnapshot
): string {
  const generationPrefix = `${modSurface.generation}:`
  const projection = {
    tools: modSurface.tools.map((tool) => ({
      descriptorId: tool.descriptorId,
      registrationSignature: tool.registrationSignature?.startsWith(generationPrefix)
        ? tool.registrationSignature.slice(generationPrefix.length)
        : tool.registrationSignature,
      name: tool.name,
      categoryId: tool.categoryId,
      role: tool.role,
      description: tool.description,
      permissions: tool.permissions,
      capabilities: tool.capabilities,
      requiredModelInputModalities: tool.requiredModelInputModalities,
      exposure: tool.exposure,
      usageSkillId: tool.usageSkillId,
      outputInline: tool.outputInline,
      hideWhenUnavailable: tool.hideWhenUnavailable,
      hasAvailabilityGate: typeof tool.isAvailable === 'function',
      hasUnavailableReason: typeof tool.unavailableReason === 'function',
      providerId: tool.providerId,
      providerKind: tool.providerKind,
      schema: tool.schema,
      surfaces: Object.fromEntries(
        Object.entries(tool.surfaces ?? {})
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([profileId, surface]) => [profileId, surface
            ? {
                description: surface.description,
                schema: surface.schema,
                hasNormalize: typeof surface.normalize === 'function',
              }
            : null])
      ),
      hasConcurrencyPolicy: typeof tool.isConcurrencySafe === 'function',
    })),
    categoryDefinitions: modSurface.categoryDefinitions,
    enabledCategoryIds: modSurface.enabledCategoryIds,
    residentCategoryIds: modSurface.residentCategoryIds,
    initialVisibleToolNames: modSurface.initialVisibleToolNames,
  }
  return createHash('sha256')
    .update(stableStringify(projection))
    .digest('hex')
}

function stableStringify(value: unknown): string {
  return JSON.stringify(toStableSignatureValue(value, new WeakSet<object>())) ?? ''
}

function toStableSignatureValue(value: unknown, ancestors: WeakSet<object>): unknown {
  if (value === undefined) return { $workbenchType: 'undefined' }
  if (typeof value === 'function') return { $workbenchType: 'function' }
  if (typeof value === 'bigint') return { $workbenchType: 'bigint', value: value.toString() }
  if (typeof value === 'symbol') return { $workbenchType: 'symbol', value: value.description }
  if (value === null || typeof value !== 'object') return value
  if (ancestors.has(value)) return { $workbenchType: 'cycle' }

  ancestors.add(value)
  try {
    if (Array.isArray(value)) return value.map(
      (entry) => toStableSignatureValue(entry, ancestors)
    )
    const record = value as Record<string, unknown>
    return Object.fromEntries(
      Object.keys(record)
        .filter((key) => typeof record[key] !== 'function')
        .sort((left, right) => left.localeCompare(right))
        .map((key) => [key, toStableSignatureValue(record[key], ancestors)])
    )
  } finally {
    ancestors.delete(value)
  }
}

function mergeCategoryDefinitions(
  project: Readonly<Record<ToolCategoryId, ToolCategoryDefinition>>,
  modSurface: Readonly<Record<ToolCategoryId, ToolCategoryDefinition>>
): Record<ToolCategoryId, ToolCategoryDefinition> {
  const merged: Record<ToolCategoryId, ToolCategoryDefinition> = { ...project }
  for (const [categoryId, definition] of Object.entries(modSurface)) {
    const existing = merged[categoryId]
    if (existing && JSON.stringify(existing) !== JSON.stringify(definition)) {
      throw new Error(`Workbench Agent Mod surface 分类定义冲突：${categoryId}`)
    }
    merged[categoryId] = definition
  }
  return merged
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))]
}

/** Workbench v1 没有技能库；空实现让 PrimaryAgentProfile 走「零技能」分支。 */
const EmptySkillRepository = {
  getSkillMarkdownForRole: () => '',
  listSkillsForRole: () => [],
}

/**
 * 建一轮工具上下文（SoloLoopToolContext 的 Workbench 裁剪版）。
 *
 * 逐项对齐 loop 的必填面：codingSession（tracker 直供）、activeContext（内存态，
 * Workbench 没有制品库）、可见工具名（本地状态）、类别列举（注册表直供）。
 */
export function createWorkbenchToolContext(input: {
  sessionId: string
  projectRoot: string
  abortSignal: AbortSignal
  tracker: CodingSessionTracker
  registry: WorkbenchAgentToolRegistry
  enabledCategoryIds?: readonly ToolCategoryId[]
  initialVisibleToolNames?: readonly string[]
}): Record<string, unknown> {
  let visibleToolNames = [...(input.initialVisibleToolNames ?? input.registry.names)]
  let supportedModelInputModalities: AgentModelInputModality[] = ['text']
  const enabledCategoryIds = input.enabledCategoryIds ?? input.registry.categoryIds
  const capabilityPorts = createWorkbenchAgentCapabilityPorts({
    categoryDefinitions: input.registry.categoryDefinitions ?? {},
    enabledCategoryIds,
    initialVisibleToolNames: visibleToolNames,
    toolNames: input.registry.names,
  })
  const context: Record<string, unknown> = {
    sessionId: input.sessionId,
    resourceId: input.projectRoot,
    abortSignal: input.abortSignal,
    log: logRuntime.tag('WorkbenchAgentTool'),
    role: { id: 'primary-agent' },
    proposalMode: false,
    agentSurfaceId: 'chat',
    capabilityPorts,
    // Workbench 没有持久化 execution 记录，但 Agent 提示词与计划工具要求一个非空的
    // interaction 端口；使用框架的显式空降级，读取计划时返回空结构而不是撞 undefined。
    interaction: defaultUnsupportedInteractionPort,
    execution: null,
    codingSession: input.tracker,
    // Workbench 没有制品库（Desktop 的 ActiveContextStore）；空实现让 loop 的制品分支走空集。
    activeContext: {
      listActiveContextArtifacts: async () => [],
      upsertActiveContextArtifact: async (artifact: unknown) => artifact,
    },
    getCurrentVisibleToolSurfaceProfile: () => null,
    getCurrentVisibleToolNames: () => visibleToolNames,
    setCurrentVisibleToolNames: (names: string[]) => {
      visibleToolNames = uniqueStrings(names)
    },
    getCurrentVisibleToolRegistrationSignature: (toolName: string) =>
      input.registry.getRegistrationSignature(toolName),
    getSupportedModelInputModalities: () => [...supportedModelInputModalities],
    setSupportedModelInputModalities: (modalities: readonly AgentModelInputModality[]) => {
      supportedModelInputModalities = [...new Set(modalities)]
    },
  }
  context['listTools'] = (scope: ToolAvailabilityScope = 'enabled') =>
    input.registry.listAvailable(context, undefined, scope)
  context['listToolCategories'] = (scope: ToolAvailabilityScope = 'enabled') =>
    input.registry.listCategories(context, undefined, scope)
  return context
}

function createWorkbenchAgentCapabilityPorts(input: {
  categoryDefinitions: Readonly<Record<ToolCategoryId, ToolCategoryDefinition>>
  enabledCategoryIds: readonly ToolCategoryId[]
  initialVisibleToolNames: readonly string[]
  toolNames: readonly string[]
}): AgentRuntimeCapabilityPorts {
  const enabledCategoryIds = new Set(input.enabledCategoryIds)
  const residentToolNames = uniqueStrings(input.initialVisibleToolNames)
  return {
    extensions: [{
      descriptor: {
        id: 'velaros.workbench.mod-surface',
        toolNames: [...input.toolNames],
        categories: Object.values(input.categoryDefinitions),
      },
    }],
    scopePolicy: {
      resolveScopeId: () => 'project',
      decideCategory: (categoryId) => enabledCategoryIds.has(categoryId)
        ? { allowed: true }
        : {
            allowed: false,
            reasonCode: 'mod-surface-disabled',
            message: `Tool category is not enabled in the current Mod surface: ${categoryId}`,
          },
      getDefaultCategoryIds: () => [...enabledCategoryIds],
      getResidency: () => ({
        residentToolNames,
        protectedToolNames: residentToolNames,
      }),
    },
  }
}

function bindAbortSignal(source: AbortSignal, target: AbortController): () => void {
  const abort = (): void => {
    if (!target.signal.aborted) target.abort(source.reason)
  }
  if (source.aborted) {
    abort()
    return () => undefined
  }
  source.addEventListener('abort', abort, { once: true })
  return () => source.removeEventListener('abort', abort)
}

export {
  composeWorkbenchAgentRunToolSnapshot,
  WorkbenchAgentExecutionStack,
  WorkbenchAgentRunId,
}
export type {
  WorkbenchAgentModSurfaceCaptureInput,
  WorkbenchAgentModSurfaceProvider,
  WorkbenchAgentModSurfaceSnapshot,
  WorkbenchAgentRunInput,
  WorkbenchAgentRunResult,
}
