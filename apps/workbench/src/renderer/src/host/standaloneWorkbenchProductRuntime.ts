import { Result } from '@velaros-ai/core'
import type {
  AuxiliaryModelConfig,
  AuxiliaryModelConfigs,
} from '@velaros-ai/core/types'
import type { WorkbenchProductRuntimeValue } from '@velaros-ai/workbench/composition'

/**
 * 独立 Workbench 应用的产品运行时投影（占位实现）。
 *
 * Desktop 从自身 AppConfig / CSS Module 投影出这份 value；独立应用在接上 kernel 配置面之前，用中性
 * 默认值满足契约。样式类名留空（未样式化壳），后续独立宿主接自己的样式来源即可。
 */
const StandaloneAuxiliaryModel: AuxiliaryModelConfig = {
  provider: 'chat-config',
  model: '',
}

const standaloneAuxiliaryModels: AuxiliaryModelConfigs = {
  thinkingTranslation: StandaloneAuxiliaryModel,
  gitCommitMessage: StandaloneAuxiliaryModel,
  subAgentGuidanceRelay: StandaloneAuxiliaryModel,
  sessionHandoffBrief: StandaloneAuxiliaryModel,
  chatSuggestions: StandaloneAuxiliaryModel,
  webAgentDispatch: StandaloneAuxiliaryModel,
  editorTabCompletion: StandaloneAuxiliaryModel,
}

const StandaloneEmptyChatPanelStyles: WorkbenchProductRuntimeValue['ui']['chatPanel'] = {
  spinIcon: '',
  toolWindowPanel: '',
  workbenchChatBody: '',
  workbenchChatIconButton: '',
  workbenchChatLoading: '',
  workbenchChatPanel: '',
  workbenchChatSessionCurrentTitle: '',
  workbenchChatSessionMenuAnchor: '',
  workbenchChatSessionMenuButton: '',
  workbenchChatSessionMenuCheck: '',
  workbenchChatSessionMenuIcon: '',
  workbenchChatSessionMenuItem: '',
  workbenchChatSessionMenuList: '',
  workbenchChatSessionMenuPanel: '',
  workbenchChatSessionMenuText: '',
  workbenchChatSessionMenuTitle: '',
  workbenchChatTopBar: '',
}

export const standaloneWorkbenchProductRuntimeValue: WorkbenchProductRuntimeValue = {
  config: {
    defaultEditor: 'velaros-light',
    git: {
      githubToken: '',
      privateKeyPath: '',
      sshKeyPath: '',
    },
    model: {
      auxiliaryModels: standaloneAuxiliaryModels,
      providerRuntimeConfigs: [],
      setAuxiliaryModelConfig: () => Promise.resolve(Result.ok(undefined)),
    },
  },
  ui: {
    chatPanel: StandaloneEmptyChatPanelStyles,
  },
}
