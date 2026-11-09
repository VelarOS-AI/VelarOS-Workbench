import { inferPackageManagerCommand } from '@renderer/models/commands/workbenchCommandSuggestions'
import {
  buildWorkbenchVelarBuildCommand,
  buildWorkbenchVelarRunCommand,
} from '@renderer/models/commands/workbenchVelarFileCommand'
import type { WorkbenchEditorGroupView } from '@renderer/models/editor/workbenchEditorGroupViews'
import { isDirtyTab } from '@renderer/models/editor/workbenchEditorTabs'
import { getWorkbenchFileDiagnosticView } from '@renderer/models/editor/workbenchLanguageServiceInsightsModel'

import { toNullable } from '@velaros-ai/velaros/core'
import { AppError } from '@velaros-ai/velaros/core/error'

import type { StandaloneWorkbenchPageModel } from '../../hooks/useStandaloneWorkbenchPageModel'
import type { TopToolbarProps } from '../chrome/TopToolbar'
import type { WorkbenchEditorGroupPanelModel } from '../editor/EditorGroupsPanel'

import type {
  WorkbenchEmbeddedDebugTabsModel,
  WorkbenchEmbeddedKernelModel,
} from './workbenchEmbeddedKernelModel'

export interface BuildStandaloneWorkbenchEmbeddedKernelModelOptions {
  showEditorTopBar?: boolean
}

export function buildStandaloneWorkbenchEditorChrome(
  model: StandaloneWorkbenchPageModel
): TopToolbarProps {
  const workbench = model.workbench
  const gitState = model.gitState
  const chrome = model.chrome

  const editorChromeGit = {
    gitWorkspaceRoot: workbench.activeProject?.rootPath ?? '',
    gitSummary: gitState.topBarSummary,
    gitSshKeyPath: chrome.effectiveGitSshKeyPath,
    hasUnsavedOpenTabs: workbench.hasUnsavedOpenTabs,
  }
  const editorChromeProject = {
    isRunningCommand: workbench.isRunningCommand,
    hasActiveRunCommand: workbench.hasActiveRunCommand,
  }
  const editorChromeActions = {
    onGitRefresh: model.actions.refreshGitPanel,
    onRepositoryChanged: model.actions.handleRepositoryChanged,
    onOpenGitCommitTool: () => {
      model.surface.setActiveLeftTool('commit')
      if (!model.surface.isFilePanelOpen) model.surface.toggleFilePanel()
    },
    onOpenSettings: () => model.dialogs.setSettingsOpen(true),
  }

  return {
    ...editorChromeGit,
    ...editorChromeProject,
    ...editorChromeActions,
    topRun: model.topRunControl,
  }
}

