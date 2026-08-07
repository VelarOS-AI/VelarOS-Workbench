import type { ModelMessage } from 'ai'

import {
  type AgentExecutionConfig,
  type AgentModSeamDispatcher,
  CodingSessionTracker,
  ContextBuilder,
  ContextGovernanceSessionRegistry,
  createBuiltInPromptRegistry,
  defaultRuntimePromptFeaturePolicy,
  type ExecutionEventBus,
  ModelRuntime,
  PrimaryAgentProfile,
  RunContext,
  type SoloLoopToolContext,
  SoloStreamLoop,
  TurnRunner,
} from '@velaros-ai/agent'
import { Log, toNullable } from '@velaros-ai/core'
import { logRuntime } from '@velaros-ai/core/logger'
import { createModelRuntimeComposition } from '@velaros-ai/model/node'

import type { WorkbenchProjectCapabilityProvider } from '../workspace/ProjectCapabilityProvider'

import { WorkbenchAgentToolRegistry } from './WorkbenchAgentToolRegistry'

/**
 * Workbench 的**进程内** Agent 执行栈。
 *
 * kernel-contract §15：完整宿主自持执行栈——聊天不再委托远端 `velaros.agent`，而是在本进程
 * 直接跑 `@velaros-ai/agent` 的 {@link SoloStreamLoop}。
 *
 * ## 组装链
 * ```
 * WorkbenchAgentCapabilityRuntime.execute        （Kernel 能力入口，解析 v1 信封）
 *   → WorkbenchAgentExecutionStack.run           （本类：按 projectRoot 取会话装配）
 *     → SoloStreamLoop.execute                   （Agent 主循环）
 *       ├ ModelRuntime      ← @velaros-ai/model 的 agentModelRuntime（BYOK 选择走 config）
 *       ├ TurnRunner        ← 单轮流式 + 工具执行
 *       ├ RunContext        ← ContextBuilder 的内置提示词段注册表
 *       └ ToolRegistry      ← @velaros-ai/project/agent 工具族（每 projectRoot 一份）
 * ```
 *
 * ## 与 Desktop 的差异（有意为之的裁剪，非遗漏）
 * Desktop 的 `createExecutionRuntime` 还装了 ExecutionService / SoloExecutionService（执行记录
 * 持久化、会话互斥、pending input、审批往返）、SubAgentDispatcher + QueryLoop（子 Agent 派发）、
 * 技能库、记忆/知识域、执行观测账本。Workbench v1 **一个都不装**：一次 execute 就是一轮
 * 前台 solo 运行，abort 靠 Kernel 能力信号，历史由调用方（renderer）持有。
 * 这些缺口是显式欠账，见 docs/agent-mod-trunk.md 的「残余」一节。
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

/** 一个会话的可复用装配（tracker 跨轮保留工具租约与提醒节奏）。 */
interface WorkbenchAgentSession {
  tracker: CodingSessionTracker
  registry: WorkbenchAgentToolRegistry
}

class WorkbenchAgentExecutionStack {
  private readonly log = Log.tag('WorkbenchAgentExecutionStack')
  private readonly modelComposition = createModelRuntimeComposition()
  private readonly runtimeHelper: ModelRuntime
  private readonly runContextHelper: RunContext
  private readonly primaryAgentProfile: PrimaryAgentProfile
  private readonly contextGovernanceSessions = new ContextGovernanceSessionRegistry()
  private readonly sessions = new Map<string, WorkbenchAgentSession>()
  private readonly loops = new Map<string, SoloStreamLoop>()

