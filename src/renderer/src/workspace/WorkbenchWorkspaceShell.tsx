/**
 * 打开项目后的工作台装配根：窗口内容直接由完整 IDE surface 接管。
 *
 * 项目状态唯一权威在 main 侧项目枢纽（ProjectHub）；这里把当前项目根以
 * `lockedProjectRootPath + registerLockedProject` 喂给页面 model——语义与 desktop
 * hook 发起的项目窗口一致：正式注册进项目列表并锁定为活跃项目。最近项目状态
 * 继续由 main 侧权威传入，供统一顶部项目控件做当前窗口切换或新窗口打开。
 */
import { type ReactElement } from 'react'
import { WorkbenchChatProvider } from '@renderer/composition'
import { useWorkbenchI18n } from '@renderer/i18n'

import {
  ConversationActionPortProvider,
  ConversationBlockHooksProvider,
  ConversationLocalizationProvider,
  ConversationRenderSlotsProvider,
} from '@velaros-ai/ui/conversation'
import { ConversationComposerPortProvider } from '@velaros-ai/ui/conversation/composer'

import type { WorkbenchOpenedProject, WorkbenchProjectHubState } from '../../../shared/projectHub'
import { useStandaloneWorkbenchPageModel } from '../hooks/useStandaloneWorkbenchPageModel'
import { standaloneWorkbenchComposerPort } from '../runtime/conversation/standaloneWorkbenchComposerPort'
import { standaloneWorkbenchConversationActionPort } from '../runtime/conversation/standaloneWorkbenchConversationActionPort'
import { standaloneWorkbenchConversationBlockHooks } from '../runtime/conversation/standaloneWorkbenchConversationBlockHooks'
import { standaloneWorkbenchConversationRenderSlots } from '../runtime/conversation/standaloneWorkbenchConversationRenderSlots'
import { standaloneWorkbenchChatAdapter } from '../runtime/standaloneWorkbenchChatAdapter'
import { StandaloneWorkbenchPagePresentation } from '../StandaloneWorkbenchPagePresentation'
import { WorkbenchPageModelProvider } from '../WorkbenchPageModelContext'

import './workspaceShell.css'

interface WorkbenchWorkspaceShellProps {
  project: WorkbenchOpenedProject
  projectHubState: WorkbenchProjectHubState
}

function WorkbenchProjectStage({
  project,
  projectHubState,
}: WorkbenchWorkspaceShellProps): ReactElement {
  const model = useStandaloneWorkbenchPageModel({
    lockedProjectRootPath: project.path,
    registerLockedProject: true,
  })

  return (
    <WorkbenchPageModelProvider model={model}>
      <StandaloneWorkbenchPagePresentation projectHubState={projectHubState} />
    </WorkbenchPageModelProvider>
  )
}

/**
 * 聊天装配（共享会话 UI 的本地化、渲染槽、块钩子、动作端口、输入框端口与会话适配器）只在工作台里用得到：
 * 跟着工作台一起按需加载，起手页的启动包不带它。
 */
export function WorkbenchWorkspaceShell({
  project,
  projectHubState,
}: WorkbenchWorkspaceShellProps): ReactElement {
  const localization = useWorkbenchI18n()
  return (
    <ConversationLocalizationProvider value={localization}>
      <ConversationRenderSlotsProvider slots={standaloneWorkbenchConversationRenderSlots}>
        <ConversationBlockHooksProvider value={standaloneWorkbenchConversationBlockHooks}>
          <ConversationActionPortProvider value={standaloneWorkbenchConversationActionPort}>
            <ConversationComposerPortProvider value={standaloneWorkbenchComposerPort}>
              <WorkbenchChatProvider adapter={standaloneWorkbenchChatAdapter}>
                <div className="workbench-workspace-shell">
                  <main className="workbench-workspace-shell__stage">
                    {/* key=项目根：切换项目时整棵 IDE 状态树重建，避免跨项目残留。 */}
                    <WorkbenchProjectStage
                      key={project.path}
                      project={project}
                      projectHubState={projectHubState}
                    />
                  </main>
                </div>
              </WorkbenchChatProvider>
            </ConversationComposerPortProvider>
          </ConversationActionPortProvider>
        </ConversationBlockHooksProvider>
      </ConversationRenderSlotsProvider>
    </ConversationLocalizationProvider>
  )
}
