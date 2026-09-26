import type { WorkbenchAiChangesState } from '@renderer/hooks/useWorkbenchAiChanges'
import type { WorkbenchGitDecorationMap } from '@renderer/models/git/workbenchGitModel'
import type { WorkbenchProject } from '@renderer/models/project/workbenchProjects'
import type { WorkbenchThemeId } from '@renderer/models/settings/workbenchPreferences'

import type { WorkbenchLanguageServiceDiagnostic } from '@shared/contracts'

import type { WorkbenchDebugTab } from '../../hooks/useWorkbenchEditorNavigationState'
import type {
  WorkbenchEditorProjectBundle,
  WorkbenchEditorSurfaceBundle,
} from '../../types/workbenchSurfaceBundles'
import type { TopToolbarProps } from '../chrome/TopToolbar'
import type { WorkbenchLogicGraphSidebarProps } from '../codeGraph/WorkbenchLogicGraphSidebar'
import type {
  WorkbenchEditorPanelDiffProps,
  WorkbenchEditorPanelTabsProps,
  WorkbenchEditorPanelWorkspaceProps,
} from '../editor/EditorPanel'
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
}

export interface WorkbenchEmbeddedEditorPanelModel {
  chrome: TopToolbarProps
  showTopBar?: boolean
  workbenchTheme: WorkbenchThemeId
  workbenchProject: WorkbenchEditorProjectBundle
  workbenchEditor: WorkbenchEditorSurfaceBundle
  gitDecorations: WorkbenchGitDecorationMap
  /** 版本库状态的刷新序号，编辑区据此重读 HEAD 来标行的 Git 改动；null：项目不是 Git 仓库。 */
  gitStateRevision: Nullable<number>
  selectedFileDiagnostics: readonly WorkbenchLanguageServiceDiagnostic[]
  isSelectedFileDiagnosticsPending: boolean
  tabs: WorkbenchEditorPanelTabsProps
  diff: WorkbenchEditorPanelDiffProps
  debug: WorkbenchEmbeddedDebugTabsModel
  workspace: WorkbenchEditorPanelWorkspaceProps
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
