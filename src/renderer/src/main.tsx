/** 独立 Workbench 应用渲染进程入口：装配共享 UI、独立宿主端口与产品壳。 */
import ReactDOM from 'react-dom/client'
import { registerWorkbenchEditorLanguage } from '@renderer/language/workbenchEditorLanguageContributions'
import { WorkbenchRuntimeProvider } from '@renderer/runtime'

import { VelarWorkbenchLanguageService } from '@shared/contributions/velar/service'
import { registerWorkbenchLanguageService } from '@shared/language/workbenchLanguageServices'

import { VelarWorkbenchEditorLanguage } from './contributions/velar/editor'
import { installStandaloneWorkbenchHost } from './host/standaloneWorkbenchHost'
import { StandaloneWorkbenchApp } from './StandaloneWorkbenchApp'

import '@velaros-ai/ui/styles/tokens/design-tokens.css'
import '@velaros-ai/ui/styles/components/index.css'
import '@velaros-ai/ui/styles/components/product.css'
import './index.css'

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
