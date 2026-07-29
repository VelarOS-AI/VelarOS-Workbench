import type { ControlledBrowserSurface } from '@velaros-ai/browser/composition'
import type {
  BrowserElementSelection,
  WorkbenchLanguageServiceDiagnostic,
} from '@velaros-ai/workbench/contracts'
import type { WorkbenchAiChangeArchiveState } from '@velaros-ai/workbench/hooks/useWorkbenchAiChangeArchive'
import type { WorkbenchGitDecorationMap } from '@velaros-ai/workbench/models/git/workbenchGitModel'
import type { WorkbenchProject } from '@velaros-ai/workbench/models/project/workbenchProjects'
import type { WorkbenchThemeId } from '@velaros-ai/workbench/models/settings/workbenchPreferences'

import type { WorkbenchDebugTab } from '../../hooks/useWorkbenchEditorNavigationState'
import type {
  WorkbenchEditorProjectBundle,
  WorkbenchEditorSurfaceBundle,
} from '../../types/workbenchSurfaceBundles'
import type { TopToolbarProps } from '../chrome/TopToolbar'
import type {
  WorkbenchEditorPanelDiffProps,
  WorkbenchEditorPanelTabsProps,
  WorkbenchEditorPanelWorkspaceProps,
} from '../editor/EditorPanel'
import type {
  WorkbenchFilePanelGitControlProps,
  WorkbenchFilePanelHandlersProps,
  WorkbenchFilePanelSearchProps,
  WorkbenchFilePanelTreeProps,
} from '../files/FilePanel'

/**
 * 片2 过渡形态：独立宿主只装配 files 左面（编辑器纵切）；'ai-changes' / 'changes' /
 * 'issues' 三个左面随片4（git）/ Phase 3（AI 面）复活时恢复进联合。
 */
export type WorkbenchEmbeddedKernelLeftMode = 'files'

export interface WorkbenchEmbeddedFilePanelModel {
  tree: WorkbenchFilePanelTreeProps
  search: WorkbenchFilePanelSearchProps
  git?: WorkbenchFilePanelGitControlProps
  handlers: WorkbenchFilePanelHandlersProps
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
  editor: WorkbenchEmbeddedEditorPanelModel
}
