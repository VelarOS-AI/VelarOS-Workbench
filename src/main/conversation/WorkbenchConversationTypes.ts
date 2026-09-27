import type {
  ShellInvocationOutput,
  VelarosRuntimeOptions,
  VelarosSession,
} from '@velaros-ai/velaros'
import type { WidgetView } from '@velaros-ai/velaros/act/agents'
import type { MemoryScopeApi } from '@velaros-ai/velaros/memory'
import type { ActEventProjectorApi, ActPresentation } from '@velaros-ai/velaros/renderer'
import type { WebSpacePort } from '@velaros-ai/velaros/web'

import type {
  WorkbenchConversationSendRequest,
  WorkbenchPermissionConfirmationMode,
} from '../../shared/workbenchConversation'
import type { WorkbenchAgentProjectActivityPort } from '../workspace/git/WorkbenchChatRunAttribution'

/** 当前模型驱动。 */
export type ConversationModel = NonNullable<VelarosRuntimeOptions['model']>

/** 模型驱动声明的窗口上限。 */
export type ConversationModelLimits = Extract<ConversationModel, { limits: unknown }>['limits']

/** Platform 实时事件。 */
export type ConversationSessionEvent = Awaited<
  ReturnType<VelarosSession['events']>
>[number]['event']

/** Platform 用户输入。 */
export type ConversationInput = Exclude<Parameters<VelarosSession['submit']>[0], string>

/** 一轮提交的回复语言与执行模式，外加项目里的 AI 规则与这一轮开始时的记忆索引：宿主说明按它写。 */
export type ConversationHostInstructionOptions = Pick<
  WorkbenchConversationSendRequest,
  'locale' | 'executionModes'
> & {
  projectRules?: readonly ConversationProjectRule[]
  memoryIndex?: string
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
  instructions?: string
  /** 每帧随当地时间交给模型的宿主环境条目。 */
  environment?: () => Readonly<Record<string, string>>
  /** 把模型用 `velaros:widget` 交来的小部件显示到对话里。 */
  showWidget(widget: WidgetView): void
  /** 把 `velaros:shell` 前台命令跑着时吐出的输出画到它所在的脚本卡上。 */
  showCommandOutput(output: ShellInvocationOutput): void
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
  model: ConversationModel
  confirmationMode: WorkbenchPermissionConfirmationMode
  signal: AbortSignal
}

/** 无模型的状态控制会话：只打开绑定工作区的存储。 */
export interface ConversationControlOptions {
  sessionId: string
  dataDir: string
  workspace: string
}

/** 会话与其资源释放入口。 */
export interface ConversationWorkspaceHandle {
  session: VelarosSession
  close(): Promise<void>
}

/** 单次运行的资源及当前展示快照。 */
export interface ActiveConversationRun {
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
