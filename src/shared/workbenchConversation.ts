import type { ModelSelection } from '@velaros-ai/model'
import type {
  ActiveContextArtifact,
  AppLocale,
  ChatGoalLifecycleAction,
  InteractionAnswer,
  InteractionBlock,
  ReasoningLevel,
  StreamUsageTelemetryPayload,
  TeamExecutionPhase,
} from '@velaros-ai/ui/conversation/contracts'
import type { RuntimeNoteContent, RuntimeNoteRead, VelarosSession } from '@velaros-ai/velaros'
import type { ActInvocationSummary } from '@velaros-ai/velaros/contracts'

import type { WorkbenchFsCallResult } from './workbenchFs'

/**
 * 主聊天与 Platform 会话运行时之间的合同（与 Desktop 的主聊天同一套：一次提交只交这一条用户输入，
 * 模型上下文由 Platform 会话自己持有；运行中的展示经「通知」逐条推给窗口）。
 */
export const WorkbenchConversationChannels = {
  send: 'workbench-app:conversation:send',
  cancel: 'workbench-app:conversation:cancel',
  guidance: 'workbench-app:conversation:guidance',
  input: 'workbench-app:conversation:input',
  answer: 'workbench-app:conversation:answer',
  getGoal: 'workbench-app:conversation:get-goal',
  listNotes: 'workbench-app:conversation:list-notes',
  readNote: 'workbench-app:conversation:read-note',
  notesChanged: 'workbench-app:conversation:notes-changed',
  updateGoal: 'workbench-app:conversation:update-goal',
  deleteSession: 'workbench-app:conversation:delete-session',
  backupHistory: 'workbench-app:conversation:backup-history',
  engines: 'workbench-app:conversation:engines',
  recover: 'workbench-app:conversation:recover',
  event: 'workbench-app:conversation:event',
} as const

/** 与 Desktop 项目会话相同的权限确认档；原生程序确认与项目沙箱分别控制。 */
export type WorkbenchPermissionConfirmationMode = 'standard-open' | 'never-ask' | 'ask-every-time'

export const WorkbenchPermissionConfirmationModes: readonly WorkbenchPermissionConfirmationMode[] =
  ['standard-open', 'never-ask', 'ask-every-time']

export type WorkbenchExecutionMode = 'goal' | 'plan'

/** 这一轮用的模型：服务商与模型名，自带密钥的服务商带上密钥与地址（思考力度另给）。 */
export type WorkbenchConversationModelSelection = Pick<
  ModelSelection,
  'provider' | 'model' | 'apiKey' | 'baseURL'
>

/** 随消息发出的图片（base64，不带 data: 前缀）。 */
export interface WorkbenchConversationImage {
  data: string
  mediaType: string
  label?: string
}

/** 网上查资料（`velaros:web`）先用的搜索引擎；搜不通时 Platform 自动换另一个。 */
export type WorkbenchWebSearchEngine = 'google' | 'bing'

export const WorkbenchWebSearchEngines: readonly WorkbenchWebSearchEngine[] = ['google', 'bing']

/**
 * 外部 Agent 引擎：本机装好的 Claude Code 与 Codex 命令行。会话交给它们时，模型、登录、工具与上下文都是
 * 引擎自己的；Workbench 只把输入交过去，把它的回答、工具调用和请求确认画进对话。
 */
export type WorkbenchAgentEngineId = 'claude-code' | 'codex'

export const WorkbenchAgentEngineIds: readonly WorkbenchAgentEngineId[] = ['claude-code', 'codex']

/** 这一轮交给哪个外部引擎、用它的哪个模型；不给模型就用引擎自己的默认。 */
export interface WorkbenchConversationEngineSelection {
  id: WorkbenchAgentEngineId
  model?: string
}

/** 外部引擎报上来的一个模型。 */
export interface WorkbenchAgentEngineModel {
  value: string
  label: string
  description?: string
  isDefault?: boolean
}

/** 外部引擎为什么不能用：没装、没登录，或探的时候出了别的错。 */
export type WorkbenchAgentEngineProblem = 'missing' | 'signed-out' | 'error'

/** 一个外部引擎在本机的情况：能不能用（装了、登录了）、为什么不能用、有哪些模型。 */
export interface WorkbenchAgentEngineStatus {
  id: WorkbenchAgentEngineId
  available: boolean
  problem?: WorkbenchAgentEngineProblem
  /** 不能用的原因，原样给用户看。 */
  reason?: string
  version?: string
  models: WorkbenchAgentEngineModel[]
}