export function buildStandaloneWorkbenchEmbeddedKernelModel(
  model: StandaloneWorkbenchPageModel,
  editorChrome: TopToolbarProps = buildStandaloneWorkbenchEditorChrome(model),
  options: BuildStandaloneWorkbenchEmbeddedKernelModelOptions = {}
): WorkbenchEmbeddedKernelModel {
  const workbench = model.workbench
  const gitState = model.gitState
  const editorNavigation = model.editorNavigation
  const activeProject = workbench.activeProject

  if (!activeProject) {
    throw new AppError(
      'INVARIANT',
      'Cannot build WorkbenchEmbeddedKernelModel without an active project'
    )
  }

  const packageManager = inferPackageManagerCommand(workbench.rootEntries)

  /**
   * 编辑区里一组的面板输入。动作都落在这一组正在显示的文件上（带着它的路径）：在哪一组的编辑器里按的
   * ⌘S、改的字，就是哪一组的文件，不看此刻的当前组。
   */
  const buildEditorGroup = (group: WorkbenchEditorGroupView): WorkbenchEditorGroupPanelModel => {
    const activePath = toNullable(group.activeTab?.path)
    const diagnosticView = getWorkbenchFileDiagnosticView({
      path: activePath,
      diagnosticsByPath: workbench.languageServiceInsights.diagnosticsByPath,
      diagnosticsPendingPaths: workbench.languageServiceInsights.diagnosticsPendingPaths,
    })
    return {
      workbenchEditor: {
        editorContent: group.activeTab?.content ?? '',
        openTabs: workbench.openTabs,
        groupTabs: group.tabs,
        previewTabPath: group.previewPath,
        pinnedTabCount: group.pinnedCount,
        hasUnsavedChanges: !!group.activeTab && isDirtyTab(group.activeTab),
        selectedFilePath: activePath,
        selectedFile: toNullable(group.activeTab?.file),
        canEditSelectedFile: group.canEdit,
        selectedFileEditMode: group.editMode,
        projectContextIndex: workbench.projectContextIndex,
        isSavingFile: workbench.isSavingFile,
        autosaveFailures: workbench.autosaveFailures,
        externalRevision: workbench.externalRevision,
      },
      selectedFileDiagnostics: diagnosticView.diagnostics,
      isSelectedFileDiagnosticsPending: diagnosticView.isPending,
      tabs: {
        // 点标签只是切过去：预览标签还是预览标签（双击才留下）。
        onSelectOpenFile: (path) => {
          model.actions.showEditorSurface()
          void editorNavigation.selectFile(path, { preview: true })
        },
        onKeepOpenFile: workbench.keepOpenFile,
        onPinOpenFile: workbench.pinOpenFile,
        onUnpinOpenFile: workbench.unpinOpenFile,
        onCloseOpenFile: workbench.closeOpenFile,
        onCloseOtherOpenFiles: workbench.closeOtherOpenFiles,
        // 标签栏上的「关闭全部 / 未修改」只管自己这一组。
        onCloseAllOpenFiles: () => workbench.closeAllOpenFiles(group.index),
        onCloseUnmodifiedOpenFiles: () => workbench.closeUnmodifiedOpenFiles(group.index),
        onCloseOpenFilesToRight: workbench.closeOpenFilesToRight,
        onRevertOpenFile: (path) => workbench.revertOpenFiles([path]),
        onReorderOpenTabs: workbench.reorderOpenTabs,
        closeActiveTabRequestId: model.closeActiveEditorTabRequestId,
      },
      workspace: {
        onSaveSelectedFile: (content) => {
          if (activePath) void workbench.saveSelectedFile(content, activePath)
        },
        onToggleSelectedFileEditMode: () => {
          if (activePath) workbench.toggleSelectedFileEditMode(activePath)
        },
        onSaveAllOpenFiles: () => void workbench.saveAllOpenFiles(),
        onConvertSelectedFileTextFormat: (format) => {
          if (activePath) void workbench.convertSelectedFileTextFormat(format, activePath)
        },
        onResolveExternalFileConflict: (resolution) => {
          if (activePath) void workbench.resolveSelectedExternalFileConflict(resolution, activePath)
        },
        onEditorContentChange: (content) => {
          if (activePath) workbench.setEditorContent(content, activePath)
        },
        onOpenDirectory: (path) => void workbench.openDirectory(path),
        onRevealSelectedFile: () => {
          if (activePath) void workbench.revealEntryPath(activePath)
        },
        // 跳到定义、引用：目标以预览标签打开；出发的文件是预览标签的话先留下（与 VS Code 一致）。
        onGoToDefinition: (path, line, column) =>
          void editorNavigation.goToLocation(path, line, column, {
            preview: true,
            keepSource: true,
          }),
        onApplyLanguageServiceRename: workbench.applyLanguageServiceRename,
        onApplyLanguageServiceEdit: workbench.applyLanguageServiceWorkspaceEdit,
        // 命令面板交给编辑器的代码动作：每一组都拿到，只有当前组的编辑器去做（见 EditorPanel）。
        editorCommandRequest: editorNavigation.editorCommandRequest,
        packageManager,
        onRunPackageScript: (command) => {
          // 走可交互的运行卡（PTY），而不是只读一次性 runner；顺带记为「上次运行」，
          // 让右侧 ▶ 记住并可右键切换；会话创建后由页面 model 自动打开运行面板。
          void workbench.launchRunSession(command)
        },
        onAddFilesToChat: model.actions.addWorkbenchFilesToChat,
        onOpenQuickOpen: model.surface.openQuickOpen,
        onToggleGitTool: () => model.surface.openBottomTool('git'),
        onToggleProblems: () => model.surface.openBottomTool('problems'),
        keymap: model.workbenchKeymap.keymap,
        // 光标、缩进、当前问题各组都报，EditorGroupsPanel 只把当前组的交到这里。
        onCursorPositionChange: editorNavigation.setCursorPosition,
        onNavigateBack: () => void editorNavigation.goBack(),
        onNavigateForward: () => void editorNavigation.goForward(),
        onNavigationPoint: editorNavigation.recordNavigationPoint,
        onIndentationChange: editorNavigation.setIndentation,
        indentationRequest: editorNavigation.indentationRequest,
        onActiveProblemIdChange: editorNavigation.setActiveProblemId,
        navigationRequest: editorNavigation.navigationRequest,
      },
    }
  }

  return {
    activeProject,
    aiChanges: model.aiChanges,
    files: {
      tree: {
        project: activeProject,
        rootEntries: workbench.rootEntries,
        selectedEntryPath: workbench.selectedEntryPath,
        revealRevision: workbench.revealRevision,
        expandedPaths: workbench.expandedPaths,
        childrenByPath: workbench.childrenByPath,
        isLoadingTree: workbench.isLoadingTree,
        isMutatingTree: workbench.isMutatingTree,
        gitDecorations: gitState.decorations,
      },
      search: {
        searchQuery: workbench.searchQuery,
        searchResult: workbench.searchResult,
        searchActive: workbench.searchActive,
        projectSearch: model.projectSearch,
        openTabs: workbench.openTabs,
        replaceOpenTabContents: workbench.replaceOpenTabContents,
        onOpenMatch: model.actions.openProjectSearchMatch,
      },
      handlers: {
        onSelectEntryPath: workbench.selectEntryPath,
        onCreateEntry: workbench.createTreeEntry,
        onRenameEntry: workbench.renameTreeEntry,
        onDeleteEntries: workbench.deleteTreeEntries,
        onUndoDeleteEntries: workbench.undoLastDeletedEntries,
        onMoveEntries: (entries, parentEntry, _index) =>
          workbench.moveTreeEntries(entries, parentEntry),
        onSearchQueryChange: workbench.setSearchQuery,
        onRefreshProject: () => void model.actions.refreshProjectAndGit(),
        onCloseProject: undefined,
        onOpenSearchEntry: (entry, intent) => void workbench.openSearchEntry(entry, intent),
        onSetDirectoryOpen: (path, open) => void workbench.setDirectoryOpen(path, open),
        // 单击文件开预览标签，双击（和新建的文件）开普通标签。
        onSelectFile: (path) => {
          model.actions.showEditorSurface()
          void editorNavigation.selectFile(path, { preview: true })
        },
        onOpenFile: (path) => {
          model.actions.showEditorSurface()
          void editorNavigation.selectFile(path)
        },
        onRunFile: (path) => {
          void workbench.launchRunSession(buildWorkbenchVelarRunCommand(path, packageManager))
        },
        onBuildFile: (path) => {
          void workbench.launchRunSession(buildWorkbenchVelarBuildCommand(path, packageManager))
        },
        onAddFilesToChat: model.actions.addWorkbenchFilesToChat,
        onCopyEntries: workbench.copyTreeEntries,
        onRevealEntry: model.actions.revealPathInSystem,
      },
    },
    changes: {
      git: {
        workspaceRoot: activeProject.rootPath,
        gitSshKeyPath: model.chrome.effectiveGitSshKeyPath,
        summary: gitState.summary,
        changeItems: gitState.changeItems,
        hasUnsavedOpenTabs: workbench.hasUnsavedOpenTabs,
        isLoading: gitState.isLoading,
        error: gitState.error,
        selectedFilePath: workbench.selectedFilePath,
        onRefresh: model.actions.refreshGitPanel,
      },
      onOpenDiff: (item, options) => {
        model.actions.showEditorSurface()
        editorNavigation.openDiff(item, options)
      },
      onOpenFile: (path) => void editorNavigation.selectFile(path),
      onOpenGitTool: () => model.surface.openBottomTool('git'),
    },
    editor: {
      chrome: editorChrome,
      showTopBar: options.showEditorTopBar ?? true,
      workbenchTheme: model.workbenchPreferences.preferences.theme,
      workbenchProject: {
        name: activeProject.name,
        rootPath: activeProject.rootPath,
      },
      gitDecorations: gitState.decorations,
      // 顶栏 +/- 的轻量快照在工作区一有改动（包括 .git 里的提交、切分支）就会重拉，拿它的时刻当序号。
      gitStateRevision: gitState.lineStatsSnapshot?.repository
        ? gitState.lineStatsSnapshot.checkedAt
        : null,
      groups: workbench.editorGroups.map(buildEditorGroup),
      layout: {
        focusedGroup: workbench.editorLayout.focusedGroup,
        splitRatio: workbench.editorLayout.splitRatio,
        focusRequest: model.editorGroupFocusRequest,
        onFocusGroup: model.actions.focusEditorGroup,
        onSplitRatioChange: workbench.setEditorSplitRatio,
        onMoveTabToGroup: model.actions.moveEditorTabToGroup,
      },
      diff: {
        diffWorkspaceRoot: activeProject.rootPath,
        activeDiffItem: editorNavigation.diffItem,
        focusFirstChangeRequestId: editorNavigation.diffFocusFirstChangeRequestId,
        lightTab: editorNavigation.lightTab
          ? {
              item: editorNavigation.lightTab,
              onClose: editorNavigation.closeLightTab,
              onSelect: () => undefined,
              onContentChange: editorNavigation.updateLightTabContent,
              onSave: () => model.actions.saveEmbeddedLightTab(),
            }
          : null,
        onCloseDiffTab: editorNavigation.closeDiff,
        onGitStateChanged: model.actions.refreshGitPanel,
      },
      debug: {
        tabs: editorNavigation.debug.tabs,
        activeTabId: editorNavigation.debug.activeTabId,
        onSelect: editorNavigation.debug.selectTab,
        onClose: editorNavigation.debug.closeTab,
        onNavigate: editorNavigation.debug.navigateTab,
        agentBrowser: buildAgentBrowserTab(model, activeProject.rootPath),
      },
    },
  }
}

/** 当前会话的 Agent 浏览器标签：浏览器进了站点、标签开着时才有；关掉标签就是让浏览器离站。 */
function buildAgentBrowserTab(
  model: StandaloneWorkbenchPageModel,
  projectRoot: string
): WorkbenchEmbeddedDebugTabsModel['agentBrowser'] {
  const { site, sessionId } = model.agentBrowser
  const tab = model.editorNavigation.debug.agentBrowser
  if (!site || !tab.tabId || tab.sessionId !== sessionId) return null
  const tabId = tab.tabId
  return {
    id: tabId,
    projectRoot,
    sessionId,
    url: site.url,
    title: model.chrome.t('workbench.agentBrowserTabTitle', { host: siteHost(site.url) }),
    active: model.editorNavigation.debug.activeTabId === tabId,
    onSelect: tab.select,
    onClose: () => {
      void window.velarosWorkbenchBrowser
        .leaveSite({ projectRoot, sessionId })
        .catch(() => undefined)
        .finally(() => tab.close(sessionId))
    },
  }
}

function siteHost(url: string): string {
  try {
    return new URL(url).host || url
  } catch {
    return url
  }
}
