/** 独立 Workbench 应用渲染进程入口：装配 @velaros-ai/ui 令牌与组件样式，安装占位宿主，挂载产品壳。 */
import ReactDOM from 'react-dom/client'

import { installStandaloneWorkbenchHost } from './host/standaloneWorkbenchHost'
import { StandaloneWorkbenchApp } from './StandaloneWorkbenchApp'

import '@velaros-ai/ui/styles/tokens/design-tokens.css'
import '@velaros-ai/ui/styles/components/index.css'
import '@velaros-ai/ui/styles/components/product.css'
import './index.css'

installStandaloneWorkbenchHost()

const rootElement = document.querySelector('#root')

if (!rootElement) {
  throw new Error('Missing standalone Workbench root element')
}

ReactDOM.createRoot(rootElement).render(<StandaloneWorkbenchApp />)