  public constructor(
    private readonly projectProvider: WorkbenchProjectCapabilityProvider,
    private readonly seams?: AgentModSeamDispatcher
  ) {
    // Model 是宿主注入的能力：Agent 不自己发现 provider registry。
    // config.modelSelection 是不透明选择，Workbench 原样转交 Model 包解析（BYOK）。
    this.runtimeHelper = new ModelRuntime(this.modelComposition.agentModelRuntime)
    this.runContextHelper = new RunContext(
      new ContextBuilder(createBuiltInPromptRegistry(), toNullable(this.seams)),
      defaultRuntimePromptFeaturePolicy
    )
    this.primaryAgentProfile = new PrimaryAgentProfile(EmptySkillRepository, {
      getToolCategoryId: (toolName) => {
        for (const session of this.sessions.values()) {
          const descriptor = session.registry.getDescriptor(toolName)
          if (descriptor) return descriptor.categoryId
        }
        return 'project-files'
      },
    })
  }

  /** 跑一轮主 Agent。返回 loop 的终态，事件流已经在过程中经 events 出去了。 */
  public async run(input: WorkbenchAgentRunInput): Promise<WorkbenchAgentRunResult> {
    const projectRoot = input.projectRoot?.trim()
    if (!projectRoot) {
      throw new Error('Workbench Agent 执行需要一个项目根（scopeMetadata.resourceId）。')
    }
    const session = await this.resolveSession(input.sessionId, projectRoot)
    const abortController = new AbortController()
    const unbindAbort = bindAbortSignal(input.abortSignal, abortController)
    const toolContext = createWorkbenchToolContext({
      sessionId: input.sessionId,
      projectRoot,
      abortSignal: abortController.signal,
      tracker: session.tracker,
      registry: session.registry,
    })
    session.tracker.attachToolContext(toolContext as never)
    const resolution = this.primaryAgentProfile.resolve({
      knownToolNames: session.registry.names,
      allowSubAgents: false,
    })
    const loop = this.resolveLoop(projectRoot, session.registry)

    try {
      return (await loop.execute({
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
    this.loops.clear()
    await this.projectProvider.dispose().catch((error: unknown) => {
      this.log.warn('agent.project_provider_dispose_failed', {
        error: error instanceof Error ? error.message : String(error),
      })
    })
  }

  /** 每 projectRoot 一个 loop：loop 内部按 sessionId 存工具分配器与 bootstrap 状态。 */
  private resolveLoop(
    projectRoot: string,
    registry: WorkbenchAgentToolRegistry
  ): SoloStreamLoop {
    const existing = this.loops.get(projectRoot)
    if (existing) return existing

    const created = new SoloStreamLoop(
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
      toNullable(this.seams)
    )
    this.loops.set(projectRoot, created)
    return created
  }

  private async resolveSession(
    sessionId: string,
    projectRoot: string
  ): Promise<WorkbenchAgentSession> {
    const existing = this.sessions.get(sessionId)
    if (existing) return existing

    const project = await this.projectProvider.resolveProject(projectRoot)
    const registry = new WorkbenchAgentToolRegistry(project.tools)
    const tracker = new CodingSessionTracker(
      registry.categoryIds,
      undefined,
      registry.categoryIds,
      [],
      {
        toolCategoryToolNames: registry.toolCategoryToolNames,
        residentToolCategories: registry.categoryIds,
      }
    )
    const created: WorkbenchAgentSession = { tracker, registry }
    this.sessions.set(sessionId, created)
    return created
  }
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
function createWorkbenchToolContext(input: {
  sessionId: string
  projectRoot: string
  abortSignal: AbortSignal
  tracker: CodingSessionTracker
  registry: WorkbenchAgentToolRegistry
}): Record<string, unknown> {
  let visibleToolNames = input.registry.names
  return {
    sessionId: input.sessionId,
    resourceId: input.projectRoot,
    abortSignal: input.abortSignal,
    log: logRuntime.tag('WorkbenchAgentTool'),
    role: { id: 'primary-agent' },
    proposalMode: false,
    agentSurfaceId: 'chat',
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
      visibleToolNames = names
    },
    listTools: (scope?: 'all') => input.registry.listAvailable(null, scope ? undefined : undefined),
    listToolCategories: () => input.registry.listCategories(null),
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

export { WorkbenchAgentExecutionStack, WorkbenchAgentRunId }
export type { WorkbenchAgentRunInput, WorkbenchAgentRunResult }
