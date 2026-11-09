/**
 * 打开项目后的工作台装配根：窗口内容直接由完整 IDE surface 接管。
 *
 * 项目状态和持久身份由 main 侧项目枢纽持有。登记成功后才挂载 IDE，最近项目状态
 * 继续由 main 侧传入，供顶部项目控件做当前窗口切换或新窗口打开。
 */
import { type ReactElement, useEffect, useState } from 'react'
import { WorkbenchChatProvider } from '@renderer/composition/WorkbenchChatProvider'
import { useWorkbenchI18n } from '@renderer/i18n/WorkbenchLocalizationProvider'

import {
  ConversationActionPortProvider,
  ConversationBlockHooksProvider,
  ConversationLocalizationProvider,
  ConversationRenderSlotsProvider,
} from '@velaros-ai/ui/conversation'
import { ConversationComposerPortProvider } from '@velaros-ai/ui/conversation/composer'
import { AppError } from '@velaros-ai/velaros/core/error'

import type {
  WorkbenchOpenedProject,
  WorkbenchProject,
  WorkbenchProjectHubState,
} from '../../../shared/projectHub'
import { useStandaloneWorkbenchPageModel } from '../hooks/useStandaloneWorkbenchPageModel'
import { readWorkbenchProjects } from '../models/project/workbenchProjects'
import { standaloneWorkbenchComposerPort } from '../runtime/conversation/standaloneWorkbenchComposerPort'
import { standaloneWorkbenchConversationActionPort } from '../runtime/conversation/standaloneWorkbenchConversationActionPort'
import { standaloneWorkbenchConversationBlockHooks } from '../runtime/conversation/standaloneWorkbenchConversationBlockHooks'
import { standaloneWorkbenchConversationRenderSlots } from '../runtime/conversation/standaloneWorkbenchConversationRenderSlots'
import { standaloneWorkbenchChatAdapter } from '../runtime/standaloneWorkbenchChatAdapter'

import { StandaloneWorkbenchPagePresentation } from './StandaloneWorkbenchPagePresentation'
import { WorkbenchPageModelProvider } from './WorkbenchPageModelContext'

import '../styles/workspaceShell.css'

interface WorkbenchWorkspaceShellProps {
  project: WorkbenchOpenedProject
  projectHubState: WorkbenchProjectHubState
}

function WorkbenchProjectStage({
  project,
  projectHubState,
}: {
  project: WorkbenchProject
  projectHubState: WorkbenchProjectHubState
}): ReactElement {
  const model = useStandaloneWorkbenchPageModel(project)

  return (
    <WorkbenchPageModelProvider model={model}>
      <StandaloneWorkbenchPagePresentation projectHubState={projectHubState} />
    </WorkbenchPageModelProvider>
  )
}

type ProjectRegistration =
  | { kind: 'loading' }
  | { kind: 'ready'; project: WorkbenchProject }
  | { kind: 'error'; message: string }

function WorkbenchRegisteredProjectStage({
  projectHubState,
}: {
  projectHubState: WorkbenchProjectHubState
}): ReactElement | null {
  const { t } = useWorkbenchI18n()
  const [registration, setRegistration] = useState<ProjectRegistration>({ kind: 'loading' })

  useEffect(() => {
    let disposed = false
    const legacyProjects = readWorkbenchProjects()
    void window.velarosWorkbenchProjectHub.resolveRegistration(legacyProjects).then(
      (project) => {
        if (!disposed) setRegistration({ kind: 'ready', project })
      },
      (error: unknown) => {
        if (!disposed) setRegistration({ kind: 'error', message: AppError.getMessage(error) })
      }
    )
    return () => {
      disposed = true
    }
  }, [])

  if (registration.kind === 'loading') return null
  if (registration.kind === 'error')
    return (
      <div role="alert">
        <strong>{t('workbench.openProjectFailed')}</strong>
        <p>{registration.message}</p>
      </div>
    )
  return <WorkbenchProjectStage project={registration.project} projectHubState={projectHubState} />
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
                    <WorkbenchRegisteredProjectStage
                      key={project.path}
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
