import type { WorkbenchAiChangesState } from '@renderer/hooks/useWorkbenchAiChanges'
import type { WorkbenchGitDecorationMap } from '@renderer/models/git/workbenchGitModel'
import type { WorkbenchProject } from '@renderer/models/project/workbenchProjects'
import type { WorkbenchThemeId } from '@renderer/models/settings/workbenchPreferences'

import type { WorkbenchDebugTab } from '../../hooks/useWorkbenchEditorNavigationState'
import type { WorkbenchEditorProjectBundle } from '../../types/workbenchSurfaceBundles'
import type { TopToolbarProps } from '../chrome/TopToolbar'
import type { WorkbenchLogicGraphSidebarProps } from '../codeGraph/WorkbenchLogicGraphSidebar'
import type {
  WorkbenchEditorGroupPanelModel,
  WorkbenchEditorGroupsLayoutProps,
} from '../editor/EditorGroupsPanel'
import type { WorkbenchEditorPanelDiffProps } from '../editor/EditorPanel'
import type {
  WorkbenchFilePanelHandlersProps,
  WorkbenchFilePanelSearchProps,
  WorkbenchFilePanelTreeProps,
} from '../files/FilePanel'
import type { WorkbenchCommitPanelProps } from '../git/WorkbenchCommitPanel'
import type { WorkbenchGitPanelSessionProps } from '../git/workbenchGitPanelProps'

export type WorkbenchEmbeddedKernelLeftMode = 'ai-changes' | 'changes' | 'files' | 'velar-structure'

export interface WorkbenchEmbeddedFilePanelModel {
  tree: WorkbenchFilePanelTreeProps
  search: WorkbenchFilePanelSearchProps
  handlers: WorkbenchFilePanelHandlersProps
}

export interface WorkbenchEmbeddedCommitPanelModel {
  git: WorkbenchGitPanelSessionProps
  onOpenDiff: WorkbenchCommitPanelProps['onOpenDiff']
  onOpenFile: WorkbenchCommitPanelProps['onOpenFile']
}

/** 编辑区内置 webview 调试选项卡的原始数据，JSX 由 kernel 组件构建。 */
export interface WorkbenchEmbeddedDebugTabsModel {
  tabs: WorkbenchDebugTab[]
  activeTabId: Nullable<string>
  onSelect: (id: string) => void
  onClose: (id: string) => void
  onNavigate: (id: string, url: string, title?: string) => void
  /** 当前会话的 Agent 浏览器标签；浏览器没进站点时没有。 */
  agentBrowser?: LooseOptional<{
    id: string
    projectRoot: string
    sessionId: string
    url: string
    title: string
    active: boolean
    onSelect: () => void
    onClose: () => void
  }>
}

export interface WorkbenchEmbeddedEditorPanelModel {
  chrome: TopToolbarProps
  showTopBar?: boolean
  workbenchTheme: WorkbenchThemeId
  workbenchProject: WorkbenchEditorProjectBundle
  gitDecorations: WorkbenchGitDecorationMap
  /** 版本库状态的刷新序号，编辑区据此重读 HEAD 来标行的 Git 改动；null：项目不是 Git 仓库。 */
  gitStateRevision: Nullable<number>
  /** 从左到右的编辑器组（一组，或并排的两组）：各自正在显示的文件、标签栏与动作。 */
  groups: WorkbenchEditorGroupPanelModel[]
  /** 当前组、分隔条位置，以及换当前组、把标签挪到另一组的动作。 */
  layout: WorkbenchEditorGroupsLayoutProps
  /** 盖在左边那组编辑器上的标签：Git 对比、只读预览（网页调试、结构图、AI 改动由页面与装配件补进来）。 */
  diff: WorkbenchEditorPanelDiffProps
  debug: WorkbenchEmbeddedDebugTabsModel
}

/**
 * 中央装配件的输入：左侧各面板（文件、提交、结构、AI 改动）与编辑区。
 * `aiChanges` 是每一轮 AI 运行的改动（左侧面板 + 编辑区只读对比标签组），状态由页 model 供给。
 */
export interface WorkbenchEmbeddedKernelModel {
  activeProject: WorkbenchProject
  aiChanges: WorkbenchAiChangesState
  files: WorkbenchEmbeddedFilePanelModel
  changes: WorkbenchEmbeddedCommitPanelModel
  velarStructure?: WorkbenchLogicGraphSidebarProps
  editor: WorkbenchEmbeddedEditorPanelModel
}
