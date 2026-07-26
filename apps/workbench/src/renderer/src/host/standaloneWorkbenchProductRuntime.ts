import { Result } from '@velaros-ai/core'
import type { WorkbenchProductRuntimeValue } from '@velaros-ai/workbench/composition'
import type {
  AuxiliaryModelConfig,
  AuxiliaryModelConfigs,
} from '@velaros-ai/workbench/contracts'

import chatStyles from './standaloneWorkbenchChat.module.css'

/**
 * 独立 Workbench 应用的产品运行时投影。
 *
 * Desktop 从自身 AppConfig / CSS Module 投影出这份 value；独立应用通过 Kernel 配置模型能力，
 * 这里只保留不含密钥的辅助模型默认值。样式由独立宿主自己的 CSS Module 提供。
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
    chatPanel: chatStyles as WorkbenchProductRuntimeValue['ui']['chatPanel'],
  },
}
