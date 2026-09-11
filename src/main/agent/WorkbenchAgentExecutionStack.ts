import { createHash } from 'node:crypto'

import type { ModelMessage } from 'ai'

import {
  type AgentChatRuntimeConfig,
  type AgentExecutionConfig,
  type AgentExecutionStackToolContext,
  type AgentExecutionStackWithQuery,
  type AgentRuntimeCapabilityPorts,
  type AgentSystemRuntimeConfig,
  CodingSessionTracker,
  ContextGovernanceSessionRegistry,
  type ContextPayloadStore,
  createAgentExecutionStack,
  defaultUnsupportedInteractionPort,
  ExecPlanLedger,
  ExecPlanState,
  ExecRouting,
  type ExecutionEventBus,
  ExecutionGuidanceQueue,
  findCurrentGoalArtifact,
  goalLifecycleToUpsertInput,
  isExecutionModeActive,
  KernelBackgroundJobManager,
  PrimaryAgentProfile,
  SubAgentDispatcher,
  type SubAgentDispatchInput,
  SubAgentGuidanceRelayRegistry,
  TeamModelRouter,
  type ToolConversationContextApi,
  WriteLeaseCoordinator,
} from '@velaros-ai/agent'
import {
  type ActiveContextArtifact,
  type AgentModelInputModality,
  type ChatGoalLifecycleAction,
  ChatRuntimeEvents,
  type ExecutionTaskPlanStep,
  type PermissionConfirmationMode,
  type ToolAvailabilityScope,
  type ToolCategoryDefinition,
  type ToolCategoryId,
} from '@velaros-ai/agent/protocol'
import {
  type ApprovalPort,
  createTaskApprovalPort,
  defaultDenyApprovalPort,
  type InteractionPort,
} from '@velaros-ai/agent/tool-contract'
import { Log } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'
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
  type WorkbenchActiveContextPort,
  WorkbenchActiveContextStore,
} from './WorkbenchActiveContextStore'
import { WorkbenchAgentApprovalBroker } from './WorkbenchAgentApprovalBroker'
import {
  WorkbenchAgentControlCategory,
  WorkbenchAgentControlCategoryIds,
  WorkbenchAgentControlToolNames,
  WorkbenchAgentControlTools,
} from './WorkbenchAgentControlTools'
import {
  type WorkbenchAgentToolDefinition,
  WorkbenchAgentToolRegistry,
} from './WorkbenchAgentToolRegistry'
import { WorkbenchAgentUiBridge, type WorkbenchAgentUiPort } from './WorkbenchAgentUiBridge'
import { createWorkbenchContextRecall } from './WorkbenchContextRecall'
import {
  createWorkbenchQueryRoleEngine,
  createWorkbenchTeamModelRoutingPort,
  type WorkbenchManagedModelLister,
  WorkbenchSubAgentTypeProvider,
} from './WorkbenchSubAgentPolicy'
import {
  DefaultWorkbenchPermissionConfirmationMode,
  shouldAutoApproveWorkbenchToolConfirmation,
} from './WorkbenchToolConfirmationPolicy'

/**
 * Workbench 的**进程内** Agent 执行栈。
 *
 * 由 Platform 的 createAgentExecutionStack 配对模型、提示词与回合处理，
 * Workbench 提供项目能力和每轮冻结的 Mod 工具面。
 *
 * ## 组装链
 * ```
 * WorkbenchAgentCapabilityRuntime.execute        （Kernel 能力入口，解析 v1 信封）
 *   → WorkbenchAgentExecutionStack.run           （本类：按 session + Mod surface 取装配）
 *     → stack.executeSolo                       （Platform 配对的执行栈）
 *       ├ model             ← @velaros-ai/model 的 agentModelRuntime
 *       └ toolRegistry      ← Project 工具 + Agent Mod 的冻结工具面
 * ```
 *
 * 一次 execute 是单项目的前台 Solo 运行，取消使用 Kernel 能力信号，历史由调用方持有。
 * Mod 工具面在 run 开始时冻结；等价工具面复用执行栈和会话追踪状态。
 */
const WorkbenchAgentRunId = 'workbench-solo'
const WorkbenchDefaultThinkingDepth = 'balanced'

