import type { ActiveContextArtifact, ChatGoalLifecycleAction } from '@velaros-ai/agent/protocol'

import type { WorkbenchAgentUiResponse } from './workbenchAgentUi'

export const WorkbenchKernelChannels = {
  getStatus: 'workbench-app:kernel:get-status',
  invoke: 'workbench-app:kernel:invoke',
  abortAgentExecution: 'workbench-app:kernel:abort-agent-execution',
  resolveAgentInput: 'workbench-app:kernel:resolve-agent-input',
  resolveAgentConfirmation: 'workbench-app:kernel:resolve-agent-confirmation',
  provideAgentGuidance: 'workbench-app:kernel:provide-agent-guidance',
  statusChanged: 'workbench-app:kernel:status-changed',
  agentExecution: 'workbench-app:kernel:agent-execution',
  backupChatHistory: 'workbench-app:kernel:backup-chat-history',
  getGoalLifecycle: 'workbench-app:kernel:get-goal-lifecycle',
  updateGoalLifecycle: 'workbench-app:kernel:update-goal-lifecycle',
  releaseAgentSession: 'workbench-app:kernel:release-agent-session',
  respondAgentUiRequest: 'workbench-app:kernel:respond-agent-ui-request',
} as const

/**
 * 聊天历史的落盘备份请求。
 *
 * **这不是会话权威**——权威仍在 renderer（见 `standaloneWorkbenchChatAdapter`），本通道只是
 * 防「localStorage 被清空或撞配额即全丢」的兜底出口。主进程把 `payload` 当**不透明字符串**
 * 原样落盘，不解释也不校验内容形状；将来会话权威上收到主进程时，这条通道可以整条删掉，
 * 不会留下需要迁移的 schema。
 */
export interface WorkbenchChatHistoryBackupRequest {
  /** 备份分片键：一个项目根一份。 */
  projectRoot: string
  /** 已序列化的会话 JSON。 */
  payload: string
}

export type WorkbenchChatHistoryBackupResult =
  | { ok: true; path: string }
  | { ok: false; message: string }

export interface WorkbenchKernelScopeRef {
  id: string
  ownerModuleId: string
  kind: string | null
}

/**
 * Renderer-visible semantic route names.
 *
 * The renderer never supplies raw capability ids or operation names. The main
 * composition root maps these stable product intentions to capabilities the
 * in-process Kernel host actually registered.
 *
 * Browser Mod 使用独立的、绑定窗口项目所有权的 typed bridge；它不暴露在这条通用
 * renderer Kernel invoke 面上。
 */
export type WorkbenchKernelCapabilityRoute =
  | 'agent.execute'
  | 'agent.health'

export interface WorkbenchKernelInvokeRequest {
  route: WorkbenchKernelCapabilityRoute
  scope?: WorkbenchKernelScopeRef | null
  input: unknown
}

export interface WorkbenchAbortAgentExecutionRequest {
  executionId: string
}

export interface WorkbenchResolveAgentInputRequest {
  sessionId: string
  answer: string
}

/**
 * 运行中补发的**引导**：注入正在执行的这一轮，由主 Agent 在下一个轮次边界读到，不另起一轮。
 * `inputId` 就是 renderer 里那条引导消息的 id——被模型读到时回一条 `input-applied` 运行时事件。
 */
export interface WorkbenchProvideAgentGuidanceRequest {
  sessionId: string
  inputId: string
  text: string
}

/** 会话的目标（目标模式建立、目标卡显示）。 */
export interface WorkbenchGoalLifecycleRequest {
  sessionId: string
}

/** 目标卡上的暂停、继续、移除；非「继续」的动作会停下正在跑的这一轮（与 Desktop 相同）。 */
export interface WorkbenchUpdateGoalLifecycleRequest extends WorkbenchGoalLifecycleRequest {
  action: ChatGoalLifecycleAction
}

