/**
 * 独立工作台页面的编排 model：集中所有控制器 hook、派生值与交互 handler，
 * 供 `StandaloneWorkbenchPagePresentation` 通过 context 消费。从 WorkbenchPage 抽出，逻辑逐字保留。
 */
import { type CSSProperties, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  useWorkbenchChatProjectRuntime,
  useWorkbenchProductRuntime,
  type WorkbenchBrowserElementSelectionDelivery,
  type WorkbenchChatFileChangeEntry,
  type WorkbenchChatRunChangesTarget,
} from '@renderer/composition'
import { useWorkbenchAiChanges } from '@renderer/hooks/useWorkbenchAiChanges'
import { useWorkbenchChatChangePreview } from '@renderer/hooks/useWorkbenchChatChangePreview'
import { useWorkbenchKeyboardShortcuts } from '@renderer/hooks/useWorkbenchKeyboardShortcuts'
import { useWorkbenchKeymapController } from '@renderer/hooks/useWorkbenchKeymapController'
import { useWorkbenchLayoutController } from '@renderer/hooks/useWorkbenchLayoutController'
import { useWorkbenchPreferences } from '@renderer/hooks/useWorkbenchPreferences'
import { useWorkbenchProjectGitSettings } from '@renderer/hooks/useWorkbenchProjectGitSettings'
import { useWorkbenchProjectRunSettings } from '@renderer/hooks/useWorkbenchProjectRunSettings'
import { useWorkbenchStandaloneProjectSync } from '@renderer/hooks/useWorkbenchStandaloneProjectSync'
import { useWorkbenchSurfaceState } from '@renderer/hooks/useWorkbenchSurfaceState'
import { workbenchHost } from '@renderer/host'
import {
  resolveReleasedAiHighlightTabs,
  useWorkbenchAiHighlightStore,
  type WorkbenchAiHighlightTabSet,
} from '@renderer/models/aiHighlights/workbenchAiHighlightStore'
import { resolveWorkbenchChatWorkspacePath } from '@renderer/models/chat/workbenchChatWorkspacePath'
import { buildWorkbenchAgentRunSnapshot } from '@renderer/models/commands/workbenchAgentRunSnapshot'
import { getWorkbenchCommandStatusLabel } from '@renderer/models/commands/workbenchCommandStatusModel'
import { inferPackageManagerCommand } from '@renderer/models/commands/workbenchCommandSuggestions'
import { inferWorkbenchPackageManagerForPackageJsonPath } from '@renderer/models/commands/workbenchPackageScriptCommand'
import { buildWorkbenchAgentEditorState } from '@renderer/models/editor/workbenchAgentEditorState'
import { buildWorkbenchLanguageServiceRequestBase } from '@renderer/models/editor/workbenchCodeMirrorLanguageService'
import { getWorkbenchLanguageServiceDiagnostics } from '@renderer/models/editor/workbenchLanguageServiceIpc'
import { buildWorkbenchPackageScriptRunActions } from '@renderer/models/editor/workbenchPackageScriptRunGutter'
import {
  useWorkbenchExplanations,
  useWorkbenchExplanationStore,
} from '@renderer/models/explanations/workbenchExplanationStore'
import type { WorkbenchGitChangeItem } from '@renderer/models/git/workbenchGitModel'
import { resolveWorkbenchGitSurfacesActive } from '@renderer/models/git/workbenchGitSurfaceActivation'
import { resolveWorkbenchNavigationSurface } from '@renderer/models/layout/workbenchSurfaceModel'
import { saveLightEditorTab } from '@renderer/models/lightEditorModel'
import {
  clearWorkbenchProjectAiIndexDecision,
  getWorkbenchProjectAiIndexDecision,
  setWorkbenchProjectAiIndexDecision,
} from '@renderer/models/project/workbenchProjectAiIndexDecision'
import {
  createTransientWorkbenchProject,
  ensureWorkbenchProjectRegistered,
  normalizeWorkbenchProjectList,
  type WorkbenchProject,
} from '@renderer/models/project/workbenchProjects'
import type { PersistedWorkbenchEditorCursor } from '@renderer/models/project/workbenchProjectSessionModel'
import {
  getZoomedWorkbenchEditorZoomLevel,
  type WorkbenchEditorZoomAction,
} from '@renderer/models/settings/workbenchPreferences'
import { fileLanguage } from '@renderer/models/shared/workbenchUtils'
import type { WorkbenchLightEditorTab } from '@renderer/types/workbenchTypes'

// 独立宿主改判：受控浏览器面走应用内空实现（无内嵌浏览器宿主），契约形状与
// @velaros-ai/browser/composition 同源；desktop 的 onboarding 派发已剥除（独立应用无引导层）。
import { useControlledBrowserSurface } from '@velaros-ai/browser/composition'
import { isEmpty,isObject, isString, isTrue, Log, toNullable } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'
import { Result } from '@velaros-ai/core/result'
import { currentSystemPlatform as systemPlatformCompatibility } from '@velaros-ai/system/platform-compatibility'

import type {
  BrowserElementSelection,
  SystemFileChangePreviewResult,
  WorkbenchReadFileResult,
} from '@shared/contracts'
import type {
  WorkbenchAgentFileProblems,
  WorkbenchAgentOpenFilesResult,
  WorkbenchAgentUiCommand,
  WorkbenchAgentUiOpenFile,
} from '@shared/workbenchAgentUi'

import {
  findWorkbenchBrowserMod,
  useStandaloneWorkbenchModCatalog,
} from '../runtime/standaloneWorkbenchMods'
import { useStableWorkbenchMessageTranslate } from '../runtime/useStableWorkbenchMessaging'
import { registerWorkbenchAgentUiHandler } from '../runtime/workbenchAgentUiHost'
import { SystemDefaultEditorLightId } from '../support/defaultEditor'
import { useLatest, useMemoizedFn, useTimerScope } from '../support/genericHooks'
import { useWorkspaceFilesChangedRefresh } from '../support/useWorkspaceFilesChangedRefresh'

import { useCodeGraphResourceAvailability } from './useCodeGraphResourceAvailability'
import { useWorkbenchAgentWorkspaceSignalsReporting } from './useWorkbenchAgentWorkspaceSignalsReporting'
import { useWorkbenchContentSearchController } from './useWorkbenchContentSearchController'
import { useWorkbenchController } from './useWorkbenchController'
import { useWorkbenchEditorNavigationState } from './useWorkbenchEditorNavigationState'
import { useWorkbenchGitChangeActions } from './useWorkbenchGitChangeActions'
import { useWorkbenchGitState } from './useWorkbenchGitState'
import { useWorkbenchProjectSessionPersistence } from './useWorkbenchProjectSessionPersistence'
import { useWorkbenchTopRunControl } from './useWorkbenchTopRunControl'

const LIGHT_FILE_PREVIEW_MAX_CHARS = 300_000
const WORKBENCH_NATIVE_AI_RULES_PATH = '.velar/rules.md'
const log = Log.tag('workbench-page')

