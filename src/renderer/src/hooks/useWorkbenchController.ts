import { useEffect, useMemo, useRef, useState } from 'react'
import { getWorkbenchEditorFocusedPath } from '@renderer/models/editor/workbenchEditorGroups'
import { buildWorkbenchProjectContextIndex } from '@renderer/models/project/workbenchProjectContextIndex'
import type { WorkbenchProject } from '@renderer/models/project/workbenchProjects'
import {
  readWorkbenchProjectSession,
  saveWorkbenchProjectSessionSnapshot,
} from '@renderer/models/project/workbenchProjectSessionModel'

import { isEmpty,toNullable } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import type { WorkbenchDirectoryEntry } from '@shared/contracts'

import type { EditorNavigationRequest } from '../components/editor/CodeInsightPanel'
import { useStableWorkbenchMessageTranslate } from '../runtime/useStableWorkbenchMessaging'
import { useMemoizedFn } from '../support/genericHooks'

import { useWorkbenchCommandController } from './useWorkbenchCommandController'
import {
  useWorkbenchEditorController,
  type WorkbenchFileOpenOptions,
} from './useWorkbenchEditorController'
import { useWorkbenchLanguageServiceInsights } from './useWorkbenchLanguageServiceInsights'
import { useWorkbenchMutationController } from './useWorkbenchMutationController'
import { useWorkbenchProjectController } from './useWorkbenchProjectController'
import { useWorkbenchProjectIndexController } from './useWorkbenchProjectIndexController'
import { useWorkbenchSearchController } from './useWorkbenchSearchController'
import { useWorkbenchTreeController } from './useWorkbenchTreeController'

interface UseWorkbenchControllerOptions {
  bootstrapProjects?: readonly WorkbenchProject[]
  lockedProjectId?: LooseOptional<string>
  persistProjectList?: boolean
  persistProjectSession?: boolean
  restoreProjectSession?: boolean
  projectIndexEnabled?: boolean
  /** 「预览标签」这项设置：关着时单击文件、点搜索结果都开普通标签。 */
  previewTabsEnabled?: boolean
  sessionCursorByPathRef?: React.MutableRefObject<Record<string, { line: number; column: number }>>
  /** 打开着的文件（或它所在的目录）被改名 / 移动：跟着文件走的状态（如 AI 选区）换到新路径。 */
  onOpenEntryPathMoved?: (projectRoot: string, previousPath: string, nextPath: string) => void
}

export type WorkbenchSelectFileOptions = WorkbenchFileOpenOptions