interface WorkbenchAgentRunInput {
  sessionId: string
  /** 本轮执行 id：审批卡的 runtime 事件要自述它属于哪一次执行。 */
  executionId: string
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

/**
 * 一轮运行的配置快照。
 *
 * 主 Agent 和它派出去的子 Agent 必须看到**同一份**模型选择与系统配置：子 Agent 是这一轮的
 * 一部分，不是另一次运行。
 *
 * 由 run() 在开跑前写入，**收尾时不清**：`mode: 'async'` 的 worker 会活过派发它的那一轮，
 * 排在并发闸后面的还可能在 finally 之后才真正起跑。清掉等于让它们在启动瞬间撞空，
 * 而它们要的恰恰是「派我出来的那一轮」的配置——留着上一份快照不是将就，是正确答案。
 * 同一会话不会有两轮并行（renderer 在会话粒度上阻塞重复提交），因此不存在被下一轮覆写的窗口。
 */
interface WorkbenchAgentRunRuntime {
  config: AgentExecutionConfig
  chatConfig: AgentChatRuntimeConfig
  systemConfig: AgentSystemRuntimeConfig
  events: ExecutionEventBus
}

/** 一个会话 + 一份等价 Mod 工具面的可复用装配。 */
interface WorkbenchAgentSession {
  projectRoot: string
  /** 创建这份装配时的 provider 修订号，仅供 Registry 缓存隔离。 */
  generation: number
  surfaceSignature: string
  tracker: CodingSessionTracker
  registry: WorkbenchAgentToolRegistry
  stack: AgentExecutionStackWithQuery<WorkbenchAgentToolContext>
  /** 主 Agent 的角色解析器；子 Agent 的角色引擎也复用它（见 WorkbenchSubAgentPolicy）。 */
  primaryAgentProfile: PrimaryAgentProfile
  /** 按需子 Agent 派发器；并发闸、类型路由与写租约都在它手里。 */
  dispatcher: SubAgentDispatcher
  /** 最近一轮的配置快照；首轮开跑前为 null。 */
  runtime: Nullable<WorkbenchAgentRunRuntime>
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
  private readonly modelRuntime: ModelRuntimeComposition['agentModelRuntime']
  private readonly contextGovernanceSessions = new ContextGovernanceSessionRegistry()
  /** 页出的大工具结果与 `context:recall` 的取回口，主 Agent 与它派出的子 Agent 共用。 */
  private readonly contextRecall = createWorkbenchContextRecall(this.contextGovernanceSessions)
  private readonly sessions = new Map<string, WorkbenchAgentSession>()
  /**
   * 运行中补发的引导：按 executionId 分道排队，主 Agent 在轮次边界读走（`runtimeInput` /
   * `consumeGuidance`），读到即回 `input-applied`。与 Desktop 的 ExecutionService 同一套队列语义。
   */
  private readonly guidanceQueue = new ExecutionGuidanceQueue()
  private readonly activeRunsBySession = new Map<
    string,
    { executionId: string; events: ExecutionEventBus }
  >()
  /** 异步派发（`mode: 'async'`）的收束账本；`job:*` 工具读写的就是它。 */
  private readonly backgroundJobs = new KernelBackgroundJobManager()

