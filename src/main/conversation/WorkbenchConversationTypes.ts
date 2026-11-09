import type { SessionsSpacePort } from '@velaros-ai/capabilities/sessions'
import type { SessionAnswer } from '@velaros-ai/capabilities/sessions/contracts'
import type { WebSpacePort } from '@velaros-ai/capabilities/web'
import type { VelarosRuntime, VelarosSession } from '@velaros-ai/velaros'
import type { WidgetView } from '@velaros-ai/velaros/act/agents'
import type { MemoryScopeApi } from '@velaros-ai/velaros/memory'
import type { ModelDriver } from '@velaros-ai/velaros/model'
import type { NodeExecutionOutput } from '@velaros-ai/velaros/node'
import type { ActEventProjectorApi, ActPresentation } from '@velaros-ai/velaros/renderer'

import type {
  WorkbenchConversationSendRequest,
  WorkbenchPermissionConfirmationMode,
} from '../../shared/workbenchConversation'
import type { ConversationBrowser } from '../browser/WorkbenchBrowserService'
import type { WorkbenchAgentProjectActivityPort } from '../workspace/git/WorkbenchChatRunAttribution'

/** 当前模型驱动。 */
export type ConversationModel = ModelDriver

/** 模型驱动声明的窗口上限。 */
export type ConversationModelLimits = ModelDriver['limits'] & {
  /** 未经服务商确认的试探容量。 */
  readonly contextWindowEstimated?: boolean
}

/** Platform 实时事件。 */
export type ConversationSessionEvent = Awaited<
  ReturnType<VelarosSession['events']>
>[number]['event']

/** Platform 用户输入。 */
export type ConversationInput = Exclude<Parameters<VelarosSession['submit']>[0], string>

/** 一轮提交的回复语言与执行模式，外加项目里的 AI 规则：宿主说明按它写。 */
export type ConversationHostInstructionOptions = Pick<
  WorkbenchConversationSendRequest,
  'locale' | 'executionModes'
> & {
  projectRules?: readonly ConversationProjectRule[]
}

/** 项目里的一份 AI 规则文件（AGENTS.md、CLAUDE.md……）。 */
export interface ConversationProjectRule {
  relativePath: string
  content: string
}

/** 这一轮用的模型驱动，外加解析出的服务商（用量记录按它计价）与模型收不收图。 */
export interface ConversationRunConfiguration {
  model: ConversationModel
  provider: string
  /** 模型收图片输入；目录里查不到的模型按收图算。 */
  imageInput: boolean
}

/** 执行会话的模型、权限与取消边界。 */
export interface ConversationWorkspaceOptions {
  sessionId: string
  /** 这个会话在 Platform 数据区里的目录：上下文与运行状态都在这里。 */
  dataDir: string
  /** 项目根：项目模块、代码查询与 shell 都在它里面跑。 */
  workspace: string
  sandbox?: boolean
  instructions?: string
  /** 每帧随当地时间交给模型的宿主环境条目。 */
  environment?: () => Readonly<Record<string, string>>
  /** 把模型用 `velaros:widget` 交来的小部件显示到对话里。 */
  showWidget(widget: WidgetView): void
  /** 把 Node 执行进程跑着时吐出的输出画到它所在的脚本卡上。 */
  showCommandOutput(output: NodeExecutionOutput): void
  /** 这一轮 Agent 改项目的时间窗报到这里：「本轮改动」据此认出哪些改动是 Agent 做的。 */
  activity?: WorkbenchAgentProjectActivityPort
  /**
   * 一次项目编辑成功写完，带上它写到的路径（相对项目根）：语言服务据此当场刷新，不等文件监听。在那段改项目的
   * 时间窗关闭之前调用。
   */
  projectFilesEdited?(paths: readonly string[]): void
  /** 这一轮接的长期记忆作用域；没有就不挂记忆。 */
  memory?: MemoryScopeApi
  /** 网上查资料（`velaros:web`）的无头页面与搜索引擎；没有就不挂这个模块。 */
  web?: WebSpacePort
  /** 这个会话的 Agent 浏览器（velaros:browser / devtools / cdp 操作编辑区里的受控页面）；没有就不挂。 */
  browser?: ConversationBrowser
  sessions?: SessionsSpacePort
  model: ConversationModel
  confirmationMode: WorkbenchPermissionConfirmationMode
  signal: AbortSignal
}

/** 无执行链的状态控制：产品先核对当前项目，再打开同一执行身份的存储。 */
export interface ConversationControlOptions {
  sessionId: string
  dataDir: string
  workspace: string
}

/** 会话与其资源释放入口。 */
export interface ConversationWorkspaceHandle {
  session: VelarosSession
  trace?(input?: Parameters<VelarosRuntime['trace']>[1]): ReturnType<VelarosRuntime['trace']>
  close(): Promise<void>
}

export interface ConversationControlHandle {
  session: Pick<VelarosSession, 'listNotes' | 'readNote' | 'getGoal' | 'controlGoal'>
  close(): Promise<void>
}

/** 单次运行的资源及当前展示快照。 */
export interface ActiveConversationRun {
  outcome?: SessionAnswer
  controller: AbortController
  completed: Promise<void>
  handle?: ConversationWorkspaceHandle
  projector?: ActEventProjectorApi
  presentation?: ActPresentation['runs'][string]
  modelId?: string
  /** 这一轮解析出的服务商；用量记录带上它，按服务商计价。 */
  provider?: string
  /** 模型驱动的输入、输出与总窗口上限；上下文用量按它换算。 */
  modelLimits?: ConversationModelLimits
  /** 这一轮的界面语言。 */
  locale?: WorkbenchConversationSendRequest['locale']
}