export function useWorkbenchController(options: UseWorkbenchControllerOptions = {}) {
  const { messageLatest, tLatest } = useStableWorkbenchMessageTranslate()
  const shouldPersistProjectSession = options.persistProjectSession ?? true
  const shouldRestoreProjectSession = options.restoreProjectSession ?? true
  const [pendingSessionNavigation, setPendingSessionNavigation] =
    useState<Nullable<EditorNavigationRequest>>(null)
  const internalSessionCursorByPathRef = useRef<Record<string, { line: number; column: number }>>(
    {}
  )
  const sessionCursorByPathRef = options.sessionCursorByPathRef ?? internalSessionCursorByPathRef
  const sessionNavigationIdRef = useRef(0)
  const openedProjectIdRef = useRef<Nullable<string>>(null)

  const project = useWorkbenchProjectController({
    bootstrapActiveProjectId: options.lockedProjectId,
    bootstrapProjects: options.bootstrapProjects,
    persistProjectList: options.persistProjectList,
  })
  const tree = useWorkbenchTreeController({ activeProject: project.activeProject })
  const search = useWorkbenchSearchController({ activeProject: project.activeProject })
  const command = useWorkbenchCommandController({
    activeProject: project.activeProject,
    rootEntries: tree.rootEntries,
  })
  const commandState = command.state
  const commandActions = command.actions
  const projectIndex = useWorkbenchProjectIndexController({
    activeProject: project.activeProject,
    enabled: options.projectIndexEnabled ?? true,
  })
  const editor = useWorkbenchEditorController({
    activeProject: project.activeProject,
    previewTabsEnabled: options.previewTabsEnabled,
    onFileMetadataSaved: tree.refreshTreeFileMetadata,
    onFileSaved: () => {
      commandActions.command.markValidationStale()
      void projectIndex.refreshProjectIndex()
    },
    onExternalFilesChanged: () => {
      commandActions.command.markValidationStale()
      void tree.refreshLoadedDirectories()
      void projectIndex.refreshProjectIndex()
    },
  })

  /** 打开文件并切过去；返回标签的路径（规范化后的），没打开返回 null。 */
  const selectFile = useMemoizedFn(
    (path: string, options: WorkbenchSelectFileOptions = {}): Promise<Nullable<string>> =>
      editor.selectFile(path, options)
  )

  // 文件视图只有一个当前态：编辑器 selectedFilePath 是文件选择的 owner，文件树只做投影。
  // 因此标签、搜索、面包屑等任意入口切换文件时，左侧树都会在同一轮状态提交后跟随。
  useEffect(() => {
    if (!editor.selectedFilePath) return
    void tree.revealEntryPath(editor.selectedFilePath, { quiet: true })
  }, [editor.selectedFilePath, tree.revealEntryPath])

  const moveOpenEntryPath = useMemoizedFn(
    (previousPath: string, nextPath: string, modifiedAt?: LooseOptional<number>): void => {
      // 先把跟着文件走的状态挪到新路径，再换标签：换完标签的那次提交里，旧路径已经不算「被关掉」。
      const rootPath = project.activeProject?.rootPath
      if (rootPath) options.onOpenEntryPathMoved?.(rootPath, previousPath, nextPath)
      editor.moveOpenEntryPath(previousPath, nextPath, modifiedAt)
    }
  )

  const mutation = useWorkbenchMutationController({
    activeProject: project.activeProject,
    selectedEntry: tree.selectedEntry,
    selectedEntryPath: tree.selectedEntryPath,
    ensureNoUnsavedFilesInPath: editor.ensureNoUnsavedFilesInPath,
    selectFile: async (path) => {
      await selectFile(path)
    },
    moveOpenEntryPath,
    closeOpenEntryPath: editor.closeOpenEntryPath,
    setSelectedEntryPath: tree.setSelectedEntryPath,
    refreshMutationParent: tree.refreshMutationParent,
    pruneTreeCache: tree.pruneTreeCache,
    resetSearch: search.resetSearch,
    onTreeChanged: () => {
      commandActions.command.markValidationStale()
      void projectIndex.refreshProjectIndex()
    },
  })
  const projectContextIndex = useMemo(
    () =>
      buildWorkbenchProjectContextIndex({
        childrenByPath: tree.childrenByPath,
        openFiles: editor.openedFileSnapshots,
        indexedFiles: projectIndex.indexedFileSnapshots,
      }),
    [tree.childrenByPath, editor.openedFileSnapshots, projectIndex.indexedFileSnapshots]
  )
  const languageServiceInsights = useWorkbenchLanguageServiceInsights({
    projectRoot: toNullable(project.activeProject?.rootPath),
    openTabs: editor.openTabs,
    selectedFilePath: editor.selectedFilePath,
    editorContent: editor.editorContent,
    externalRevision: editor.externalRevision,
  })
  const persistActiveProjectSession = useMemoizedFn((): void => {
    if (!shouldPersistProjectSession) return

    const projectId = project.activeProjectId
    if (!projectId) return

    saveWorkbenchProjectSessionSnapshot(projectId, {
      expandedPaths: tree.expandedPaths,
      selectedEntryPath: tree.selectedEntryPath,
      editorLayout: editor.editorLayout,
      cursorByPath: sessionCursorByPathRef.current,
    })
  })

  const clearPendingSessionNavigation = useMemoizedFn((): void => {
    setPendingSessionNavigation(null)
  })

  const openProject = useMemoizedFn(
    async (
      nextProject: WorkbenchProject,
      sourceProjects: WorkbenchProject[] = project.projects
    ): Promise<void> => {
      const previousActiveProjectId = project.activeProjectId

      if (
        openedProjectIdRef.current === nextProject.id &&
        project.activeProjectId === nextProject.id &&
        !isEmpty(tree.rootEntries)
      )
        return

      if (previousActiveProjectId && previousActiveProjectId !== nextProject.id) {
        persistActiveProjectSession()
      }

      try {
        project.activateProject(nextProject.id)
        await project.bindProjectWorkspace(nextProject, sourceProjects)
        project.markProjectOpened(nextProject.id, sourceProjects)
        tree.resetTree()
        editor.resetSelectedFile()
        projectIndex.resetProjectIndex()
        search.resetSearch()
        mutation.resetTreeAction()
        setPendingSessionNavigation(null)
        sessionCursorByPathRef.current = {}

        await tree.loadRootDirectory(nextProject)

        const session = shouldRestoreProjectSession
          ? readWorkbenchProjectSession(nextProject.id)
          : null
        if (session) {
          sessionCursorByPathRef.current = { ...session.cursorByPath }

          await tree.restoreExpandedPaths(session.expandedPaths, { quiet: true })

          if (session.selectedEntryPath) {
            tree.setSelectedEntryPath(session.selectedEntryPath)
          }

          await editor.restoreEditorSession(session.editorLayout)

          // 回到当前文件上次的光标位置（读不出来的标签已经丢掉，当前文件以恢复出来的为准）。
          const cursorPath = getWorkbenchEditorFocusedPath(session.editorLayout)
          const cursor = cursorPath ? session.cursorByPath[cursorPath] : null
          if (cursorPath && cursor) {
            sessionNavigationIdRef.current += 1
            setPendingSessionNavigation({
              id: sessionNavigationIdRef.current,
              line: cursor.line,
              column: cursor.column,
            })
          }
        }

        openedProjectIdRef.current = nextProject.id
      } catch (error) {
        if (
          previousActiveProjectId &&
          previousActiveProjectId !== nextProject.id &&
          sourceProjects.some((item) => item.id === previousActiveProjectId)
        ) {
          project.activateProject(previousActiveProjectId)
        } else {
          project.clearActiveProject()
          openedProjectIdRef.current = null
        }

        const appError = AppError.from(error)
        messageLatest.current.error({
          title: tLatest.current('workbench.openProjectFailed'),
          description: appError.message,
        })
      }
    }
  )

  const addProject = useMemoizedFn(async (openProjectHandler = openProject): Promise<void> => {
    await project.addProject(openProjectHandler)
  })

  function removeProject(projectId: string): void {
    project.removeProject(projectId)
    if (project.activeProjectId === projectId) {
      closeProject()
    }
  }

  function closeProject(): boolean {
    if (!editor.ensureNoUnsavedChanges()) return false

    persistActiveProjectSession()
    project.clearActiveProject()
    tree.resetTree()
    editor.resetSelectedFile()
    projectIndex.resetProjectIndex()
    search.resetSearch()
    mutation.resetTreeAction()
    setPendingSessionNavigation(null)
    sessionCursorByPathRef.current = {}
    openedProjectIdRef.current = null
    return true
  }

  const refreshRootDirectory = useMemoizedFn(async (): Promise<void> => {
    await tree.refreshRootDirectory()
    void projectIndex.refreshProjectIndex()
  })

  const refreshLoadedDirectories = useMemoizedFn(async (): Promise<void> => {
    await tree.refreshLoadedDirectories()
  })

  const toggleDirectory = useMemoizedFn(async (path: string): Promise<void> => {
    await tree.toggleDirectory(path)
  })

  const openSearchEntry = useMemoizedFn(
    async (entry: WorkbenchDirectoryEntry, options?: WorkbenchSelectFileOptions): Promise<void> => {
      if (entry.type === 'file') {
        await selectFile(entry.path, options)
        return
      }

      await tree.openDirectory(entry.path)
    }
  )

  return {
    sortedProjects: project.sortedProjects,
    activeProject: project.activeProject,
    workspaceBindingVersion: project.workspaceBindingVersion,
    rootEntries: tree.rootEntries,
    selectedEntry: tree.selectedEntry,
    selectedEntryPath: tree.selectedEntryPath,
    revealRevision: tree.revealRevision,
    selectedFilePath: editor.selectedFilePath,
    selectedFile: editor.selectedFile,
    editorContent: editor.editorContent,
    openTabs: editor.openTabs,
    editorLayout: editor.editorLayout,
    editorGroups: editor.editorGroups,
    expandedPaths: tree.expandedPaths,
    childrenByPath: tree.childrenByPath,
    pendingTreeAction: mutation.pendingTreeAction,
    treeActionName: mutation.treeActionName,
    searchQuery: search.searchQuery,
    normalizedSearchQuery: search.normalizedSearchQuery,
    searchResult: search.searchResult,
    searchActive: search.searchActive,
    hasUnsavedChanges: editor.hasUnsavedChanges,
    hasUnsavedOpenTabs: editor.hasUnsavedOpenTabs,
    ensureNoUnsavedChanges: editor.ensureNoUnsavedChanges,
    canEditSelectedFile: editor.canEditSelectedFile,
    selectedFileEditMode: editor.selectedFileEditMode,
    isPicking: project.isPicking,
    isLoadingTree: tree.isLoadingTree,
    isSavingFile: editor.isSavingFile,
    autosaveFailures: editor.autosaveFailures,
    saveRevision: editor.saveRevision,
    externalRevision: editor.externalRevision,
    isMutatingTree: mutation.isMutatingTree,
    isSearchingEntries: search.isSearchingEntries,
    isIndexingProject: projectIndex.isIndexingProject,
    isRunningCommand: commandState.command.isRunningCommand,
    hasActiveRunCommand: commandState.command.hasActiveRunCommand,
    isValidationStale: commandState.command.isValidationStale,
    commandInput: commandState.command.commandInput,
    commandResult: commandState.command.commandResult,
    commandHistory: commandState.command.commandHistory,
    commandSuggestions: commandState.command.commandSuggestions,
    runConfigurations: commandState.command.runConfigurations,
    runOutputLines: commandState.command.runOutputLines,
    terminalSessions: commandState.terminal.terminalSessions,
    activeTerminalSessionId: commandState.terminal.activeTerminalSessionId,
    runSessions: commandState.run.runSessions,
    activeRunSessionId: commandState.run.activeRunSessionId,
    lastLaunchedCommand: commandState.command.lastLaunchedCommand,
    projectIndexResult: projectIndex.projectIndexResult,
    projectContextIndex,
    languageServiceInsights,
    pendingSessionNavigation,
    clearPendingSessionNavigation,
    applyLanguageServiceFileChanges: editor.applyLanguageServiceFileChanges,
    applyLanguageServiceRename: editor.applyLanguageServiceRename,
    /** 项目搜索的替换落到开着的文件上（在标签正文上换，能撤销，不写盘）。 */
    replaceOpenTabContents: editor.replaceOpenTabContents,
    setEditorContent: editor.setEditorContent,
    setTreeActionName: mutation.setTreeActionName,
    setSearchQuery: search.setSearchQuery,
    setCommandInput: commandActions.command.setCommandInput,
    setActiveTerminalSessionId: commandActions.terminal.setActiveTerminalSessionId,
    clearCommandResult: commandActions.command.clearCommandResult,
    selectEntryPath: tree.setSelectedEntryPath,
    addProject,
    removeProject,
    openProject,
    closeProject,
    refreshRootDirectory,
    refreshLoadedDirectories,
    toggleDirectory,
    setDirectoryOpen: tree.setDirectoryOpen,
    openDirectory: tree.openDirectory,
    revealEntryPath: tree.revealEntryPath,
    openSearchEntry,
    selectFile,
    closeOpenFile: editor.closeOpenFile,
    closeOtherOpenFiles: editor.closeOtherOpenFiles,
    closeAllOpenFiles: editor.closeAllOpenFiles,
    closeUnmodifiedOpenFiles: editor.closeUnmodifiedOpenFiles,
    closeOpenFilesToRight: editor.closeOpenFilesToRight,
    /** 取出最近关掉、此刻没打开着的标签路径，供「重新打开关闭的标签」用。 */
    takeRecentlyClosedTabPath: editor.takeRecentlyClosedTabPath,
    closeRequest: editor.closeRequest,
    isResolvingCloseRequest: editor.isResolvingCloseRequest,
    resolveCloseRequest: editor.resolveCloseRequest,
    /** 主进程要关窗 / 退出：先存能存的，存不下的问用户；true 表示可以关。 */
    confirmWindowClose: editor.confirmWindowClose,
    reorderOpenTabs: editor.reorderOpenTabs,
    /** 把预览标签留下，变成普通标签。 */
    keepOpenFile: editor.keepOpenFile,
    pinOpenFile: editor.pinOpenFile,
    unpinOpenFile: editor.unpinOpenFile,
    focusEditorGroup: editor.focusEditorGroup,
    /** 把标签挪到另一组并切过去；右边那组还不存在就新开出来。 */
    moveOpenFileToGroup: editor.moveOpenFileToGroup,
    setEditorSplitRatio: editor.setEditorSplitRatio,
    revertOpenFiles: editor.revertOpenFiles,
    beginCreateEntry: mutation.beginCreateEntry,
    beginRenameEntry: mutation.beginRenameEntry,
    createTreeEntry: mutation.createTreeEntry,
    renameTreeEntry: mutation.renameTreeEntry,
    moveTreeEntries: mutation.moveTreeEntries,
    copyTreeEntries: mutation.copyTreeEntries,
    deleteTreeEntries: mutation.deleteTreeEntries,
    undoLastDeletedEntries: mutation.undoLastDeletedEntries,
    resetTreeAction: mutation.resetTreeAction,
    resetSearch: search.resetSearch,
    submitTreeAction: mutation.submitTreeAction,
    deleteSelectedEntry: mutation.deleteSelectedEntry,
    saveSelectedFile: editor.saveSelectedFile,
    toggleSelectedFileEditMode: editor.toggleSelectedFileEditMode,
    saveAllOpenFiles: editor.saveAllOpenFiles,
    convertSelectedFileTextFormat: editor.convertSelectedFileTextFormat,
    resolveSelectedExternalFileConflict: editor.resolveSelectedExternalFileConflict,
    runCommand: commandActions.command.runCommand,
    rerunLastCommand: commandActions.command.rerunLastCommand,
    createTerminalSession: commandActions.terminal.createTerminalSession,
    splitTerminalSession: commandActions.terminal.splitTerminalSession,
    writeTerminalData: commandActions.terminal.writeTerminalData,
    resizeTerminalSession: commandActions.terminal.resizeTerminalSession,
    stopTerminalSession: commandActions.terminal.stopTerminalSession,
    closeTerminalSessions: commandActions.terminal.closeTerminalSessions,
    setTerminalPaneWeights: commandActions.terminal.setTerminalPaneWeights,
    setActiveRunSessionId: commandActions.run.setActiveRunSessionId,
    launchRunSession: commandActions.run.launchRunSession,
    stopRunSession: commandActions.run.stopRunSession,
    restartRunSession: commandActions.run.restartRunSession,
    closeRunSession: commandActions.run.closeRunSession,
  }
}
