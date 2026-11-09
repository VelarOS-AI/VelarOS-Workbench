import type { AppLocale, ReasoningLevel } from '@velaros-ai/ui/conversation/contracts'

import type {
  WorkbenchAgentEngineId,
  WorkbenchAgentEngineStatus,
  WorkbenchConversationImage,
  WorkbenchExecutionMode,
  WorkbenchPermissionConfirmationMode,
} from '../../shared/workbenchConversation'
import type { WorkbenchConversationRef } from '../conversation/WorkbenchConversationRuntime'

import type { EngineRunSurface } from './WorkbenchEngineRunSurface'

/** 交给外部引擎的一轮。 */
export interface WorkbenchEngineRunInput {
  ref: WorkbenchConversationRef
  text: string
  images: readonly WorkbenchConversationImage[]
  /** 引擎的模型；不给就用引擎自己的默认。 */
  model?: string
  reasoningLevel: ReasoningLevel
  executionModes: readonly WorkbenchExecutionMode[]
  permissionMode: WorkbenchPermissionConfirmationMode
  locale: AppLocale
  /** 上一轮留下的引擎会话身份；没有就新开一段。 */
  resume: Nullable<string>
  /** 这一轮的展示面：正文、工具卡、确认与提问都经它推给窗口。 */
  surface: EngineRunSurface
  /** 引擎开了（或换了）会话：记下来，下一轮接着它。 */
  sessionStarted(nativeId: string): Promise<void>
  /** 上一轮留下的会话接不上了（引擎那边没了）：忘掉它，这一轮已经另开。 */
  sessionLost(): Promise<void>
  /** 引擎收下了这条输入（界面以此为「已发出」）。 */
  accepted(): void
  signal: AbortSignal
}

/** 一轮的结局：跑完或被停下；失败直接抛错，错误说明原样给用户看。 */
export interface WorkbenchEngineRunResult {
  status: 'completed' | 'aborted'
}

/** 一个外部引擎：探本机情况，跑一轮。 */
export interface WorkbenchAgentEngine {
  readonly id: WorkbenchAgentEngineId
  readonly label: string
  /** 探一次本机情况（装没装、登没登录、模型目录）。探不到不抛错，结论里写原因。 */
  status(signal?: AbortSignal): Promise<WorkbenchAgentEngineStatus>
  run(input: WorkbenchEngineRunInput): Promise<WorkbenchEngineRunResult>
  /** 停下常驻的子进程（应用退出时）。 */
  close(): Promise<void>
}
