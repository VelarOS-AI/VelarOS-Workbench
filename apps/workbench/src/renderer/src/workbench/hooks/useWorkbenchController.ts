import { useMemo, useRef, useState } from 'react'

import { isEmpty,toNullable } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'
import type { WorkbenchDirectoryEntry } from '@velaros-ai/core/types'
import { buildWorkbenchProjectContextIndex } from '@velaros-ai/workbench/models/project/workbenchProjectContextIndex'
import type { WorkbenchProject } from '@velaros-ai/workbench/models/project/workbenchProjects'
import {
  readWorkbenchProjectSession,
  saveWorkbenchProjectSessionSnapshot,
} from '@velaros-ai/workbench/models/project/workbenchProjectSessionModel'

import type { EditorNavigationRequest } from '../components/editor/CodeInsightPanel'
import { useStableWorkbenchMessageTranslate } from '../runtime/useStableWorkbenchMessaging'
import { useMemoizedFn } from '../support/genericHooks'

import { useWorkbenchCommandController } from './useWorkbenchCommandController'
import { useWorkbenchEditorController } from './useWorkbenchEditorController'
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
  sessionCursorByPathRef?: React.MutableRefObject<Record<string, { line: number; column: number }>>
}

export interface WorkbenchSelectFileOptions {
  quiet?: boolean
}

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
    onSelectEntryPath: tree.setSelectedEntryPath,
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

  const selectFile = useMemoizedFn(
    async (path: string, options: WorkbenchSelectFileOptions = {}): Promise<void> => {
      await editor.selectFile(path, options)
      await tree.revealEntryPath(path, options)
    }
  )

  const mutation = useWorkbenchMutationController({
    activeProject: project.activeProject,
    selectedEntry: tree.selectedEntry,
    selectedEntryPath: tree.selectedEntryPath,
    ensureNoUnsavedFilesInPath: editor.ensureNoUnsavedFilesInPath,
    selectFile,
    moveOpenEntryPath: editor.moveOpenEntryPath,
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
  })
  const persistActiveProjectSession = useMemoizedFn((): void => {
    if (!shouldPersistProjectSession) return

    const projectId = project.activeProjectId
    if (!projectId) return

    saveWorkbenchProjectSessionSnapshot(projectId, {
      expandedPaths: tree.expandedPaths,
      selectedEntryPath: tree.selectedEntryPath,
      openTabPaths: editor.openTabs.map((tab) => tab.path),
      selectedFilePath: editor.selectedFilePath,
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

          const hasOpenTabs = !isEmpty(session.openTabPaths)
          const hasSelectedFile = !!session.selectedFilePath
          if (hasOpenTabs || hasSelectedFile) {
            await editor.restoreEditorSession({
              openTabPaths: session.openTabPaths,
              options: { quiet: true },
              selectedFilePath: session.selectedFilePath,
            })
          }

          const cursorPath = session.selectedFilePath ?? toNullable(session.openTabPaths[0])
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

  function closeProject(): void {
    if (!editor.ensureNoUnsavedChanges()) return

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

  const openSearchEntry = useMemoizedFn(async (entry: WorkbenchDirectoryEntry): Promise<void> => {
    if (entry.type === 'file') {
      await selectFile(entry.path)
      return
    }

    await tree.openDirectory(entry.path)
  })

  return {
    sortedProjects: project.sortedProjects,
    activeProject: project.activeProject,
    workspaceBindingVersion: project.workspaceBindingVersion,
    rootEntries: tree.rootEntries,
    selectedEntry: tree.selectedEntry,
    selectedEntryPath: tree.selectedEntryPath,
    selectedFilePath: editor.selectedFilePath,
    selectedFile: editor.selectedFile,
    editorContent: editor.editorContent,
    openTabs: editor.openTabs,
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
    canEditSelectedFile: editor.canEditSelectedFile,
    isPicking: project.isPicking,
    isLoadingTree: tree.isLoadingTree,
    isSavingFile: editor.isSavingFile,
    saveRevision: editor.saveRevision,
    isMutatingTree: mutation.isMutatingTree,
    isSearchingEntries: search.isSearchingEntries,
    isIndexingProject: projectIndex.isIndexingProject,
    isStartingProjectAiIndex: projectIndex.isStartingProjectAiIndex,
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
    projectAiIndexStatus: projectIndex.projectAiIndexStatus,
    projectContextIndex,
    languageServiceInsights,
    pendingSessionNavigation,
    clearPendingSessionNavigation,
    applyLanguageServiceFileChanges: editor.applyLanguageServiceFileChanges,
    setEditorContent: editor.setEditorContent,
    setAutomatedPreviewActive: editor.setAutomatedPreviewActive,
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
    startProjectAiIndex: projectIndex.startProjectAiIndex,
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
    reorderOpenTabs: editor.reorderOpenTabs,
    revertSelectedFile: editor.revertSelectedFile,
    beginCreateEntry: mutation.beginCreateEntry,
    beginRenameEntry: mutation.beginRenameEntry,
    createTreeEntry: mutation.createTreeEntry,
    renameTreeEntry: mutation.renameTreeEntry,
    moveTreeEntries: mutation.moveTreeEntries,
    deleteTreeEntries: mutation.deleteTreeEntries,
    moveEntryByPath: mutation.moveEntryByPath,
    deleteEntryByPath: mutation.deleteEntryByPath,
    undoLastDeletedEntries: mutation.undoLastDeletedEntries,
    resetTreeAction: mutation.resetTreeAction,
    resetSearch: search.resetSearch,
    submitTreeAction: mutation.submitTreeAction,
    deleteSelectedEntry: mutation.deleteSelectedEntry,
    saveSelectedFile: editor.saveSelectedFile,
    saveAllOpenFiles: editor.saveAllOpenFiles,
    reloadSelectedFileFromDisk: editor.reloadSelectedFileFromDisk,
    resolveSelectedExternalFileConflict: editor.resolveSelectedExternalFileConflict,
    runCommand: commandActions.command.runCommand,
    rerunLastCommand: commandActions.command.rerunLastCommand,
    createTerminalSession: commandActions.terminal.createTerminalSession,
    setTerminalInput: commandActions.terminal.setTerminalInput,
    runTerminalInput: commandActions.terminal.runTerminalInput,
    stopTerminalSession: commandActions.terminal.stopTerminalSession,
    closeTerminalSession: commandActions.terminal.closeTerminalSession,
    setActiveRunSessionId: commandActions.run.setActiveRunSessionId,
    launchRunSession: commandActions.run.launchRunSession,
    stopRunSession: commandActions.run.stopRunSession,
    restartRunSession: commandActions.run.restartRunSession,
    closeRunSession: commandActions.run.closeRunSession,
    setRunSessionInput: commandActions.run.setRunSessionInput,
    writeRunSessionInput: commandActions.run.writeRunSessionInput,
    sendRunSessionInterrupt: commandActions.run.sendRunSessionInterrupt,
  }
}
