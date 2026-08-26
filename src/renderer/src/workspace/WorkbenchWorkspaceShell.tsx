/**
 * 打开项目后的工作台装配根：窗口内容直接由完整 IDE surface 接管。
 *
 * 项目状态唯一权威在 main 侧项目枢纽（ProjectHub）；这里把当前项目根以
 * `lockedProjectRootPath + registerLockedProject` 喂给页面 model——语义与 desktop
 * hook 发起的项目窗口一致：正式注册进项目列表并锁定为活跃项目。最近项目状态
 * 继续由 main 侧权威传入，供统一顶部项目控件做当前窗口切换或新窗口打开。
 */
import { type ReactElement } from 'react'

import type { WorkbenchOpenedProject, WorkbenchProjectHubState } from '../../../shared/projectHub'
import { useStandaloneWorkbenchPageModel } from '../hooks/useStandaloneWorkbenchPageModel'
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

export function WorkbenchWorkspaceShell({
  project,
  projectHubState,
}: WorkbenchWorkspaceShellProps): ReactElement {
  return (
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
  )
}
