/** 独立 Workbench 应用渲染进程入口：装配共享 UI、独立宿主端口与产品壳。 */
// 全局样式表必须先于一切应用模块求值，产品样式才排在共享原语之后（见 globalStyles.ts）。
import './globalStyles'

import ReactDOM from 'react-dom/client'
import { registerWorkbenchEditorLanguage } from '@renderer/language/workbenchEditorLanguageContributions'
import { WorkbenchRuntimeProvider } from '@renderer/runtime'

import { VelarWorkbenchLanguageService } from '@shared/contributions/velar/service'
import { registerWorkbenchLanguageService } from '@shared/language/workbenchLanguageServices'

import { VelarWorkbenchEditorLanguage } from './contributions/velar/editor'
import { installStandaloneWorkbenchHost } from './host/standaloneWorkbenchHost'
import { StandaloneWorkbenchApp } from './StandaloneWorkbenchApp'

registerWorkbenchEditorLanguage(VelarWorkbenchEditorLanguage)
registerWorkbenchLanguageService(VelarWorkbenchLanguageService)

const workbenchRuntime = installStandaloneWorkbenchHost()

const rootElement = document.querySelector('#root')

if (!rootElement) {
  throw new Error('Missing standalone Workbench root element')
}

ReactDOM.createRoot(rootElement).render(
  <WorkbenchRuntimeProvider runtime={workbenchRuntime}>
    <StandaloneWorkbenchApp />
  </WorkbenchRuntimeProvider>
)
