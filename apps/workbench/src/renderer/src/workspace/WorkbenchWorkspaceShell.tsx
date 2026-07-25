/**
 * 打开项目后的工作台外框：项目标识 + 关闭项目返回起手页，舞台装配完整 IDE surface
 * （文件树 + 编辑器纵切；git / 终端 / chrome 面随片4/片5 装入）。
 *
 * 项目状态唯一权威在 main 侧项目枢纽（ProjectHub）；这里把当前项目根以
 * `lockedProjectRootPath + registerLockedProject` 喂给页面 model——语义与 desktop
 * hook 发起的项目窗口一致：正式注册进项目列表并锁定为活跃项目。
 */
import { type ReactElement } from 'react'
import { XIcon } from '@phosphor-icons/react'

import { Button, Text, Title } from '@velaros/ui'

import type { WorkbenchOpenedProject } from '../../../shared/projectHub'
import { useStandaloneWorkbenchPageModel } from '../workbench/hooks/useStandaloneWorkbenchPageModel'
import { StandaloneWorkbenchPagePresentation } from '../workbench/StandaloneWorkbenchPagePresentation'
import { WorkbenchPageModelProvider } from '../workbench/WorkbenchPageModelContext'

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
      <header className="workbench-workspace-shell__top-bar">
        <div className="workbench-workspace-shell__identity">
          <Title level={5}>{project.name}</Title>
          <Text tone="caption" truncate className="workbench-workspace-shell__path">
            {project.path}
          </Text>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => void window.velarosWorkbenchProjectHub.closeProject()}
        >
          <XIcon size={14} />
          关闭项目
        </Button>
      </header>
      <main className="workbench-workspace-shell__stage">
        {/* key=项目根：切换项目时整棵 IDE 状态树重建，避免跨项目残留。 */}
        <WorkbenchProjectStage key={project.path} project={project} />
      </main>
    </div>
  )
}
