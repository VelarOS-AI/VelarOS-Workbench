/**
 * 起手页（VS Code / IDEA 式欢迎页）：新建项目 / 打开项目 / 最近项目三主动作。
 *
 * 应用私有组件——起手页是独立入口的产品形态，没有第二个消费者，按「独立消费者才提包」
 * 判据归独立起手页，不进入通用产品模型。视觉零件全部来自 `@velaros-ai/ui`
 * （§12.9 封闭形态），外貌层类名走 welcome.css + 语义令牌，不写裸色值。
 */
import { type ReactElement } from 'react'
import { FolderOpenIcon, FolderPlusIcon, XIcon } from '@phosphor-icons/react'

import { Button, Empty, IconButton, Stack, Tag, Text, Title } from '@velaros-ai/ui'

import type { WorkbenchProjectHubState, WorkbenchRecentProject } from '../../../shared/projectHub'
import { useWorkbenchPreferences } from '../hooks/useWorkbenchPreferences'

import { lastOpenedLabel } from './lastOpenedLabel'

import './welcome.css'

interface WorkbenchWelcomePageProps {
  state: WorkbenchProjectHubState
  onNewProject: () => void
}

export function WorkbenchWelcomePage({
  state,
  onNewProject,
}: WorkbenchWelcomePageProps): ReactElement {
  const { preferences } = useWorkbenchPreferences()

  return (
    <div className="workbench-welcome" data-workbench-accent={preferences.accent}>
      <div className="workbench-welcome__panel">
        <section className="workbench-welcome__hero">
          <Stack gap="xs">
            <Title level={1}>VelarOS Workbench</Title>
            <Text tone="secondary">构建你的下一个项目。</Text>
          </Stack>
          <Stack gap="sm" className="workbench-welcome__actions">
            <Button size="lg" onClick={onNewProject}>
              <FolderPlusIcon size={18} />
              新建项目…
            </Button>
            <Button
              variant="outline"
              size="lg"
              onClick={() => void window.velarosWorkbenchProjectHub.openProjectDialog()}
            >
              <FolderOpenIcon size={18} />
              打开项目…
            </Button>
          </Stack>
        </section>
        <section className="workbench-welcome__recents">
          <Title level={5}>最近项目</Title>
          {state.recentProjects.length === 0 ? (
            <Empty
              title="暂无最近项目"
              description="新建或打开一个项目后，会在这里出现。"
              imageSize="sm"
            />
          ) : (
            <ul className="workbench-welcome__recent-list">
              {state.recentProjects.map((project) => (
                <RecentProjectRow key={project.path} project={project} />
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  )
}

function RecentProjectRow({ project }: { project: WorkbenchRecentProject }): ReactElement {
  return (
    <li className="workbench-welcome__recent-row" data-missing={project.missing}>
      <button
        type="button"
        className="workbench-welcome__recent-open"
        disabled={project.missing}
        onClick={() => void window.velarosWorkbenchProjectHub.openProjectPath(project.path)}
      >
        <span className="workbench-welcome__recent-heading">
          <Text tone="strong" truncate>
            {project.name}
          </Text>
          {project.missing && <Tag variant="warning">路径不存在</Tag>}
        </span>
        <Text tone="caption" truncate>
          {project.path}
        </Text>
      </button>
      <span className="workbench-welcome__recent-meta">
        <Text tone="caption">{lastOpenedLabel(project.lastOpenedAt)}</Text>
        <IconButton
          label="从最近项目移除"
          size="icon-sm"
          className="workbench-welcome__recent-remove"
          onClick={() => void window.velarosWorkbenchProjectHub.removeRecentProject(project.path)}
        >
          <XIcon size={14} />
        </IconButton>
      </span>
    </li>
  )
}