  public constructor(
    private readonly projectProvider: WorkbenchProjectCapabilityProvider,
    private readonly modelComposition: ModelRuntimeComposition = createModelRuntimeComposition(),
    private readonly modSurfaceProvider: WorkbenchAgentModSurfaceProvider =
      EmptyWorkbenchAgentModSurfaceProvider,
    /** 托管厂商的可用模型目录（账号层授权）；子 Agent 指定模型时据此校验。 */
    private readonly listManagedModels: WorkbenchManagedModelLister = async () => null,
    /** 会话的目标 / 计划制品（活动上下文）；缺省只放内存，供探针与测试。 */
    private readonly activeContexts: WorkbenchActiveContextStore = new WorkbenchActiveContextStore(),
    /**
     * 审批通道：装配根持有同一个实例，才能把 renderer 的确认回执路由回等待中的执行。
     * 默认自持一个，让测试与探针不必额外接线。
     */
    public readonly approvals: WorkbenchAgentApprovalBroker = new WorkbenchAgentApprovalBroker(),
    /** 界面请求（`workbench:*` 工具）的挂起表；renderer 的回执经装配根转进来结算。 */
    public readonly ui: WorkbenchAgentUiBridge = new WorkbenchAgentUiBridge()
  ) {
    // Model 是宿主注入的能力：Agent 不自己发现 provider registry。
    // config.modelSelection 是不透明选择，Workbench 原样转交 Model 包解析（BYOK）。
    this.modelRuntime = modelComposition.agentModelRuntime
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
    const config = {
      ...input.config,
      // 目标模式：执行开始前按用户这条消息建目标，收尾门据此把关（Desktop 经 resolveChatSendRequest
      // 折算的同一位；loop 读的是它，不是 executionModes）。
      goalMode: isExecutionModeActive('goal', input.config.executionModes ?? []),
      sessionId: input.sessionId,
      abortController,
    }
    const chatConfig: AgentChatRuntimeConfig = {
      modelSelection: input.config.modelSelection,
      systemPromptAppend: '',
    }
    const systemConfig: AgentSystemRuntimeConfig = {
      thinkingDepth: input.config.thinkingDepth ?? WorkbenchDefaultThinkingDepth,
      disabledToolNames: [],
      prompt: { segmentOverrides: [] },
      advancedRuntime: {},
      // Model 包要求显式上下文。Workbench 是纯 BYOK：provider 的 key / baseURL 直接
      // 走 config.modelSelection，因此没有 provider 运行时配置表，这里给空集。
      modelRuntimeContext: {
        providerRuntimeConfigs: [],
        openRouter: { useFreeModelsForDebug: false },
      },
    }
    // 子 Agent 与主 Agent 共用这一份快照；派发器与 QueryLoop 都从 session.runtime 读。
    session.runtime = { config, chatConfig, systemConfig, events: input.events }
    const toolContext = createWorkbenchToolContext({
      sessionId: input.sessionId,
      locale: input.config.locale,
      projectRoot,
      abortSignal: abortController.signal,
      tracker: session.tracker,
      registry: session.registry,
      enabledCategoryIds: session.enabledCategoryIds,
      initialVisibleToolNames: session.initialVisibleToolNames,
      activeContext: this.activeContexts.forSession(input.sessionId),
      interaction: createWorkbenchInteractionPort(input.executionId),
      conversation: this.contextRecall.conversationFor({
        sessionId: input.sessionId,
        executionId: input.executionId,
      }),
      contextPayloadStore: this.contextRecall.payloadStore,
      // 界面请求走这一轮自己的事件流，只会到达发起这一轮的窗口。
      workbenchUi: this.ui.forExecution({
        executionId: input.executionId,
        sessionId: input.sessionId,
        events: input.events,
        abortSignal: abortController.signal,
      }),
      approval: this.buildApprovalPort({
        sessionId: input.sessionId,
        executionId: input.executionId,
        events: input.events,
        tracker: session.tracker,
        permissionConfirmationMode:
          input.config.permissionConfirmationMode
          ?? DefaultWorkbenchPermissionConfirmationMode,
      }),
      dispatchSubAgent: (dispatchInput) =>
        session.dispatcher.dispatch({
          input: dispatchInput,
          parentCtx: toolContext,
          events: input.events,
          config,
        }),
    })
    session.tracker.attachToolContext(toolContext)
    const resolution = session.primaryAgentProfile.resolve({
      knownToolNames: session.registry.names,
      allowSubAgents: true,
    })
    // 执行启动时开引导通道；运行结束后迟到的引导会被拒收，renderer 改按普通消息发送。
    const runtimeInput = this.guidanceQueue.port(input.executionId)
    this.activeRunsBySession.set(input.sessionId, {
      executionId: input.executionId,
      events: input.events,
    })

    try {
      return await session.stack.executeSolo({
        history: input.messages,
        config,
        chatConfig,
        systemConfig,
        abortController,
        toolContext,
        resolution,
        events: input.events,
        runtimeInput,
        consumeGuidance: () => this.guidanceQueue.consume(input.executionId),
      })
    } finally {
      if (this.activeRunsBySession.get(input.sessionId)?.executionId === input.executionId)
        this.activeRunsBySession.delete(input.sessionId)
      this.guidanceQueue.clear(input.executionId)
      unbindAbort()
      // 一轮结束（含中止/失败）后不留悬挂的确认卡：晚到的回执没有等待方，
      // 而挂着的 Promise 会把整个执行钉死在 awaiting_confirmation。
      this.approvals.cancelSession(input.sessionId, '本次执行已结束。')
      this.ui.cancelExecution(input.executionId, 'This run has ended.')
    }
  }

