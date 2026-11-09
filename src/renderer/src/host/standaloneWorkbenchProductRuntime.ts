import { type WorkbenchProductRuntimeValue } from '@renderer/composition/WorkbenchProductRuntimeProvider'

import chatStyles from '../styles/standaloneWorkbenchChat.module.css'

/**
 * 独立 Workbench 应用的产品运行时投影。
 *
 * 编辑器、Git 和聊天样式由产品提供；模型配置由独立模型配置模块持有。
 */
export const standaloneWorkbenchProductRuntimeValue: WorkbenchProductRuntimeValue = {
  config: {
    defaultEditor: 'velaros-light',
    git: {
      githubToken: '',
      privateKeyPath: '',
    },
  },
  ui: {
    chatPanel: chatStyles as WorkbenchProductRuntimeValue['ui']['chatPanel'],
  },
}