export interface WorkbenchAgentEngineStatusRequest {
  /** 丢掉上次探到的结果重新探（装好或登录之后）。 */
  refresh?: boolean
}

export interface WorkbenchConversationSendRequest {
  sessionId: string
  projectRoot: string
  /** 这条用户消息在界面上的 id：引导被读走时按它回执（`input-applied`）。 */
  inputId: string
  text: string
  images?: WorkbenchConversationImage[]
  locale: AppLocale
  model: WorkbenchConversationModelSelection
  reasoningLevel: ReasoningLevel
  executionModes: WorkbenchExecutionMode[]
  permissionMode: WorkbenchPermissionConfirmationMode
  /** 本轮使用工作区写入沙箱。 */
  sandbox?: boolean
  /** 长期记忆（设置里的总开关）：关着时这一轮不接记忆，已存的留在盘上。 */
  memory: boolean
  webSearchEngine: WorkbenchWebSearchEngine
  /** 这个会话交给外部引擎执行；不给就是 VelarOS 自己的 Agent（上面的模型、记忆、搜索引擎只对它有效）。 */
  engine?: WorkbenchConversationEngineSelection
}

/** 会话按 (项目根, 会话) 认：窗口只能动自己打开的项目里的会话。 */
export interface WorkbenchConversationSessionRequest {
  sessionId: string
  projectRoot: string
}

export interface WorkbenchConversationCancelResult {
  aborted: boolean
  /** 停下时还没被读走的引导（界面把它们记为已暂停）。 */
  retainedInputIds?: string[]
}

export interface WorkbenchConversationGuidanceRequest extends WorkbenchConversationSessionRequest {
  inputId: string
  text: string
}

export interface WorkbenchConversationInputRequest extends WorkbenchConversationSessionRequest {
  answer: string
}

export interface WorkbenchConversationAnswerRequest extends WorkbenchConversationSessionRequest {
  requestId: string
  answer: InteractionAnswer
}

export interface WorkbenchConversationUpdateGoalRequest extends WorkbenchConversationSessionRequest {
  action: ChatGoalLifecycleAction
  baseRevision: number
}

export interface WorkbenchConversationGoalResult {
  goal: Nullable<ActiveContextArtifact>
}

/**
 * 聊天历史的落盘备份（从旧 Kernel 通道搬来，行为不变）：会话权威仍在 renderer，这只是防 localStorage
 * 被清空或撞配额的兜底；主进程把 payload 当不透明字符串原样写盘。
 */
export interface WorkbenchConversationBackupRequest {
  /** 备份分片键（renderer 的会话存储键）。 */
  key: string
  /** 已序列化的会话 JSON。 */
  payload: string
}

// ---------------------------------------------------------------------------------------------
// 运行中推给窗口的通知（按种类区分载荷，与 Desktop 同名同形）
// ---------------------------------------------------------------------------------------------

export const ConversationTextNotice = 'conversation-text'
/** 一个模型回合的正文：preview 是到目前为止的整段预览，accepted 换成接纳的正文，rejected 撤回预览。 */
export interface ConversationTextProjection {
  /** `conversation:${runId}:${turnId}`；执行记录读不到之类的说明另有固定 id。 */
  id: string
  runId: string
  turnId: string
  phase: 'preview' | 'accepted' | 'rejected'
  text: string
}

export const ConversationThinkingNotice = 'conversation-thinking'
export const ConversationThinkingMaxChars = 200_000
/** 一个模型回合的思考摘要：update 是到目前为止的整段，rejected 撤掉。 */
export interface ConversationThinkingProjection {
  /** `conversation:thinking:${runId}:${turnId}` */
  id: string
  runId: string
  turnId: string
  phase: 'update' | 'rejected'
  text: string
}

export const ConversationScriptNotice = 'conversation-script'
export type ConversationScriptKind = 'execute' | 'observe' | 'blobs'
export type ConversationScriptStatus =
  'writing' | 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'