/** `ok:false` 是软失败（没有目标、写入失败）：卡片保留当前状态。 */
export type WorkbenchGoalLifecycleResult =
  | { ok: true; goal: ActiveContextArtifact | null }
  | { ok: false; message: string }

/** 会话被移除时释放它在主进程里的执行装配与活动上下文（目标、计划制品）。 */
export interface WorkbenchReleaseAgentSessionRequest {
  sessionId: string
}

export interface WorkbenchResolveAgentConfirmationRequest {
  sessionId: string
  approved: boolean
  rejectionMessage?: string
}

export interface WorkbenchKernelInvocationError {
  code: string
  message: string
  retryable: boolean
  details: Readonly<Record<string, unknown>> | null
}

export type WorkbenchKernelInvokeResult =
  | { ok: true; output: unknown }
  | { ok: false; error: WorkbenchKernelInvocationError }

/** 进程内 Kernel host 的生命周期态（无「连接」语义，宿主起即在）。 */
export type WorkbenchKernelRuntimeState = 'starting' | 'ready' | 'degraded' | 'disposed'

export interface WorkbenchKernelCapabilityStatus {
  id: string
  version: string
  moduleId: string
  moduleVersion: string
}

export interface WorkbenchKernelModuleStatus {
  id: string
  version: string
  generation: number
  lifecycleStatus: string
  healthStatus: string
  error?: string
}

export interface WorkbenchKernelRuntimeError {
  code: string
  message: string
  retryable: boolean
}

/**
 * Renderer 侧的进程内 Kernel 投影。
 *
 * `connected` 保留为「能力面可用」的语义位（不再表示跨进程连接），让既有消费面
 * 无需改判即可继续用它做可用性门。
 */
export interface WorkbenchKernelStatus {
  state: WorkbenchKernelRuntimeState
  connected: boolean
  checkedAt: number | null
  kernelVersion: string
  modules: readonly WorkbenchKernelModuleStatus[]
  capabilities: readonly WorkbenchKernelCapabilityStatus[]
  error: WorkbenchKernelRuntimeError | null
}

export interface WorkbenchKernelBridge {
  getStatus: () => Promise<WorkbenchKernelStatus>
  invoke: (request: WorkbenchKernelInvokeRequest) => Promise<WorkbenchKernelInvokeResult>
  abortAgentExecution: (request: WorkbenchAbortAgentExecutionRequest) => Promise<boolean>
  resolveAgentInput: (request: WorkbenchResolveAgentInputRequest) => Promise<boolean>
  resolveAgentConfirmation: (
    request: WorkbenchResolveAgentConfirmationRequest
  ) => Promise<boolean>
  /** 返回 false = 当前没有可接收引导的运行（已结束或不是原生执行栈），调用方应按普通消息处理。 */
  provideAgentGuidance: (request: WorkbenchProvideAgentGuidanceRequest) => Promise<boolean>
  onStatusChanged: (
    listener: (status: WorkbenchKernelStatus) => void
  ) => () => void
  onAgentExecution: (listener: (payload: unknown) => void) => () => void
  backupChatHistory: (
    request: WorkbenchChatHistoryBackupRequest
  ) => Promise<WorkbenchChatHistoryBackupResult>
  getGoalLifecycle: (request: WorkbenchGoalLifecycleRequest) => Promise<WorkbenchGoalLifecycleResult>
  updateGoalLifecycle: (
    request: WorkbenchUpdateGoalLifecycleRequest
  ) => Promise<WorkbenchGoalLifecycleResult>
  releaseAgentSession: (request: WorkbenchReleaseAgentSessionRequest) => Promise<void>
  /**
   * Agent 界面请求（打开文件、讲解气泡等）的回执。只有发起那一轮执行的窗口能回；返回 false =
   * 请求已经不在等（超时、这一轮已结束）或不属于本窗口。
   */
  respondAgentUiRequest: (response: WorkbenchAgentUiResponse) => Promise<boolean>
}