  /** 把运行中补发的引导注入该会话正在执行的这一轮；没有可接收的运行时返回 false。 */
  public provideGuidance(request: { sessionId: string; inputId: string; text: string }): boolean {
    const active = this.activeRunsBySession.get(request.sessionId)
    const text = request.text.trim()
    if (!active || !text) return false

    const enqueued = this.guidanceQueue.enqueue(
      active.executionId,
      { role: 'user', content: text },
      {
        inputId: request.inputId,
        sourceSessionId: request.sessionId,
        onConsumed: () => active.events.emitRuntime(ChatRuntimeEvents.inputApplied(request.inputId)),
      }
    )
    return enqueued.status === 'accepted'
  }

  /** 会话当前的目标（目标卡读它）；没有目标时为 null。 */
  public async getGoalLifecycle(sessionId: string): Promise<Nullable<ActiveContextArtifact>> {
    return findCurrentGoalArtifact(
      await this.activeContexts.list(sessionId, { status: 'all', kinds: ['requirement'] })
    )
  }

  /**
   * 用户在目标卡上暂停、继续或移除目标（Desktop handleUpdateGoalLifecycle 同一规则）。
   * 非「继续」的动作要停下正在跑的这一轮——停在 Kernel IPC 那一层做，它握着执行的取消权。
   */
  public async updateGoalLifecycle(
    sessionId: string,
    action: ChatGoalLifecycleAction
  ): Promise<ActiveContextArtifact> {
    const goal = await this.getGoalLifecycle(sessionId)
    if (!goal) throw new AppError('VALIDATION', 'No goal exists in this session.')
    return this.activeContexts.upsert(sessionId, goalLifecycleToUpsertInput(goal, action))
  }

  /** 会话被移除：丢掉它的执行装配，删掉它的活动上下文。 */
  public async releaseSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (session) {
      session.stack.clearSession(sessionId)
      this.sessions.delete(sessionId)
    }
    await this.activeContexts.deleteSession(sessionId)
  }

  public async dispose(): Promise<void> {
    this.approvals.dispose()
    for (const [sessionId, session] of this.sessions) session.stack.clearSession(sessionId)
    this.sessions.clear()
    await this.projectProvider.dispose().catch((error: unknown) => {
      this.log.warn('agent.project_provider_dispose_failed', {
        error: error instanceof Error ? error.message : String(error),
      })
    })
  }

  /**
   * 本轮执行的审批端口 = 判定策略（问不问）+ 通道（怎么问）。
   *
   * `createTaskApprovalPort` 负责串行化、会话级风险类别记忆与「同一操作只问一次」，
   * 判据交给 {@link shouldAutoApproveWorkbenchToolConfirmation}，真正要问人时才落到 broker。
   */
  private buildApprovalPort(input: {
    sessionId: string
    executionId: string
    events: ExecutionEventBus
    tracker: CodingSessionTracker
    permissionConfirmationMode: PermissionConfirmationMode
  }): ApprovalPort {
    return createTaskApprovalPort(
      this.approvals.createPort({
        sessionId: input.sessionId,
        executionId: input.executionId,
        events: input.events,
      }),
      input.tracker,
      {
        shouldAutoApprove: (options) =>
          shouldAutoApproveWorkbenchToolConfirmation({
            permissionConfirmationMode: input.permissionConfirmationMode,
            hasConfirmedRiskScope: (riskScope) => !!input.tracker.hasConfirmedRiskScope(riskScope),
            options,
          }),
      }
    )
  }

  /**
   * 执行栈绑定本次冻结工具面，内部回合与上下文由 Platform 统一配对。
   *
   * 传 `query` 才会配出 QueryLoop——子 Agent 面就是它。省掉这一格的宿主只跑 Solo，
   * `agent:dispatch` 会因为拿不到 `dispatchSubAgent` 而整格隐身。
   */
  private createStack(
    registry: WorkbenchAgentToolRegistry,
    primaryAgentProfile: PrimaryAgentProfile
  ): AgentExecutionStackWithQuery<WorkbenchAgentToolContext> {
    const toolCategoryToolNames = registry.toolCategoryToolNames
    return createAgentExecutionStack<WorkbenchAgentToolContext>({
      model: this.modelRuntime,
      toolRegistry: registry,
      governanceSessions: this.contextGovernanceSessions,
      query: {
        roleEngine: createWorkbenchQueryRoleEngine(primaryAgentProfile),
        getToolNamesForCategories: (categories) =>
          categories.flatMap((categoryId) => toolCategoryToolNames[categoryId] ?? []),
      },
    })
  }

