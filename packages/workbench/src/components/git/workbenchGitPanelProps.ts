import type { SystemWorkspaceGitSummary } from '@velaros/core/types'

import type { WorkbenchGitChangeItem } from '../../models/git/workbenchGitModel'

/** 提交与变更工具窗口共享的版本控制会话快照和刷新接线。 */
export interface WorkbenchGitPanelSessionProps {
  workspaceRoot: string
  gitSshKeyPath?: string
  summary: Nullable<SystemWorkspaceGitSummary>
  changeItems: WorkbenchGitChangeItem[]
  hasUnsavedOpenTabs: boolean
  isLoading: boolean
  error: Nullable<string>
  selectedFilePath: Nullable<string>
  onRefresh: () => Promise<void> | void
}

/** 工作台变更工具窗口使用的版本控制属性，包含历史与分支面板。 */
export interface WorkbenchChangesPanelGitProps extends WorkbenchGitPanelSessionProps {
  projectRoot: string
  onRepositoryChanged: () => Promise<void> | void
}
