import type { WorkbenchAiChangeArchiveState } from '@renderer/hooks/useWorkbenchAiChangeArchive'
import type { WorkbenchGitDecorationMap } from '@renderer/models/git/workbenchGitModel'
import type { WorkbenchProject } from '@renderer/models/project/workbenchProjects'
import type { WorkbenchThemeId } from '@renderer/models/settings/workbenchPreferences'

import type { ControlledBrowserSurface } from '@velaros-ai/browser/composition'

import type {
  BrowserElementSelection,
  WorkbenchLanguageServiceDiagnostic,
} from '@shared/contracts'

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

export type WorkbenchEmbeddedKernelLeftMode = 'changes' | 'files' | 'velar-structure'

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
  agentBrowser?: LooseOptional<{
    id: string
    sessionId: string
    title: string
    visible: boolean
    active: boolean
    surface: ControlledBrowserSurface
    onSelect: () => void
    onClose: () => void
    onPicked: (selection: BrowserElementSelection) => void
  }>
}

export interface WorkbenchEmbeddedEditorPanelModel {
  chrome: TopToolbarProps
  showTopBar?: boolean
  workbenchTheme: WorkbenchThemeId
  workbenchProject: WorkbenchEditorProjectBundle
  workbenchEditor: WorkbenchEditorSurfaceBundle
  gitDecorations: WorkbenchGitDecorationMap
  selectedFileDiagnostics: readonly WorkbenchLanguageServiceDiagnostic[]
  isSelectedFileDiagnosticsPending: boolean
  tabs: WorkbenchEditorPanelTabsProps
  diff: WorkbenchEditorPanelDiffProps
  debug: WorkbenchEmbeddedDebugTabsModel
  workspace: WorkbenchEditorPanelWorkspaceProps
}

/**
 * 片2 过渡形态：`changes`（提交/会话变更左面模型）随片4 CommitPanel 族复活时恢复；
 * `aiChanges` 状态仍由页 model 供给（存档面 UI 在 Phase 3 批复活）。
 */
export interface WorkbenchEmbeddedKernelModel {
  activeProject: WorkbenchProject
  aiChanges: WorkbenchAiChangeArchiveState
  files: WorkbenchEmbeddedFilePanelModel
  changes: WorkbenchEmbeddedCommitPanelModel
  velarStructure?: WorkbenchLogicGraphSidebarProps
  editor: WorkbenchEmbeddedEditorPanelModel
}