/** 一段脚本（模型写的 execute / observe 程序）；discarded 表示这一回合协议没通过，卡片撤下。 */
export interface ConversationScriptProjection {
  /** `conversation:script:${runId}:${turnId}:${index}`，追踪补上的是 `…:${executionId}` 或 `…:observe`。 */
  id: string
  kind: ConversationScriptKind
  runId: string
  turnId: string
  status: ConversationScriptStatus | 'discarded'
  startedAt?: number
  source: string
  sourceTruncated: boolean
  language?: 'node' | 'shell'
  processOutput?: string
  processOutputTruncated?: boolean
  /** 这次执行落定的能力调用，按发出顺序；观察卡是最近一次观察运行的调用。 */
  calls: ActInvocationSummary[]
  error: Nullable<string>
  durationMs: Nullable<number>
}
export const ConversationScriptSourceMaxChars = 20_000
/** 仅限制卡片预览，原始执行追踪保留全文；超出时截断展示，不能丢弃状态更新。 */
export const ConversationScriptPreviewLimits = { inputChars: 2_000, outputChars: 6_000 } as const

export const ConversationAgentNotice = 'conversation-agent'
export type ConversationAgentStatus =
  'running' | 'awaiting_input' | 'completed' | 'failed' | 'aborted'
/** 一次子任务（`velaros:agents`）派发或续跑：挂在派发它的那张脚本卡后面。 */
export interface ConversationAgentProjection {
  /** `conversation:agent:${executionId}:${jobId}:${n}` */
  id: string
  agentId?: string
  model?: string
  activity?: Array<
    | { kind: 'conversation-script'; payload: ConversationScriptProjection; timestamp?: number }
    | { kind: 'conversation-text'; payload: ConversationTextProjection; timestamp?: number }
  >
  /** 派发它的脚本卡；对不上卡时为 null。 */
  anchorId: Nullable<string>
  task: string
  profile: string
  status: ConversationAgentStatus
  answer: string
  error: Nullable<string>
  startedAt: number
  updatedAt: number
}
export const ConversationAgentTextMaxChars = 8_000

export const ConversationWidgetNotice = 'conversation-widget'
/** 模型用 `velaros:widget` 画出来的小部件。 */
export interface ConversationWidgetProjection {
  id: string
  runId: string
  title: string
  code: string
  height: number
}
export const ConversationWidgetLimits = Object.freeze({
  titleChars: 200,
  codeChars: 120_000,
  minHeight: 120,
  maxHeight: 900,
})

export const ConversationInteractionNotice = 'conversation-interaction'
/** 与用户的交互请求（提问、选项、表单、确认、危险命令确认）：运行消息里的一张交互卡。 */
export type ConversationInteractionProjection = Omit<InteractionBlock, 'type'> & { runId: string }
export const ConversationInteractionLimits = Object.freeze({
  messageChars: 8_000,
  answerChars: 8_000,
})

export const ConversationProjectActivityNotice = 'conversation-project-activity'
/** Agent 改项目的一段时间窗刚结束（一次项目编辑或一条命令跑完）：界面据此刷新「本轮改动」与 Git 状态。 */
export interface ConversationProjectActivityProjection {
  runId: Nullable<string>
}

export const ConversationToolCallNotice = 'conversation-tool-call'
/**
 * 外部引擎的一次工具调用（Claude Code、Codex 自己的读写文件、跑命令、搜索……）：运行消息里的一张工具卡。
 * 工具名用界面认得的那套（`project:run`、`project:edit`……），标题写这一次做什么；同一次调用的开始、
 * 进度与结果按 id 原位替换。
 */
export interface ConversationToolCallProjection {
  /** `conversation:tool:${runId}:${引擎给的调用身份}` */
  id: string
  runId: string
  toolName: string
  title: string
  args: Record<string, unknown>
  isRunning: boolean
  /** 跑着时的输出末尾。 */
  progress?: string
  result?: unknown
  error?: string
  startedAt: number
  finishedAt?: number
}
export const ConversationToolCallLimits = Object.freeze({
  titleChars: 200,
  /** 参数、结果各自序列化后的上限；超出的截断成文本。 */
  payloadChars: 20_000,
  progressChars: 4_000,
})

export const ConversationCommandOutputNotice = 'conversation-command-output'
/** 脚本卡上在跑的命令的末尾输出；id 是脚本卡的 id，空串表示没有在跑的输出了。 */
export interface ConversationCommandOutputProjection {
  id: string
  text: string
}
export const ConversationCommandOutputMaxChars = 2_000

// ---------------------------------------------------------------------------------------------
// 运行状态（界面状态行、运行标记与收尾据此变化）
// ---------------------------------------------------------------------------------------------