interface UseStandaloneWorkbenchPageModelOptions {
  bootstrapProjects?: readonly WorkbenchProject[]
  lockedProjectId?: LooseOptional<string>
  lockedProjectRootPath?: LooseOptional<string>
  /** hook 发起的项目窗口：把 lockedProjectRootPath 正式注册进项目工作区，而不是 transient。 */
  registerLockedProject?: boolean
  surface?: 'standalone' | 'embedded'
}

export type PendingWorkbenchBrowserElementSelection = WorkbenchBrowserElementSelectionDelivery

/** 一次页面导航：去向（决定编辑区落在哪一组、左侧切到哪个面板）加上要放进编辑区的东西。 */
type WorkbenchNavigationRequest =
  | {
      target: 'file'
      path: string
      /** 给出时定位到这一行；不给只切到文件。 */
      line?: number
      column?: number
      /** false：只移动视图不抢焦点（Agent 发起的定位）。 */
      focus?: boolean
    }
  | { target: 'file-preview'; tab: WorkbenchLightEditorTab }
  | { target: 'reveal'; path: string }
  | { target: 'git-diff'; item: WorkbenchGitChangeItem }
  | { target: 'ai-changes'; round: WorkbenchChatRunChangesTarget }

function normalizeWorkspaceRoot(root: LooseOptional<string>): string {
  return (root ?? '').replace(/[\\/]+$/, '')
}

function countLines(content: string): number {
  return content ? content.split('\n').length : 1
}

function getTextSize(content: string): number {
  return new TextEncoder().encode(content).length
}

function getLatestFileChangePreview(
  entry: WorkbenchChatFileChangeEntry
): Nullable<SystemFileChangePreviewResult> {
  return toNullable(entry.previews?.at(-1))
}

function buildLightTabFromChangePreview(
  entry: WorkbenchChatFileChangeEntry,
  projectRoot: string
): Nullable<WorkbenchLightEditorTab> {
  const preview = getLatestFileChangePreview(entry)
  if (!preview) return null

  const content = preview.rolledBack ? preview.beforeContent : preview.afterContent
  return {
    id: `${projectRoot}\0${entry.path}`,
    projectRoot,
    path: entry.path,
    content,
    size: getTextSize(content),
    modifiedAt: null,
    totalLines: countLines(content),
    truncated: false,
  }
}

function buildLightTabFromReadFile(file: WorkbenchReadFileResult): WorkbenchLightEditorTab {
  return {
    id: `${file.projectRoot}\0${file.path}`,
    projectRoot: file.projectRoot,
    path: file.path,
    content: file.content,
    size: file.size,
    modifiedAt: file.modifiedAt,
    totalLines: file.totalLines,
    truncated: file.truncated,
    imagePreview: file.imagePreview,
  }
}

function findFileChangeReviewEntry({
  activeProjectRoot,
  entries,
}: {
  activeProjectRoot: string
  entries: readonly WorkbenchChatFileChangeEntry[]
}): Nullable<WorkbenchChatFileChangeEntry> {
  const activeRoot = normalizeWorkspaceRoot(activeProjectRoot)

  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]
    if (!entry) continue

    const entryRoot = normalizeWorkspaceRoot(entry.rootPath)
    if (entryRoot && entryRoot !== activeRoot) {
      continue
    }

    return entry
  }

  return toNullable(entries.at(-1))
}

function getFileChangeOpenPath(entry: WorkbenchChatFileChangeEntry): string {
  if (!entry.rootPath || systemPlatformCompatibility.isAbsolutePathText(entry.path))
    return entry.path

  return systemPlatformCompatibility.joinPathText(entry.rootPath, entry.path)
}

