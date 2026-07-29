import { type ReactElement, useEffect, useState } from 'react'

import { BrowserCompositionProvider } from '@velaros-ai/browser/composition'
import {
  WorkbenchChatProvider,
  WorkbenchProductRuntimeProvider,
} from '@velaros-ai/workbench/composition'
import { WorkbenchLocalizationProvider } from '@velaros-ai/workbench/i18n'

import { standaloneBrowserCompositionAdapter } from './browser/standaloneBrowserCompositionAdapter'
import { standaloneWorkbenchProductRuntimeValue } from './host/standaloneWorkbenchProductRuntime'
import { useStandaloneWorkbenchLocalization } from './i18n/useStandaloneWorkbenchLocalization'
import { useProjectHubState } from './projectHub/useProjectHubState'
import { NewProjectDialog } from './welcome/NewProjectDialog'
import { WorkbenchWelcomePage } from './welcome/WorkbenchWelcomePage'
import { standaloneWorkbenchChatAdapter } from './workbench/runtime/standaloneWorkbenchChatAdapter'
import { WorkbenchMessageHost } from './workbench/runtime/workbenchMessageHost'
import { WorkbenchWorkspaceShell } from './workspace/WorkbenchWorkspaceShell'

/**
 * 独立 Workbench 应用的产品壳：起手页 ↔ 工作台按项目状态切换。
 *
 * 无项目 = 起手页（新建 / 打开 / 最近项目）；打开项目 = 完整工作台。
 * 项目状态唯一权威在 main 侧项目枢纽，这里只投影。三层 Provider：本地化（应用自持语言包）、
 * 产品运行时、独立持久化 chat 装配与发布版 Browser composition。chat 通过受控
 * Kernel 语义路由执行；Kernel 缺席时在会话面显示可重试错误，不创建第二套 Agent。
 */
export function StandaloneWorkbenchApp(): ReactElement {
  const { state, ready } = useProjectHubState()
  const [newProjectDialogOpen, setNewProjectDialogOpen] = useState(false)
  const localization = useStandaloneWorkbenchLocalization()

  useEffect(
    () =>
      window.velarosWorkbenchProjectHub.onMenuCommand((command) => {
        if (command === 'new-project') setNewProjectDialogOpen(true)
      }),
    []
  )

  if (!ready) return <></>

  return (
    <WorkbenchLocalizationProvider value={localization}>
      <WorkbenchProductRuntimeProvider value={standaloneWorkbenchProductRuntimeValue}>
        <BrowserCompositionProvider adapter={standaloneBrowserCompositionAdapter}>
          <WorkbenchChatProvider adapter={standaloneWorkbenchChatAdapter}>
            {state.currentProject ? (
              <WorkbenchWorkspaceShell project={state.currentProject} />
            ) : (
              <WorkbenchWelcomePage
                state={state}
                onNewProject={() => setNewProjectDialogOpen(true)}
              />
            )}
            <NewProjectDialog open={newProjectDialogOpen} onOpenChange={setNewProjectDialogOpen} />
            <WorkbenchMessageHost />
          </WorkbenchChatProvider>
        </BrowserCompositionProvider>
      </WorkbenchProductRuntimeProvider>
    </WorkbenchLocalizationProvider>
  )
}