export type WorkbenchConversationState =
  | { kind: 'phase'; teamPhase: TeamExecutionPhase }
  | { kind: 'turn-start'; turn: number }
  | { kind: 'turn-end'; turn: number }
  | { kind: 'reconnecting'; attempt: number; message?: string }
  | { kind: 'input-applied'; inputId: string }
  | ({
      kind: 'usage-telemetry'
      requestId?: string
      agentSessionId?: string
      agentRole?: 'parent' | 'child'
      coverage?: 'known' | 'unknown' | 'inflight'
    } & Omit<StreamUsageTelemetryPayload, 'kind'>)
  | WorkbenchConversationContextUsage
  | {
      kind: 'awaiting-confirmation'
      executionId: string
      confirmationId: string
      confirmationMessage: string
    }
  | { kind: 'awaiting-input'; executionId: string; question: string }
  | {
      kind: 'done'
      goalStatus?: 'active' | 'paused' | 'complete' | 'blocked' | 'cancelled' | 'removed'
    }
  | { kind: 'aborted'; message: string }
  | { kind: 'error'; message: string }

/** 一次模型请求的上下文占用（分子是服务商报告的输入 token，分母是模型的输入上限）。 */
export interface WorkbenchConversationContextUsage {
  kind: 'context-usage-estimate'
  turn: number
  model: string
  estimatedTokens: number
  contextWindow: number
  usableContextWindow: number
  /** 当前容量仍是试探预算，超限后按服务商反馈调整。 */
  contextWindowEstimated?: boolean
  reservedOutputTokens: number
  percent: number
  timestamp: number
}

export type WorkbenchConversationStreamEvent =
  | { type: 'notice'; kind: string; payload: unknown }
  | { type: 'state'; payload: WorkbenchConversationState }

export interface WorkbenchConversationRecoveryRun extends WorkbenchConversationSessionRequest {
  id: string
  inputId: string
  goalMode: boolean
  startedAt: number
}
export interface WorkbenchConversationRecoveryPage {
  run: WorkbenchConversationRecoveryRun
  events: WorkbenchConversationEventEnvelope[]
  active: boolean
  nextAfter: number
  hasMore: boolean
}
export interface WorkbenchConversationEventEnvelope {
  streamId?: string
  sequence?: number
  emittedAt?: number
  sessionId: string
  projectRoot: string
  event: WorkbenchConversationStreamEvent
}

export interface WorkbenchConversationBridge {
  recover(
    request: WorkbenchConversationSessionRequest & { streamId?: string; after?: number }
  ): Promise<WorkbenchFsCallResult<WorkbenchConversationRecoveryPage | null>>
  /** 这一条输入被运行时接纳就返回（不等整轮跑完）；整轮收尾经事件流里的终态状态告知。 */
  send(request: WorkbenchConversationSendRequest): Promise<WorkbenchFsCallResult<void>>
  cancel(
    request: WorkbenchConversationSessionRequest
  ): Promise<WorkbenchFsCallResult<WorkbenchConversationCancelResult>>
  guidance(request: WorkbenchConversationGuidanceRequest): Promise<WorkbenchFsCallResult<void>>
  input(request: WorkbenchConversationInputRequest): Promise<WorkbenchFsCallResult<void>>
  answer(request: WorkbenchConversationAnswerRequest): Promise<WorkbenchFsCallResult<void>>
  listNotes(
    request: WorkbenchConversationSessionRequest & { after?: string; limit?: number }
  ): Promise<WorkbenchFsCallResult<Awaited<ReturnType<VelarosSession['listNotes']>>>>
  readNote(
    request: WorkbenchConversationSessionRequest & RuntimeNoteRead
  ): Promise<WorkbenchFsCallResult<RuntimeNoteContent>>
  onNotesChanged(listener: (ref: WorkbenchConversationSessionRequest) => void): () => void
  getGoal(
    request: WorkbenchConversationSessionRequest
  ): Promise<WorkbenchFsCallResult<WorkbenchConversationGoalResult>>
  updateGoal(
    request: WorkbenchConversationUpdateGoalRequest
  ): Promise<WorkbenchFsCallResult<WorkbenchConversationGoalResult>>
  deleteSession(request: WorkbenchConversationSessionRequest): Promise<WorkbenchFsCallResult<void>>
  backupHistory(
    request: WorkbenchConversationBackupRequest
  ): Promise<WorkbenchFsCallResult<{ path: string }>>
  /** 外部引擎（Claude Code、Codex）在本机的情况；探一次要起一回命令行，结果在主进程里缓存。 */
  engines(
    request: WorkbenchAgentEngineStatusRequest
  ): Promise<WorkbenchFsCallResult<WorkbenchAgentEngineStatus[]>>
  onEvent(listener: (envelope: WorkbenchConversationEventEnvelope) => void): () => void
}
