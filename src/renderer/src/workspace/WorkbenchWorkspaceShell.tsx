/**
 * 打开项目后的工作台装配根：窗口内容直接由完整 IDE surface 接管。
 *
 * 项目状态唯一权威在 main 侧项目枢纽（ProjectHub）；这里把当前项目根以
 * `lockedProjectRootPath + registerLockedProject` 喂给页面 model——语义与 desktop
 * hook 发起的项目窗口一致：正式注册进项目列表并锁定为活跃项目。关闭项目仍由原生
 * “文件”菜单提供，不在 IDE 顶部重复造一条项目栏。
 */
import { type ReactElement } from 'react'

import type { WorkbenchOpenedProject } from '../../../shared/projectHub'
import { useStandaloneWorkbenchPageModel } from '../hooks/useStandaloneWorkbenchPageModel'
import { StandaloneWorkbenchPagePresentation } from '../StandaloneWorkbenchPagePresentation'
import { WorkbenchPageModelProvider } from '../WorkbenchPageModelContext'

import './workspaceShell.css'

interface WorkbenchWorkspaceShellProps {
  project: WorkbenchOpenedProject
}

function WorkbenchProjectStage({ project }: WorkbenchWorkspaceShellProps): ReactElement {
  const model = useStandaloneWorkbenchPageModel({
    lockedProjectRootPath: project.path,
    registerLockedProject: true,
  })

  return (
    <WorkbenchPageModelProvider model={model}>
      <StandaloneWorkbenchPagePresentation />
    </WorkbenchPageModelProvider>
  )
}

export function WorkbenchWorkspaceShell({ project }: WorkbenchWorkspaceShellProps): ReactElement {
  return (
    <div className="workbench-workspace-shell">
      <main className="workbench-workspace-shell__stage">
        {/* key=项目根：切换项目时整棵 IDE 状态树重建，避免跨项目残留。 */}
        <WorkbenchProjectStage key={project.path} project={project} />
      </main>
    </div>
  )
}