export function useStandaloneWorkbenchPageModel(
  options: LooseOptional<string> | UseStandaloneWorkbenchPageModelOptions = null
) {
  const optionRecord = options && isObject(options) ? options : null
  const lockedProjectRootPath = isString(options)
    ? null
    : toNullable(optionRecord?.lockedProjectRootPath)
  const registerLockedProject = !isString(options) && isTrue(optionRecord?.registerLockedProject)
  // hook 发起的窗口把 root 正式注册进项目工作区（出现在项目列表里）；
  // 其余 rootPath 锁定窗口维持 transient 语义（临时 workspace root，不落项目列表）。
  const rootLockedProject = useMemo(
    () =>
      lockedProjectRootPath
        ? registerLockedProject
          ? ensureWorkbenchProjectRegistered(lockedProjectRootPath)
          : createTransientWorkbenchProject(lockedProjectRootPath)
        : null,
    [lockedProjectRootPath, registerLockedProject]
  )
  const explicitLockedProjectId = isString(options)
    ? options
    : toNullable(optionRecord?.lockedProjectId)
  const lockedProjectId = toNullable(explicitLockedProjectId ?? rootLockedProject?.id)
  const bootstrapProjects = useMemo(
    () =>
      normalizeWorkbenchProjectList([
        ...((optionRecord?.bootstrapProjects ?? []) as readonly WorkbenchProject[]),
        ...(rootLockedProject ? [rootLockedProject] : []),
      ]),
    [optionRecord?.bootstrapProjects, rootLockedProject]
  )
  const surfaceMode = optionRecord?.surface ?? 'standalone'
  const shouldPersistProjectList =
    surfaceMode === 'standalone' && (!rootLockedProject || registerLockedProject)
  const translate = useStableWorkbenchMessageTranslate()
  const { locale, t } = translate
  const {
    config: { defaultEditor, git: globalGitConfig },
  } = useWorkbenchProductRuntime()
  const sessionCursorByPathRef = useRef<Record<string, PersistedWorkbenchEditorCursor>>({})
  const shouldUseProjectSession = surfaceMode === 'standalone'
  const codeGraphResourceAvailable = useCodeGraphResourceAvailability()
  const workbenchMods = useStandaloneWorkbenchModCatalog()
  const browserModEnabled = findWorkbenchBrowserMod(workbenchMods.value)?.enabled === true
  const aiHighlightStore = useWorkbenchAiHighlightStore()
  const workbench = useWorkbenchController({
    bootstrapProjects,
    lockedProjectId,
    persistProjectList: shouldPersistProjectList,
    persistProjectSession: shouldUseProjectSession,
    restoreProjectSession: shouldUseProjectSession,
    // Project 基础索引是内置能力；CodeGraph 只决定增强图谱入口是否点亮。
    projectIndexEnabled: true,
    sessionCursorByPathRef,
    // AI 选区锁在文件上：文件改名、移动不算关掉，跟着换路径。
    onOpenEntryPathMoved: aiHighlightStore.renamePath,
  })
  const chat = useWorkbenchChatProjectRuntime(toNullable(workbench.activeProject?.rootPath))
  const { currentSession, conversationVersion, sessions } = chat
  const controlledAgentBrowser = useControlledBrowserSurface({
    sessionId: currentSession.id,
    workspaceRefreshKey: currentSession.workspaceVersion + conversationVersion,
    activationToken: chat.browserActivationToken,
  })
  const agentBrowser = browserModEnabled
    ? controlledAgentBrowser
    : { ...controlledAgentBrowser, active: false, activationToken: null }
  const surface = useWorkbenchSurfaceState()
  const layout = useWorkbenchLayoutController({
    commandPanelOpen: !surface.isCommandPanelCollapsed,
    rightToolOpen: surface.isRightToolOpen,
  })
  const projectGitSettings = useWorkbenchProjectGitSettings(workbench.activeProject?.rootPath)
  const projectRunSettings = useWorkbenchProjectRunSettings(workbench.activeProject?.rootPath)
  const workbenchPreferences = useWorkbenchPreferences()
  const workbenchKeymap = useWorkbenchKeymapController()
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [aiIndexPromptOpen, setAiIndexPromptOpen] = useState(false)
  const [aiIndexDetailsOpen, setAiIndexDetailsOpen] = useState(false)
  const [codeGraphOpen, setCodeGraphOpen] = useState(false)
  const [velarLogicGraphOpen, setVelarLogicGraphOpen] = useState(false)
  const [velarLogicGraphActive, setVelarLogicGraphActive] = useState(false)
  const [pendingBrowserElementSelections, setPendingBrowserElementSelections] = useState<
    PendingWorkbenchBrowserElementSelection[]
  >([])
  const [aiIndexDecisionVersion, setAiIndexDecisionVersion] = useState(0)

  const exitCurrentProject = useMemoizedFn(async (): Promise<boolean> => {
    if (!workbench.closeProject()) return false

    setSettingsOpen(false)
    await window.velarosWorkbenchProjectHub.returnToEntry()
    return true
  })

  /*
   * 结构入口按**项目**判定，不看当前选中的是哪个文件。
   *
   * 之前第一条是 `selectedFilePath.endsWith('.vel')`：于是在 VelarScript 项目里，只要焦点落在
   * README 或 package.json 上，左侧栏那颗按钮就整颗消失，用户以为功能没了。结构图描述的是
   * 整个项目，它在不在场跟你此刻点开哪个文件没有关系。
   */
  const velarLogicGraphAvailable = workbench.projectContextIndex.files.some(
    (file) => file.path === 'velar.json' || file.path.endsWith('.vel')
  )
  const codeGraphAvailable = codeGraphResourceAvailable && !velarLogicGraphAvailable

  useEffect(() => {
    if (codeGraphAvailable) return
    setAiIndexPromptOpen(false)
    setAiIndexDetailsOpen(false)
  }, [codeGraphAvailable])

  useEffect(() => {
    if (codeGraphAvailable) return
    setCodeGraphOpen(false)
  }, [codeGraphAvailable])

  useEffect(() => {
    if (velarLogicGraphAvailable) return
    setVelarLogicGraphOpen(false)
    setVelarLogicGraphActive(false)
  }, [velarLogicGraphAvailable])

  useEffect(() => {
    if (velarLogicGraphOpen) return
    setVelarLogicGraphActive(false)
  }, [velarLogicGraphOpen])

  const activeWorkbenchChatSessionId =
    surface.activeRightTool === 'chat' && currentSession.kind === 'chat' ? currentSession.id : null
  const gitSurfacesActive = resolveWorkbenchGitSurfacesActive({
    activeBottomTool: surface.activeBottomTool,
    activeLeftTool: surface.activeLeftTool,
    activeWorkbenchChatSessionId,
    isCommandPanelCollapsed: surface.isCommandPanelCollapsed,
  })
  const gitState = useWorkbenchGitState({
    activeProject: workbench.activeProject,
    gitSurfacesActive,
    workspaceBindingVersion: workbench.workspaceBindingVersion,
  })
  const activePackageScriptRunConfigurations = useMemo(() => {
    if (!workbench.selectedFilePath) return []

    const fallbackPackageManager = inferPackageManagerCommand(workbench.rootEntries)
    const packageManager = inferWorkbenchPackageManagerForPackageJsonPath(
      workbench.selectedFilePath,
      workbench.projectContextIndex.files,
      fallbackPackageManager
    )

    return buildWorkbenchPackageScriptRunActions({
      content: workbench.editorContent,
      packageManager,
      path: workbench.selectedFilePath,
    }).map((action) => ({
      command: action.command,
      label: action.label,
    }))
  }, [
    workbench.editorContent,
    workbench.projectContextIndex.files,
    workbench.rootEntries,
    workbench.selectedFilePath,
  ])
  const topRunControl = useWorkbenchTopRunControl({
    commandHistory: workbench.commandHistory,
    runConfigurations: [...activePackageScriptRunConfigurations, ...workbench.runConfigurations],
    runningSessions: workbench.runSessions,
    configuredCommand: projectRunSettings.settings.command,
    lastLaunchedCommand: workbench.lastLaunchedCommand,
    onLaunchCommand: (command, label) => void workbench.launchRunSession(command, label),
    onRestartRunSession: (sessionId) => void workbench.restartRunSession(sessionId),
    onConfigureCommand: projectRunSettings.setCommand,
  })
  const runSessionIds = workbench.runSessions.map((session) => session.id).join('\0')
  const knownRunSessionIdsRef = useRef(new Set<string>())

  useEffect(() => {
    const currentRunSessionIds = new Set(workbench.runSessions.map((session) => session.id))
    const createdRunSession = workbench.runSessions.some(
      (session) => !knownRunSessionIdsRef.current.has(session.id)
    )
    const closedLastRunSession =
      currentRunSessionIds.size === 0 && knownRunSessionIdsRef.current.size > 0

    knownRunSessionIdsRef.current = currentRunSessionIds

    if (createdRunSession) {
      surface.openBottomTool('run')
      return
    }
    if (
      closedLastRunSession &&
      surface.activeBottomTool === 'run' &&
      !surface.isCommandPanelCollapsed
    ) {
      surface.collapseCommandPanel()
    }
  }, [
    runSessionIds,
    surface.activeBottomTool,
    surface.collapseCommandPanel,
    surface.isCommandPanelCollapsed,
    surface.openBottomTool,
    workbench.runSessions,
  ])
  const editorNavigation = useWorkbenchEditorNavigationState({
    browserEnabled: browserModEnabled,
    gitChangeItems: gitState.changeItems,
    selectedFilePath: workbench.selectedFilePath,
    onSelectFile: workbench.selectFile,
  })
  const agentBrowserBindingSessionId = agentBrowser.active ? currentSession.id : null
  const openAgentBrowserTab = editorNavigation.debug.agentBrowser.open
  const closeAgentBrowserTab = editorNavigation.debug.agentBrowser.close
  useEffect(() => {
    if (agentBrowserBindingSessionId) {
      openAgentBrowserTab(agentBrowserBindingSessionId)
      return
    }

    closeAgentBrowserTab()
  }, [agentBrowserBindingSessionId, closeAgentBrowserTab, openAgentBrowserTab])
  useWorkbenchProjectSessionPersistence({
    enabled: shouldUseProjectSession,
    projectId: toNullable(workbench.activeProject?.id),
    expandedPaths: workbench.expandedPaths,
    selectedEntryPath: workbench.selectedEntryPath,
    openTabs: workbench.openTabs,
    selectedFilePath: workbench.selectedFilePath,
    cursorPosition: editorNavigation.cursorPosition,
    cursorByPathRef: sessionCursorByPathRef,
  })

  const goToLocationLatest = useLatest(editorNavigation.goToLocation)
  useEffect(() => {
    const pending = workbench.pendingSessionNavigation
    const selectedFilePath = workbench.selectedFilePath
    if (!pending || !selectedFilePath) return

    void goToLocationLatest.current(selectedFilePath, pending.line, pending.column).finally(() => {
      workbench.clearPendingSessionNavigation()
    })
  }, [
    goToLocationLatest,
    workbench.clearPendingSessionNavigation,
    workbench.pendingSessionNavigation?.id,
    workbench.selectedFilePath,
  ])

  const contentSearch = useWorkbenchContentSearchController({
    activeProject: workbench.activeProject,
    openTabs: workbench.openTabs,
    query: workbench.normalizedSearchQuery,
    enabled: workbench.searchActive,
  })
  const effectiveGitSshKeyPath =
    projectGitSettings.settings.gitSshKeyPath.trim() ||
    globalGitConfig.privateKeyPath ||
    globalGitConfig.sshKeyPath
  const shellStyle: CSSProperties = {
    ...layout.style,
    ...workbenchPreferences.style,
  }
  const aiIndexDecision = useMemo(
    () =>
      workbench.activeProject
        ? getWorkbenchProjectAiIndexDecision(workbench.activeProject.id)
        : null,
    [aiIndexDecisionVersion, workbench.activeProject]
  )
  const projectAiIndexSkipped = aiIndexDecision === 'skipped'
  const canOpenCodeGraph =
    codeGraphAvailable &&
    workbench.projectAiIndexStatus?.status === 'ready' &&
    !!workbench.projectAiIndexStatus?.codeIndex?.initialized

  /** `titleBarStyle: hiddenInset`: reserve horizontal inset for macOS traffic lights on the standalone window */
  const macTitleInset =
    /^Mac/i.test(navigator.platform) || /\bMac OS X\b/i.test(navigator.userAgent)
  const hostPlatform = macTitleInset
    ? 'macos'
    : /\bWindows\b/i.test(navigator.userAgent)
      ? 'windows'
      : 'linux'

  useWorkbenchKeyboardShortcuts({
    activeRightTool: surface.activeRightTool,
    enabled: surfaceMode === 'standalone' && !!workbench.activeProject && !settingsOpen,
    isQuickOpenOpen: surface.isQuickOpenOpen,
    keymap: workbenchKeymap.keymap,
    onCloseRightTool: surface.closeRightTool,
    onOpenBottomTool: surface.openBottomTool,
    onOpenQuickOpen: surface.openQuickOpen,
    onRunLastCommand: workbench.rerunLastCommand,
    onSaveAll: () => workbench.saveAllOpenFiles(),
    onSaveCurrent: () => workbench.saveSelectedFile(),
    onToggleRightTool: surface.toggleRightTool,
  })
  useWorkbenchStandaloneProjectSync({
    activeProject: workbench.activeProject,
    lockedProjectId,
    projects: workbench.sortedProjects,
    standalone: true,
    updateDocumentTitle: surfaceMode === 'standalone',
    onOpenProject: workbench.openProject,
  })

  const zoomEditor = useMemoizedFn((action: WorkbenchEditorZoomAction): void => {
    workbenchPreferences.updatePreferences({
      editorZoomLevel: getZoomedWorkbenchEditorZoomLevel(
        workbenchPreferences.preferences.editorZoomLevel,
        action
      ),
    })
  })

  useEffect(() => {
    if (surfaceMode !== 'standalone') return

    return window.velarosWorkbenchProjectHub.onMenuCommand((command) => {
      switch (command) {
        case 'close-project': {
          void exitCurrentProject()
          return
        }
        case 'zoom-editor-in': {
          zoomEditor('increase')
          return
        }
        case 'zoom-editor-out': {
          zoomEditor('decrease')
          return
        }
        case 'zoom-editor-reset': {
          zoomEditor('reset')
        }
      }
    })
  }, [exitCurrentProject, surfaceMode, zoomEditor])
  const workspaceFileRefreshInFlightRef = useRef(false)

  useEffect(() => {
    if (
      !codeGraphAvailable ||
      !workbench.activeProject ||
      !workbench.projectAiIndexStatus ||
      workbench.projectAiIndexStatus.status !== 'not-indexed' ||
      projectAiIndexSkipped ||
      workbench.isStartingProjectAiIndex
    )
      return

    setAiIndexPromptOpen(true)
  }, [
    projectAiIndexSkipped,
    codeGraphAvailable,
    workbench.activeProject,
    workbench.isStartingProjectAiIndex,
    workbench.projectAiIndexStatus,
  ])

  const chatChangePreview = useWorkbenchChatChangePreview({
    activeDiffItem: editorNavigation.diffItem,
    autoOpen: false,
    changeItems: gitState.changeItems,
    enabled: !!workbench.activeProject && !!activeWorkbenchChatSessionId,
    onOpenDiff: editorNavigation.openDiff,
    onRefreshWorkspace: refreshWorkspaceChanges,
    onRefreshGit: gitState.refresh,
    session: currentSession,
  })
  const gitChangeActions = useWorkbenchGitChangeActions({
    workspaceRoot: workbench.activeProject?.rootPath ?? '',
    locale,
    hasUnsavedOpenTabs: workbench.hasUnsavedOpenTabs,
    status: toNullable(gitState.summary?.status),
    onRefresh: refreshGitPanelWithWorkspace,
    onRepositoryChanged: handleRepositoryChanged,
    setSelectedChangePath: (path) => {
      if (!path) {
        editorNavigation.closeDiff()
      }
    },
    translate,
  })

  useWorkbenchAgentWorkspaceSignalsReporting({
    projectRoot: workbench.activeProject?.rootPath,
    chatSessionId: activeWorkbenchChatSessionId,
    focusedRelativePath:
      editorNavigation.diffItem?.path ??
      editorNavigation.lightTab?.path ??
      workbench.selectedFilePath,
    cursor: editorNavigation.cursorPosition,
  })

  useWorkspaceFilesChangedRefresh({
    rootPath: workbench.activeProject?.rootPath,
    enabled: !!workbench.activeProject,
    refreshInFlightRef: workspaceFileRefreshInFlightRef,
    onChanged: async () => {
      workspaceFileRefreshInFlightRef.current = true
      try {
        await workbench.refreshLoadedDirectories()
      } finally {
        workspaceFileRefreshInFlightRef.current = false
      }
    },
  })

  async function runTreeMutation<T>(action: () => Promise<T>): Promise<T> {
    return action()
  }

  async function refreshProjectTree(): Promise<void> {
    await workbench.refreshRootDirectory()
  }

  async function refreshWorkspaceChanges(): Promise<void> {
    await workbench.refreshLoadedDirectories()
  }

  async function refreshGitPanelWithWorkspace(): Promise<void> {
    await refreshWorkspaceChanges()
    await gitState.refresh()
  }

  async function refreshProjectAndGit(): Promise<void> {
    await refreshProjectTree()
    await gitState.refresh()
  }

  // 左侧「AI 改动」面板（跟着右侧的当前会话走）与编辑区的只读对比标签组。
  const aiChanges = useWorkbenchAiChanges({
    projectRoot: toNullable(workbench.activeProject?.rootPath),
    sessions,
    currentSessionId: currentSession.id,
    autoOpen: workbenchPreferences.preferences.aiChangesAutoOpen,
    onShow: () => setVelarLogicGraphActive(false),
  })

  /** 让编辑区回到普通文件视图：收起结构图与「AI 改动」这类独占标签组。 */
  const showEditorSurface = useMemoizedFn((): void => {
    setVelarLogicGraphActive(false)
    aiChanges.deactivate()
  })

  /**
   * 页面导航的唯一入口：先按 `resolveWorkbenchNavigationSurface` 把编辑区落在哪一组、左侧切到哪个面板
   * 一起定好，再把东西放进编辑区。聊天里的路径与改动卡、Agent 的界面请求、快速打开等「从别处把东西带到
   * 眼前」的导航都走这里，不再各自收独占组、切左侧。Agent 发起的定位传 `focus: false`，不抢输入框的焦点。
   */
  const navigate = useMemoizedFn(async (request: WorkbenchNavigationRequest): Promise<void> => {
    const { editorGroup, leftTool, revealLeftPanel } = resolveWorkbenchNavigationSurface(
      request.target
    )
    if (editorGroup === 'primary') showEditorSurface()
    if (surface.activeLeftTool !== leftTool) surface.setActiveLeftTool(leftTool)
    if (revealLeftPanel && !surface.isFilePanelOpen) surface.toggleFilePanel()

    switch (request.target) {
      case 'file':
        if (request.line === undefined) await editorNavigation.selectFile(request.path)
        else
          await editorNavigation.goToLocation(request.path, request.line, request.column, {
            focus: request.focus,
          })
        // 文件树平时跟着编辑器的当前文件自己定位（见 useWorkbenchController），但文件本来就是当前文件时
        // 当前文件不变、那边不会动；导航是「把它带到眼前」，左侧也要定位到它。
        await workbench.revealEntryPath(request.path, { quiet: true })
        return
      case 'file-preview':
        editorNavigation.openLightTab(request.tab)
        return
      case 'reveal':
        await workbench.revealEntryPath(request.path)
        return
      case 'git-diff':
        editorNavigation.openDiff(request.item, { focusFirstChange: true })
        return
      case 'ai-changes':
        await aiChanges.openRound(request.round)
    }
  })

  // 左右两侧说的是同一件事，不跨域显示。与 `navigate` 分工：`navigate` 在同一次提交里把两侧一起定好，
  // 这里看到的已是一致的两侧，不会再改；这里只管编辑区组被别的途径进出时让左侧跟上——编辑区进入
  // 「AI 改动」对比（自动打开、改动卡的「查看」、点回对比标签），左侧切到改动树；编辑区离开对比
  // （关掉最后一个对比标签），左侧回到文件树；左侧从改动树切到别的面板，编辑区也收起对比标签组（标签保留，
  // 点回改动树时再带回来）。只在进出的那一刻切换——左侧单独打开改动树浏览、编辑区还没有对比标签时不去动它。
  const aiChangesSyncRef = useRef({ active: aiChanges.active, leftTool: surface.activeLeftTool })
  const { activeLeftTool, setActiveLeftTool } = surface
  const { active: aiChangesActive, deactivate: deactivateAiChanges } = aiChanges
  useEffect(() => {
    const previous = aiChangesSyncRef.current
    aiChangesSyncRef.current = { active: aiChangesActive, leftTool: activeLeftTool }
    if (aiChangesActive !== previous.active) {
      if (aiChangesActive) setActiveLeftTool('ai-changes')
      else if (activeLeftTool === 'ai-changes') setActiveLeftTool('project')
      return
    }
    if (aiChangesActive && previous.leftTool === 'ai-changes' && activeLeftTool !== 'ai-changes')
      deactivateAiChanges()
  }, [activeLeftTool, aiChangesActive, deactivateAiChanges, setActiveLeftTool])

  function handleWorkbenchChatRunChangesReview(target: WorkbenchChatRunChangesTarget): void {
    void navigate({ target: 'ai-changes', round: target })
  }

  // AI 选区锁在文件上：用户关掉某个文件的标签（关一个、关其他、关全部、换项目都算），
  // 它上面的选区才释放（规则见 `resolveReleasedAiHighlightTabs`）。
  const openTabPathsKey = workbench.openTabs.map((tab) => tab.path).join('\0')
  const aiHighlightTabsRef = useRef<WorkbenchAiHighlightTabSet>({ root: '', paths: new Set() })
  const aiHighlightProjectRoot = workbench.activeProject?.rootPath ?? ''
  useEffect(() => {
    const previous = aiHighlightTabsRef.current
    const next = {
      root: aiHighlightProjectRoot,
      paths: new Set(openTabPathsKey ? openTabPathsKey.split('\0') : []),
    }
    aiHighlightTabsRef.current = next
    const released = resolveReleasedAiHighlightTabs(previous, next)
    if (released) aiHighlightStore.clear(released.root, released.paths)
  }, [aiHighlightProjectRoot, aiHighlightStore, openTabPathsKey])

  // AI 讲解气泡：切到某条讲解时把它所在的文件带到编辑器里（滚动由编辑器自己完成）。
  const explanationStore = useWorkbenchExplanationStore()
  const explanations = useWorkbenchExplanations()
  const explanationNavigationRef = useLatest({
    selectedFilePath: workbench.selectedFilePath,
    overlayActive:
      !!editorNavigation.diffItem ||
      !!editorNavigation.lightTab ||
      !!editorNavigation.debug.activeTabId ||
      velarLogicGraphActive ||
      aiChanges.active,
  })
  useEffect(() => {
    const active = explanations.explanations.find(
      (explanation) => explanation.id === explanations.activeId
    )
    if (!active) return
    const { selectedFilePath, overlayActive } = explanationNavigationRef.current
    if (active.path === selectedFilePath && !overlayActive) return
    void navigate({ target: 'file', path: active.path })
    // 只跟随「切到某条讲解」这一个信号；行号回写、清掉别的讲解都不该把编辑器拽走。
  }, [explanations.focusRevision])

  const gitChangeItemsRef = useLatest(gitState.changeItems)
  const agentUiTimers = useTimerScope('WorkbenchAgentUi')
  /** 刚改完的文件可能还没进 Git 状态：刷新一次，等下一次提交把它带出来（最多 1.5 秒）。 */
  async function findGitChangeItem(path: string): Promise<(typeof gitState.changeItems)[number] | null> {
    const find = () => gitChangeItemsRef.current.find((item) => item.path === path) ?? null
    const existing = find()
    if (existing) return existing
    await gitState.refresh()
    for (let waited = 0; waited < 1500; waited += 50) {
      const refreshed = find()
      if (refreshed) return refreshed
      await agentUiTimers.sleep(50, { label: 'agent-ui.git-refresh' })
    }
    return find()
  }

  const runSessionsRef = useLatest(workbench.runSessions)
  /** 刚启动的运行卡要等一次状态提交才出现在列表里：给它一点时间（最多 1 秒）。 */
  async function findRunSession(
    sessionId: string | null
  ): Promise<(typeof workbench.runSessions)[number] | null> {
    const find = () =>
      sessionId
        ? (runSessionsRef.current.find((session) => session.id === sessionId) ?? null)
        : (runSessionsRef.current.at(-1) ?? null)
    for (let waited = 0; waited < 1000; waited += 50) {
      const session = find()
      if (session || !sessionId) return session
      await new Promise((resolve) => window.setTimeout(resolve, 50))
    }
    return find()
  }

  /** 语言服务诊断（`workbench:get_problems`）：打开着的文件按编辑器里的内容查，其余读磁盘。 */
  async function readAgentProblems(
    projectRoot: string,
    requestedPaths: readonly string[] | null
  ): Promise<WorkbenchAgentFileProblems[]> {
    const MaxProblemsPerFile = 50
    const liveTabs = workbench.openTabs.map((tab) =>
      tab.path === workbench.selectedFilePath ? { ...tab, content: workbench.editorContent } : tab
    )
    const paths =
      requestedPaths ?? liveTabs.filter((tab) => !tab.file.imagePreview).map((tab) => tab.path).slice(0, 20)
    return Promise.all(
      paths.map(async (path): Promise<WorkbenchAgentFileProblems> => {
        const openTab = liveTabs.find((tab) => tab.path === path)
        const result = await getWorkbenchLanguageServiceDiagnostics(
          openTab
            ? buildWorkbenchLanguageServiceRequestBase({
                projectRoot,
                path,
                language: fileLanguage(path),
                content: openTab.content,
                openTabs: liveTabs,
              })
            : { projectRoot, path, language: fileLanguage(path) }
        )
        if (!result.ok) throw new AppError('PLATFORM', result.error.message)
        const diagnostics = result.data.diagnostics.filter((diagnostic) => diagnostic.path === path)
        return {
          path,
          problems: diagnostics.slice(0, MaxProblemsPerFile).map((diagnostic) => ({
            severity: diagnostic.severity,
            line: diagnostic.range.startLine,
            column: diagnostic.range.startColumn,
            message: diagnostic.message,
            ...(diagnostic.code !== undefined ? { code: diagnostic.code } : {}),
          })),
          truncated: diagnostics.length > MaxProblemsPerFile,
        }
      })
    )
  }

  // `workbench:*` 工具的界面请求落在这里：在用户眼前打开文件、定位、加讲解气泡、跑命令、开预览。
  const handleAgentUiCommand = useMemoizedFn(
    async (
      command: WorkbenchAgentUiCommand,
      context: { projectRoot: string; sessionId: string }
    ): Promise<Record<string, unknown>> => {
      switch (command.type) {
        case 'open-files': {
          // 按列表顺序在后台开出标签（已经开着的不动），不逐个切过去：逐个切会让编辑器闪一遍每个文件，
          // 最后那次定位也会拿切走前的「当前文件」判断，落到别的文件上。
          const opened: WorkbenchAgentUiOpenFile[] = []
          const failed: string[] = []
          for (const file of command.files) {
            if (await workbench.preloadOpenTab(file.path)) opened.push(file)
            else failed.push(file.path)
          }
          const [primary] = opened
          if (!primary) throw new AppError('NOT_FOUND', `Workbench could not open ${failed.join(', ')}.`)
          // 只给真正开出标签的文件标选区：选区靠「关标签」释放，没开出来的文件永远等不到那一刻。
          aiHighlightStore.add(
            context.projectRoot,
            opened.flatMap((file) => file.highlights.map((range) => ({ path: file.path, ...range })))
          )
          // 最后停在第一个文件、定位到它的行（不抢聊天输入框的焦点）。
          await navigate({
            target: 'file',
            path: primary.path,
            line: primary.line,
            column: primary.column,
            focus: false,
          })
          return {
            opened: opened.map((file) => file.path),
            failed,
          } satisfies WorkbenchAgentOpenFilesResult
        }
        case 'clear-highlights':
          return { cleared: aiHighlightStore.clear(context.projectRoot, command.paths) }
        case 'reveal-path':
          await navigate({ target: 'reveal', path: command.path })
          return { path: command.path }
        case 'open-diff': {
          const item = await findGitChangeItem(command.path)
          if (!item) throw new AppError('NOT_FOUND', `${command.path} has no uncommitted changes.`)
          await navigate({ target: 'git-diff', item })
          return { path: command.path }
        }
        case 'explain-code': {
          const batch = explanationStore.addBatch({
            projectRoot: context.projectRoot,
            sessionId: context.sessionId,
            explanations: command.explanations,
            replace: command.replace,
          })
          // 第一条讲解成了当前讲解：把它的文件带到普通文件区（滚到气泡由编辑器自己完成）。「切到某条讲解」的
          // effect 随后也会跟一次，同一个文件的第二次打开是空操作。
          const [first] = batch
          if (first) await navigate({ target: 'file', path: first.path })
          return { added: batch.length }
        }
        case 'clear-explanations':
          return { cleared: explanationStore.clear(context.projectRoot, command.path) }
        case 'read-editor-state':
          return {
            ...buildWorkbenchAgentEditorState({
              view: aiChanges.active
                ? 'ai-changes'
                : editorNavigation.diffItem
                  ? 'git-diff'
                  : editorNavigation.lightTab ||
                      editorNavigation.debug.activeTabId ||
                      velarLogicGraphActive
                    ? 'other'
                    : workbench.selectedFilePath
                      ? 'file'
                      : 'empty',
              selectedFilePath: workbench.selectedFilePath,
              cursor: editorNavigation.cursorPosition,
              editorContent: workbench.editorContent,
              openTabs: workbench.openTabs,
              explanationCount: explanationStore.listForProject(context.projectRoot).length,
              aiHighlights: aiHighlightStore.listForProject(context.projectRoot),
            }),
          }
        case 'start-run': {
          const sessionId = await workbench.launchRunSession(command.command, command.label)
          if (!sessionId) throw new AppError('PLATFORM', 'Workbench could not start the run.')
          surface.openBottomTool('run')
          return { sessionId }
        }
        case 'read-run': {
          const session = await findRunSession(command.sessionId)
          if (!session)
            throw new AppError(
              'NOT_FOUND',
              command.sessionId
                ? `There is no run ${command.sessionId} in the Run panel.`
                : 'There is no run in the Run panel yet.'
            )
          return { ...buildWorkbenchAgentRunSnapshot(session, command.lines, command.match) }
        }
        case 'stop-run': {
          const session = await findRunSession(command.sessionId)
          if (!session)
            throw new AppError('NOT_FOUND', `There is no run ${command.sessionId} in the Run panel.`)
          if (session.isRunning) await workbench.stopRunSession(session.id)
          return { sessionId: session.id }
        }
        case 'open-preview':
          if (browserModEnabled) {
            showEditorSurface()
            editorNavigation.debug.openTab(command.url)
            return { opened: 'workbench-browser' }
          }
          // 内置浏览器没开：新窗口请求由主进程的外链处理交给系统浏览器。
          window.open(command.url, '_blank', 'noopener')
          return { opened: 'system-browser' }
        case 'read-problems': {
          const files = await readAgentProblems(context.projectRoot, command.paths)
          // 「问题」面板只列当前文件的问题：先把第一个有问题的文件定位到它的第一个问题，面板里才是模型说的那些。
          const shown = command.show
            ? (files.find((file) => file.problems.some((problem) => problem.severity === 'error')) ??
              files.find((file) => file.problems.length > 0))
            : undefined
          const firstProblem =
            shown?.problems.find((problem) => problem.severity === 'error') ?? shown?.problems[0]
          if (shown && firstProblem)
            await navigate({
              target: 'file',
              path: shown.path,
              line: firstProblem.line,
              column: firstProblem.column,
              focus: false,
            })
          if (command.show) surface.openBottomTool('problems')
          return {
            ...(shown && firstProblem
              ? { shown: `${shown.path}:${firstProblem.line}:${firstProblem.column}` }
              : {}),
            files,
            errors: files.reduce(
              (total, file) => total + file.problems.filter((problem) => problem.severity === 'error').length,
              0
            ),
            warnings: files.reduce(
              (total, file) => total + file.problems.filter((problem) => problem.severity === 'warning').length,
              0
            ),
          }
        }
      }
    }
  )
  const agentUiProjectRoot = workbench.activeProject?.rootPath
  useEffect(() => {
    if (!agentUiProjectRoot) return undefined
    return registerWorkbenchAgentUiHandler(agentUiProjectRoot, handleAgentUiCommand)
  }, [agentUiProjectRoot, handleAgentUiCommand])

  async function handleRepositoryChanged(): Promise<void> {
    workbench.closeAllOpenFiles()
    workbench.selectEntryPath(null)
    await refreshProjectAndGit()
  }

  async function initializeRepository(): Promise<void> {
    if (!workbench.activeProject) return

    try {
      Result.unwrap(
        await workbenchHost.kernel.workspace.initializeWorkspaceGitRepository(
          workbench.activeProject.rootPath
        )
      )
      await refreshProjectAndGit()
      translate.messageLatest.current.success({
        title: translate.tLatest.current('workbench.gitInitializeRepositorySuccessTitle'),
        description: workbench.activeProject.name,
      })
    } catch (error) {
      const appError = AppError.from(error)
      translate.messageLatest.current.open({
        title: translate.tLatest.current('workbench.gitInitializeRepositoryFailedTitle'),
        description:
          appError.message.trim() ||
          translate.tLatest.current('workbench.gitInitializeRepositoryFailedFallback'),
        tone: appError.code === 'VALIDATION' ? 'warning' : 'error',
        showClose: true,
      })
      await gitState.refresh()
    }
  }

  async function saveEmbeddedLightTab(): Promise<void> {
    const tab = editorNavigation.lightTab
    if (!tab || tab.truncated) return

    try {
      const saved = await saveLightEditorTab(tab, {
        saveWorkbenchFile: (request) => workbenchHost.kernel.project.saveWorkbenchFile(request),
        writeLocalAttachmentFile: (request) =>
          workbenchHost.kernel.sessions.writeLocalAttachmentFile(request),
      })
      editorNavigation.patchLightTabMetadata(saved)
      translate.messageLatest.current.success({
        title: translate.tLatest.current('workbench.saveSucceeded'),
      })
    } catch (error) {
      const appError = AppError.from(error)
      translate.messageLatest.current.error({
        title: translate.tLatest.current('workbench.saveFileFailed'),
        description: appError.message,
      })
    }
  }

  /** 改动卡里的文件以只读预览打开：优先用卡片带的改动后正文，没有就从磁盘读。 */
  async function openFileChangePreview(
    entry: WorkbenchChatFileChangeEntry,
    projectRoot: string
  ): Promise<void> {
    const previewTab = buildLightTabFromChangePreview(entry, projectRoot)
    if (previewTab) {
      await navigate({ target: 'file-preview', tab: previewTab })
      return
    }

    try {
      const file = Result.unwrap(
        await workbenchHost.kernel.project.readWorkbenchFile({
          projectRoot,
          path: entry.path,
          maxChars: LIGHT_FILE_PREVIEW_MAX_CHARS,
        })
      )
      await navigate({ target: 'file-preview', tab: buildLightTabFromReadFile(file) })
    } catch (error) {
      const appError = AppError.from(error)
      translate.messageLatest.current.error({
        title: translate.tLatest.current('workbench.readFileFailed'),
        description: appError.message,
      })
    }
  }

  async function handleWorkbenchChatFileChangeOpen(
    entry: WorkbenchChatFileChangeEntry
  ): Promise<void> {
    const activeProject = workbench.activeProject
    if (!activeProject) return

    const entryRoot = normalizeWorkspaceRoot(entry.rootPath)
    const activeRoot = normalizeWorkspaceRoot(activeProject.rootPath)

    if (!entryRoot || entryRoot === activeRoot) {
      await navigate({ target: 'file', path: entry.path })
      return
    }

    if (!entry.rootPath) return
    await openFileChangePreview(entry, entry.rootPath)
  }

  async function handleWorkbenchChatFileChangesReview(
    entries: readonly WorkbenchChatFileChangeEntry[]
  ): Promise<void> {
    const activeProject = workbench.activeProject
    if (!activeProject || isEmpty(entries)) return

    const entry = findFileChangeReviewEntry({
      activeProjectRoot: activeProject.rootPath,
      entries,
    })

    if (!entry) return

    if (defaultEditor !== SystemDefaultEditorLightId) {
      try {
        Result.unwrap(
          await workbenchHost.kernel.workspace.openPath(
            currentSession.id,
            getFileChangeOpenPath(entry)
          )
        )
      } catch (error) {
        const appError = AppError.from(error)
        translate.messageLatest.current.error({
          title: translate.tLatest.current('chat.fileChangeOpenErrorTitle'),
          description: appError.message,
        })
      }
      return
    }

    await openFileChangePreview(entry, entry.rootPath ?? activeProject.rootPath)
  }

  /** 回答里的路径在编辑器里打开；返回 false = 不在当前项目里，交给调用方决定要不要让系统打开。 */
  async function handleWorkbenchChatWorkspacePathOpen(path: string): Promise<boolean> {
    const activeProject = workbench.activeProject
    if (!activeProject) return false

    const relativePath = resolveWorkbenchChatWorkspacePath(path, activeProject.rootPath)
    if (!relativePath || relativePath === '.') return false

    await navigate({ target: 'file', path: relativePath })
    return true
  }

  const handleWorkbenchBrowserElementPicked = useCallback(
    (selection: BrowserElementSelection): void => {
      const deliveryId = `${currentSession.id}:${selection.id}`
      setPendingBrowserElementSelections((current) =>
        current.some((item) => item.deliveryId === deliveryId)
          ? current
          : [...current, { deliveryId, targetSessionId: currentSession.id, selection }]
      )
      if (surface.activeRightTool !== 'chat') {
        surface.toggleRightTool('chat')
      }
    },
    [currentSession.id, surface.activeRightTool, surface.toggleRightTool]
  )
  const consumeWorkbenchBrowserElementSelections = useCallback(
    (deliveryIds: readonly string[]): void => {
      const consumed = new Set(deliveryIds)
      setPendingBrowserElementSelections((current) =>
        current.filter((item) => !consumed.has(item.deliveryId))
      )
    },
    []
  )

  function toggleBottomTool(tool: Parameters<typeof surface.openBottomTool>[0]): void {
    if (surface.activeBottomTool === tool && !surface.isCommandPanelCollapsed) {
      surface.toggleCommandPanelCollapsed()
      return
    }

    surface.openBottomTool(tool)
  }

  function skipProjectAiIndex(): void {
    if (workbench.activeProject) {
      setWorkbenchProjectAiIndexDecision(workbench.activeProject.id, 'skipped')
      setAiIndexDecisionVersion((version) => version + 1)
    }
    setAiIndexPromptOpen(false)
  }

  function startProjectAiIndex(): void {
    if (workbench.activeProject) {
      clearWorkbenchProjectAiIndexDecision(workbench.activeProject.id)
      setAiIndexDecisionVersion((version) => version + 1)
    }
    setAiIndexPromptOpen(false)
    void workbench.startProjectAiIndex(true, true)
  }

  async function createProjectAiRulesFile(): Promise<void> {
    const project = workbench.activeProject
    if (!project) return

    try {
      Result.unwrap(
        await workbenchHost.kernel.project.readWorkbenchFile({
          projectRoot: project.rootPath,
          path: WORKBENCH_NATIVE_AI_RULES_PATH,
          maxChars: 1,
        })
      )
    } catch (error) {
      log.debug('工作台原生 AI 规则文件缺失或不可读，创建默认文件', {
        projectRoot: project.rootPath,
        error,
      })
      try {
        Result.unwrap(
          await workbenchHost.kernel.project.createWorkbenchEntry({
            projectRoot: project.rootPath,
            parentPath: '.',
            name: '.velar',
            type: 'directory',
          })
        )
      } catch (createDirectoryError) {
        log.debug('保存前确保工作台原生 AI 规则目录存在失败', {
          projectRoot: project.rootPath,
          error: createDirectoryError,
        })
        // Existing directories are fine; save below will surface real write failures.
      }

      const content =
        locale === 'zh-CN'
          ? [
              '# Velar 项目规则',
              '',
              '- 使用项目已有的包管理器、脚本和架构约定。',
              '- 改动保持聚焦，不混入无关重构。',
              '- 除非用户明确要求，不修改生成文件、锁文件或构建产物。',
              '',
            ].join('\n')
          : [
              '# Velar Project Rules',
              '',
              '- Use the project package manager, scripts, and architecture conventions.',
              '- Keep changes focused on the current task.',
              '- Do not edit generated files, lockfiles, or build outputs unless explicitly asked.',
              '',
            ].join('\n')

      Result.unwrap(
        await workbenchHost.kernel.project.saveWorkbenchFile({
          projectRoot: project.rootPath,
          path: WORKBENCH_NATIVE_AI_RULES_PATH,
          content,
        })
      )
      await workbench.refreshLoadedDirectories()
    }

    await navigate({ target: 'file', path: WORKBENCH_NATIVE_AI_RULES_PATH })
  }

  const commandStatusLabel = getWorkbenchCommandStatusLabel(
    {
      commandResult: workbench.commandResult,
      isRunningCommand: workbench.isRunningCommand,
      isValidationStale: workbench.isValidationStale,
    },
    t
  )
  // 这几个回调一路传进聊天记录的每一条消息（消息气泡按引用判等）：引用不稳，页面任何一次
  // 重渲染（编辑器里打字、光标移动）都会让整段对话跟着重画。
  const openChatFileChange = useMemoizedFn(handleWorkbenchChatFileChangeOpen)
  const reviewChatFileChanges = useMemoizedFn(handleWorkbenchChatFileChangesReview)
  const reviewChatRunChanges = useMemoizedFn(handleWorkbenchChatRunChangesReview)
  const openChatWorkspacePath = useMemoizedFn(handleWorkbenchChatWorkspacePathOpen)

  return {
    workbench,
    surface,
    layout,
    workbenchPreferences,
    workbenchKeymap,
    gitState,
    topRunControl,
    editorNavigation,
    agentBrowser,
    browserModEnabled,
    pendingBrowserElementSelections,
    aiChanges,
    chatChangePreview,
    gitChangeActions,
    /** 页面 chrome / i18n / 派生展示值。 */
    chrome: {
      lockedProjectId,
      translate,
      locale,
      t,
      contentSearchMatches: contentSearch.contentSearchMatches,
      isSearchingContent: contentSearch.isSearchingContent,
      contentSearchTruncated: contentSearch.contentSearchTruncated,
      effectiveGitSshKeyPath,
      shellStyle,
      projectAiIndexSkipped,
      codeGraphAvailable,
      codeGraphResourceAvailable,
      velarLogicGraphAvailable,
      canOpenCodeGraph,
      macTitleInset,
      hostPlatform,
      commandStatusLabel,
    },
    /** 对话框 / 浮层开关状态。 */
    dialogs: {
      settingsOpen,
      setSettingsOpen,
      aiIndexPromptOpen,
      setAiIndexPromptOpen,
      aiIndexDetailsOpen,
      setAiIndexDetailsOpen,
      codeGraphOpen,
      setCodeGraphOpen,
      velarLogicGraphOpen,
      setVelarLogicGraphOpen,
      velarLogicGraphActive,
      setVelarLogicGraphActive,
    },
    /** 交互动作。 */
    actions: {
      runTreeMutation,
      refreshGitPanel: gitState.refresh,
      refreshProjectAndGit,
      handleRepositoryChanged,
      initializeRepository,
      handleWorkbenchChatFileChangeOpen: openChatFileChange,
      handleWorkbenchChatFileChangesReview: reviewChatFileChanges,
      handleWorkbenchChatRunChangesReview: reviewChatRunChanges,
      navigate,
      showEditorSurface,
      handleWorkbenchChatWorkspacePathOpen: openChatWorkspacePath,
      handleWorkbenchBrowserElementPicked,
      consumeWorkbenchBrowserElementSelections,
      saveEmbeddedLightTab,
      toggleBottomTool,
      skipProjectAiIndex,
      startProjectAiIndex,
      createProjectAiRulesFile,
      exitCurrentProject,
    },
  }
}

export type StandaloneWorkbenchPageModel = ReturnType<typeof useStandaloneWorkbenchPageModel>