  /**
   * 子 Agent 派发器。
   *
   * 它要的五样东西 Workbench 都能给出**真**实现，没有一处占位：模型路由跟随当前 BYOK 选择、
   * 写租约用包内协调器串行化编辑、配置从当轮快照读、引导中继与类型表各自一份。
   * 派发器不自己跑 loop——`bindAgentRunner` 之后由本栈的 QueryLoop 执行。
   */
  private createSubAgentDispatcher(
    stack: AgentExecutionStackWithQuery<WorkbenchAgentToolContext>,
    readRuntime: () => WorkbenchAgentRunRuntime
  ): SubAgentDispatcher {
    const dispatcher = new SubAgentDispatcher(
      new TeamModelRouter(
        createWorkbenchTeamModelRoutingPort(this.modelComposition, this.listManagedModels)
      ),
      new WriteLeaseCoordinator(),
      {
        get systemConfig(): AgentSystemRuntimeConfig {
          return readRuntime().systemConfig
        },
        get chatConfig(): AgentChatRuntimeConfig {
          return readRuntime().chatConfig
        },
      },
      new SubAgentGuidanceRelayRegistry(),
      new WorkbenchSubAgentTypeProvider(),
      undefined,
      this.backgroundJobs
    )
    dispatcher.bindAgentRunner({
      query: (task, parentCtx, opts) => {
        const runtime = readRuntime()
        return stack.executeQuery({
          task,
          opts: opts as never,
          parentCtx: parentCtx as WorkbenchAgentToolContext,
          chatConfig: runtime.chatConfig,
          systemConfig: runtime.systemConfig,
          // Workbench 没有能力侧信号（Desktop 的 codingSignals 那一路）；空快照让子 Agent
          // 的提示词组装走「无信号」分支，而不是拿一个假对象去渲染。
          collectCapabilityContext: async () => null,
        })
      },
    })
    return dispatcher
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
    const primaryAgentProfile = new PrimaryAgentProfile(EmptySkillRepository, {
      getToolCategoryId: (toolName) =>
        registry.getDescriptor(toolName)?.categoryId ?? 'project-files',
    })
    const stack = this.createStack(registry, primaryAgentProfile)
    const created: WorkbenchAgentSession = {
      projectRoot: input.projectRoot,
      generation: snapshot.generation,
      surfaceSignature: snapshot.surfaceSignature,
      tracker,
      registry,
      stack,
      primaryAgentProfile,
      dispatcher: this.createSubAgentDispatcher(stack, () => {
        const runtime = created.runtime
        // 只有「一轮都还没跑过就派子 Agent」才可能落到这里，那是装配错误而非运行态。
        if (!runtime) throw new Error('子 Agent 只能在一轮主 Agent 运行内派发。')
        return runtime
      }),
      runtime: null,
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
    mergeCategoryDefinitions(project.categoryDefinitions, WorkbenchAgentControlCategory),
    modSurface.categoryDefinitions
  )
  // 控制面工具不属于任何 Mod：它们是执行栈自己的能力（派发子 Agent、收束异步作业），
  // 因此在这里与项目/Mod 工具面合流，而不是伪装成一个 provider 挂进 Mod 目录。
  const tools = Object.freeze([
    ...project.tools,
    ...WorkbenchAgentControlTools,
    ...modSurface.tools,
  ])
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
    ...WorkbenchAgentControlCategoryIds,
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
    // 控制面与目标 / 计划常驻：模型得能看见「这活可以派出去」「这事该先立个计划」这些选项，
    // 才谈得上选它们。几个工具的 schema 成本远低于永远想不到的代价。
    ...WorkbenchAgentControlCategoryIds,
    ...modSurface.residentCategoryIds,
  ])
  for (const categoryId of residentCategoryIds) {
    if (!enabledCategorySet.has(categoryId)) {
      throw new Error(`Workbench Agent Mod surface 常驻分类未启用：${categoryId}`)
    }
  }

  const initialVisibleToolNames = uniqueStrings([
    ...project.initialVisibleToolNames,
    ...WorkbenchAgentControlToolNames,
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

/** 主 Agent 的角色 id；执行计划的步骤也记在这个角色名下。 */
const WorkbenchPrimaryRoleId = 'primary-agent'

/**
 * 一轮执行的交互面：只承载 `plan:update` / `plan:get` 读写的执行计划。Workbench 没有执行账，任务、
 * 推荐动作与执行建议一概没有；计划与 Desktop 一样按 execution 分，下一轮从空计划开始——计划正文
 * 另由 plan:update 写进活动上下文，跨轮、跨压缩都在。步骤合并与编号用 Platform 的计划账本。
 */
export function createWorkbenchInteractionPort(executionId: string): InteractionPort {
  const ledger = new ExecPlanLedger(new ExecRouting())
  const planState = new ExecPlanState()
  let plan: ExecutionTaskPlanStep[] = []
  return {
    executionId,
    getCurrentPlan: () => plan,
    updateCurrentPlan: (update) => {
      plan = planState.refreshExecutionPlan(
        ledger.buildManualExecutionPlan(plan, update, {
          now: Date.now(),
          roleId: WorkbenchPrimaryRoleId,
          kind: 'implement',
        })
      )
      return plan
    },
    getCurrentTask: () => null,
    getCurrentRecommendedAction: () => null,
    getCurrentExecutionAdvice: () => null,
  }
}

/** 没接活动上下文的工具面（探针、子 Agent 测试）：读是空集，写明确报错。 */
const DetachedActiveContext: WorkbenchActiveContextPort = {
  listActiveContextArtifacts: async () => [],
  upsertActiveContextArtifact: async () => {
    throw new Error('Workbench 当前执行上下文未提供制品写入存储。')
  },
}

/**
 * 建一轮工具上下文（SoloLoopToolContext 的 Workbench 裁剪版）。
 *
 * 逐项对齐 loop 的必填面：codingSession（tracker 直供）、activeContext（会话的目标 / 计划制品）、
 * interaction（本轮执行计划）、可见工具名（本地状态）、类别列举（注册表直供）。
 */
type WorkbenchAgentToolContext = AgentExecutionStackToolContext & {
  resourceId: string
  describeToolInputSchema(toolName: string): unknown
  getCurrentVisibleToolTransportNames(): Readonly<Record<string, string>>
  setCurrentVisibleToolTransportNames(names: Readonly<Record<string, string>>): void
  codingSession: CodingSessionTracker
  interaction: InteractionPort
  approval: ApprovalPort
  /** execution 恒为 null（Workbench 没有执行账），显式写成 null 让子 Agent 面的契约对得上。 */
  execution: null
  /** 子 Agent 派发；缺席时 `agent:dispatch` 自带的可用性门会让它整格隐身。 */
  dispatchSubAgent?: (input: SubAgentDispatchInput) => Promise<string>
  /** 发起这一轮的窗口；缺席时 `workbench:*` 界面工具整格隐身。 */
  workbenchUi?: WorkbenchAgentUiPort
  /** `context:recall` 的取回口；子 Agent 的上下文从主 Agent 这里继承同一份。 */
  conversation?: ToolConversationContextApi
  /** 执行器页出大工具结果时写入的存储；缺席时结果只内联、超出预算就截断。 */
  contextPayloadStore?: ContextPayloadStore
}

export function createWorkbenchToolContext(input: {
  sessionId: string
  locale?: AgentExecutionConfig['locale']
  projectRoot: string
  abortSignal: AbortSignal
  tracker: CodingSessionTracker
  registry: WorkbenchAgentToolRegistry
  enabledCategoryIds?: readonly ToolCategoryId[]
  initialVisibleToolNames?: readonly string[]
  /** 审批端口；缺省是设计式拒绝，工具会拿到「没有审批通道」而不是撞 null。 */
  approval?: ApprovalPort
  /** 会话的目标 / 计划制品；缺省读空、写报错。 */
  activeContext?: WorkbenchActiveContextPort
  /** 本轮执行计划；缺省是框架的显式空降级。 */
  interaction?: InteractionPort
  /** 子 Agent 派发；不传即本次执行面不开放委派。 */
  dispatchSubAgent?: (input: SubAgentDispatchInput) => Promise<string>
  /** 界面操作口；不传即本次执行面没有可操作的窗口。 */
  workbenchUi?: WorkbenchAgentUiPort
  /** 上下文召回口与页出存储；不传即这一面不页出、也没有 `context:recall` 可用。 */
  conversation?: ToolConversationContextApi
  contextPayloadStore?: ContextPayloadStore
}): WorkbenchAgentToolContext {
  let visibleToolNames = [...(input.initialVisibleToolNames ?? input.registry.names)]
  let visibleToolTransportNames: Readonly<Record<string, string>> = {}
  let supportedModelInputModalities: AgentModelInputModality[] = ['text']
  const enabledCategoryIds = input.enabledCategoryIds ?? input.registry.categoryIds
  const capabilityPorts = createWorkbenchAgentCapabilityPorts({
    categoryDefinitions: input.registry.categoryDefinitions ?? {},
    enabledCategoryIds,
    initialVisibleToolNames: visibleToolNames,
    toolNames: input.registry.names,
  })
  const context: WorkbenchAgentToolContext = {
    sessionId: input.sessionId,
    locale: input.locale ?? 'zh-CN',
    resourceId: input.projectRoot,
    abortSignal: input.abortSignal,
    log: logRuntime.tag('WorkbenchAgentTool'),
    role: {
      id: WorkbenchPrimaryRoleId,
      label: 'Workbench Agent',
      description: '当前项目作用域的主 Agent。',
      nextAllowedRoles: [],
    },
    planningMode: false,
    agentSurfaceId: 'chat',
    capabilityPorts,
    // Workbench 没有持久化 execution 记录；执行计划由本轮的交互面承载，没接的上下文用框架的
    // 显式空降级，读取计划时返回空结构而不是撞 undefined。
    interaction: input.interaction ?? defaultUnsupportedInteractionPort,
    // 审批与交互分属两个端口：Workbench 的 execution 恒为空（无执行账），审批却是真通道。
    approval: input.approval ?? defaultDenyApprovalPort,
    execution: null,
    ...(input.dispatchSubAgent ? { dispatchSubAgent: input.dispatchSubAgent } : {}),
    ...(input.workbenchUi ? { workbenchUi: input.workbenchUi } : {}),
    ...(input.conversation ? { conversation: input.conversation } : {}),
    ...(input.contextPayloadStore ? { contextPayloadStore: input.contextPayloadStore } : {}),
    codingSession: input.tracker,
    getEnabledToolCategories: () => input.tracker.getEnabledToolCategories(),
    query: async () => {
      throw new Error('Workbench 当前执行面未启用子 Agent 委派。')
    },
    activeContext: input.activeContext ?? DetachedActiveContext,
    getCurrentVisibleToolSurfaceProfile: () => null,
    getCurrentVisibleToolNames: () => visibleToolNames,
    setCurrentVisibleToolNames: (names: string[]) => {
      visibleToolNames = uniqueStrings(names)
    },
    getCurrentVisibleToolTransportNames: () => visibleToolTransportNames,
    setCurrentVisibleToolTransportNames: (names) => {
      visibleToolTransportNames = { ...names }
    },
    describeToolInputSchema: (toolName: string) => input.registry.describeToolInputSchema(toolName),
    getCurrentVisibleToolRegistrationSignature: (toolName: string) =>
      input.registry.getRegistrationSignature(toolName),
    getSupportedModelInputModalities: () => [...supportedModelInputModalities],
    setSupportedModelInputModalities: (modalities: readonly AgentModelInputModality[]) => {
      supportedModelInputModalities = [...new Set(modalities)]
    },
    listTools: (scope: ToolAvailabilityScope = 'enabled') =>
      input.registry.listAvailable(context, undefined, scope),
    listToolCategories: (scope: ToolAvailabilityScope = 'enabled') =>
      input.registry.listCategories(context, undefined, scope),
  }
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
    // 首轮只保留宿主发布的常驻工具；其余 catalog 工具继续由上下文和可用性门决定。
    allocation: { baselineToolNames: residentToolNames },
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
