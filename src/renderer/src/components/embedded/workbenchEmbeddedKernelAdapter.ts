import { inferPackageManagerCommand } from '@renderer/models/commands/workbenchCommandSuggestions'
import {
  buildWorkbenchVelarBuildCommand,
  buildWorkbenchVelarRunCommand,
} from '@renderer/models/commands/workbenchVelarFileCommand'
import { getWorkbenchFileDiagnosticView } from '@renderer/models/editor/workbenchLanguageServiceInsightsModel'

import { AppError } from '@velaros-ai/core/error'

import type { StandaloneWorkbenchPageModel } from '../../hooks/useStandaloneWorkbenchPageModel'
import type { TopToolbarProps } from '../chrome/TopToolbar'

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
    hasGitRepository: gitState.hasGitRepository,
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
    onOpenGitBottomTool: () => model.surface.openBottomTool('git'),
    onOpenQuickOpen: model.surface.openQuickOpen,
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

  const selectedFileDiagnosticView = getWorkbenchFileDiagnosticView({
    path: workbench.selectedFilePath,
    diagnosticsByPath: workbench.languageServiceInsights.diagnosticsByPath,
    diagnosticsPendingPaths: workbench.languageServiceInsights.diagnosticsPendingPaths,
  })
  const packageManager = inferPackageManagerCommand(workbench.rootEntries)

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
        normalizedSearchQuery: workbench.normalizedSearchQuery,
        searchResult: workbench.searchResult,
        contentSearchMatches: model.chrome.contentSearchMatches,
        searchActive: workbench.searchActive,
        isSearchingEntries: workbench.isSearchingEntries,
        isIndexingProject: workbench.isIndexingProject,
      },
      handlers: {
        onSelectEntryPath: workbench.selectEntryPath,
        onCreateEntry: (type, parentEntry, name) =>
          model.actions.runTreeMutation(() => workbench.createTreeEntry(type, parentEntry, name)),
        onRenameEntry: (entry, name) =>
          model.actions.runTreeMutation(() => workbench.renameTreeEntry(entry, name)),
        onDeleteEntries: (entries) =>
          model.actions.runTreeMutation(() => workbench.deleteTreeEntries(entries)),
        onUndoDeleteEntries: () =>
          model.actions.runTreeMutation(() => workbench.undoLastDeletedEntries()),
        onMoveEntries: (entries, parentEntry, _index) =>
          model.actions.runTreeMutation(() => workbench.moveTreeEntries(entries, parentEntry)),
        onSearchQueryChange: workbench.setSearchQuery,
        onResetSearch: workbench.resetSearch,
        onRefreshProject: () => void model.actions.refreshProjectAndGit(),
        onCloseProject: undefined,
        onOpenSearchEntry: (entry) => void workbench.openSearchEntry(entry),
        onOpenContentSearchMatch: (match) =>
          void editorNavigation.goToLocation(match.path, match.line, match.column),
        onSetDirectoryOpen: (path, open) => void workbench.setDirectoryOpen(path, open),
        onSelectFile: (path) => {
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
    },
    editor: {
      chrome: editorChrome,
      showTopBar: options.showEditorTopBar ?? true,
      workbenchTheme: model.workbenchPreferences.preferences.theme,
      workbenchProject: {
        name: activeProject.name,
        rootPath: activeProject.rootPath,
      },
      workbenchEditor: {
        editorContent: workbench.editorContent,
        openTabs: workbench.openTabs,
        hasUnsavedChanges: workbench.hasUnsavedChanges,
        selectedFilePath: workbench.selectedFilePath,
        selectedFile: workbench.selectedFile,
        canEditSelectedFile: workbench.canEditSelectedFile,
        selectedFileEditMode: workbench.selectedFileEditMode,
        projectContextIndex: workbench.projectContextIndex,
        isSavingFile: workbench.isSavingFile,
        autosaveFailures: workbench.autosaveFailures,
        externalRevision: workbench.externalRevision,
      },
      gitDecorations: gitState.decorations,
      // 顶栏 +/- 的轻量快照在工作区一有改动（包括 .git 里的提交、切分支）就会重拉，拿它的时刻当序号。
      gitStateRevision: gitState.lineStatsSnapshot?.repository
        ? gitState.lineStatsSnapshot.checkedAt
        : null,
      selectedFileDiagnostics: selectedFileDiagnosticView.diagnostics,
      isSelectedFileDiagnosticsPending: selectedFileDiagnosticView.isPending,
      tabs: {
        onSelectOpenFile: (path) => {
          model.actions.showEditorSurface()
          void editorNavigation.selectFile(path)
        },
        onCloseOpenFile: workbench.closeOpenFile,
        onCloseOtherOpenFiles: workbench.closeOtherOpenFiles,
        onCloseAllOpenFiles: workbench.closeAllOpenFiles,
        onCloseUnmodifiedOpenFiles: workbench.closeUnmodifiedOpenFiles,
        onReorderOpenTabs: workbench.reorderOpenTabs,
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
              onSave: () => void model.actions.saveEmbeddedLightTab(),
            }
          : null,
        onCloseDiffTab: editorNavigation.closeDiff,
      },
      debug: {
        tabs: editorNavigation.debug.tabs,
        activeTabId: editorNavigation.debug.activeTabId,
        onSelect: editorNavigation.debug.selectTab,
        onClose: editorNavigation.debug.closeTab,
        onNavigate: editorNavigation.debug.navigateTab,
        agentBrowser: buildAgentBrowserTab(model, activeProject.rootPath),
      },
      workspace: {
        onRevertSelectedFile: workbench.revertSelectedFile,
        onSaveSelectedFile: () => void workbench.saveSelectedFile(),
        onToggleSelectedFileEditMode: workbench.toggleSelectedFileEditMode,
        onSaveAllOpenFiles: () => void workbench.saveAllOpenFiles(),
        onConvertSelectedFileTextFormat: (format) =>
          void workbench.convertSelectedFileTextFormat(format),
        onResolveExternalFileConflict: (resolution) =>
          void workbench.resolveSelectedExternalFileConflict(resolution),
        onEditorContentChange: workbench.setEditorContent,
        onOpenDirectory: (path) => void workbench.openDirectory(path),
        onRevealSelectedFile: () => {
          if (workbench.selectedFilePath) {
            void workbench.revealEntryPath(workbench.selectedFilePath)
          }
        },
        onGoToDefinition: (path, line, column) =>
          void editorNavigation.goToLocation(path, line, column),
        onApplyLanguageServiceFileChanges: workbench.applyLanguageServiceFileChanges,
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
        onCursorPositionChange: editorNavigation.setCursorPosition,
        onActiveProblemIdChange: editorNavigation.setActiveProblemId,
        navigationRequest: editorNavigation.navigationRequest,
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
