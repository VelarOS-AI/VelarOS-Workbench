/**
 * 独立工作台页面的编排 model：集中所有控制器 hook、派生值与交互 handler，
 * 供 `StandaloneWorkbenchPagePresentation` 通过 context 消费。从 WorkbenchPage 抽出，逻辑逐字保留。
 */
import {
  type CSSProperties,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import {
  useWorkbenchChatProjectRuntime,
  type WorkbenchBrowserElementSelectionDelivery,
  type WorkbenchChatFileChangeEntry,
  type WorkbenchChatFileReferenceDelivery,
  type WorkbenchChatRunChangesTarget,
} from '@renderer/composition/WorkbenchChatProvider'
import { useWorkbenchProductRuntime } from '@renderer/composition/WorkbenchProductRuntimeProvider'
import { useWorkbenchAiChanges } from '@renderer/hooks/useWorkbenchAiChanges'
import { useWorkbenchCommandPalette } from '@renderer/hooks/useWorkbenchCommandPalette'
import { useWorkbenchDebugShortcuts } from '@renderer/hooks/useWorkbenchDebugShortcuts'
import { useWorkbenchKeyboardShortcuts } from '@renderer/hooks/useWorkbenchKeyboardShortcuts'
import { useWorkbenchKeymapController } from '@renderer/hooks/useWorkbenchKeymapController'
import { useWorkbenchLayoutController } from '@renderer/hooks/useWorkbenchLayoutController'
import { useWorkbenchNamedRunConfigurations } from '@renderer/hooks/useWorkbenchNamedRunConfigurations'
import { useWorkbenchPreferences } from '@renderer/hooks/useWorkbenchPreferences'
import { useWorkbenchProjectFileList } from '@renderer/hooks/useWorkbenchProjectFileList'
import { useWorkbenchProjectGitSettings } from '@renderer/hooks/useWorkbenchProjectGitSettings'
import { useWorkbenchProjectRunSettings } from '@renderer/hooks/useWorkbenchProjectRunSettings'
import { useWorkbenchRecentFiles } from '@renderer/hooks/useWorkbenchRecentFiles'
import { useWorkbenchSurfaceState } from '@renderer/hooks/useWorkbenchSurfaceState'
import { workbenchHost } from '@renderer/host/WorkbenchHost'
import { resolveWorkbenchChatWorkspacePath } from '@renderer/models/chat/workbenchChatWorkspacePath'
import { getWorkbenchCommandStatusLabel } from '@renderer/models/commands/workbenchCommandStatusModel'
import { inferPackageManagerCommand } from '@renderer/models/commands/workbenchCommandSuggestions'
import { inferWorkbenchPackageManagerForPackageJsonPath } from '@renderer/models/commands/workbenchPackageScriptCommand'
import { installWorkbenchRunSessionLauncher } from '@renderer/models/commands/workbenchRunSessionBridge'
import {
  getWorkbenchDebugStatus,
  installWorkbenchDebugPageHooks,
  subscribeWorkbenchDebugStatus,
} from '@renderer/models/debug/workbenchDebugBridge'
import {
  findWorkbenchEditorGroupIndex,
  resolveWorkbenchEditorTabGroupIndex,
  type WorkbenchEditorOpenTabIntent,
} from '@renderer/models/editor/workbenchEditorGroups'
import { buildWorkbenchPackageScriptRunActions } from '@renderer/models/editor/workbenchPackageScriptRunGutter'
import { resolveWorkbenchGitSurfacesActive } from '@renderer/models/git/workbenchGitSurfaceActivation'
import { resolveWorkbenchNavigationSurface } from '@renderer/models/layout/workbenchSurfaceModel'
import { saveLightEditorTab } from '@renderer/models/lightEditorModel'
import {
  normalizeWorkbenchProjectRootPath,
  type WorkbenchProject,
} from '@renderer/models/project/workbenchProjects'
import type { PersistedWorkbenchEditorCursor } from '@renderer/models/project/workbenchProjectSessionModel'
import {
  getZoomedWorkbenchEditorZoomLevel,
  type WorkbenchEditorZoomAction,
} from '@renderer/models/workbenchPreferences'
import type { WorkbenchLightEditorTab } from '@renderer/types/workbenchTypes'

import { type BrowserElementSelection } from '@velaros-ai/capabilities/browser/contracts'
import { isEmpty, Log, toNullable } from '@velaros-ai/velaros/core'
import { AppError } from '@velaros-ai/velaros/core/error'
import { currentPlatform as systemPlatformCompatibility } from '@velaros-ai/velaros/core/platform'
import { Result } from '@velaros-ai/velaros/core/result'

import { type SystemFileChangePreviewResult } from '@shared/contracts/system'
import {
  type WorkbenchContentSearchMatchResult,
  type WorkbenchReadFileResult,
} from '@shared/contracts/workbench'
import type { WorkbenchWatchStatus } from '@shared/workbenchWatch'

import { useStableWorkbenchMessageTranslate } from '../runtime/useStableWorkbenchMessaging'
import { useWorkbenchAgentBrowserSite } from '../runtime/workbenchAgentBrowserSite'
import { SystemDefaultEditorLightId } from '../support/defaultEditor'
import { useLatest, useMemoizedFn } from '../support/genericHooks'
import { useWorkspaceFilesChangedRefresh } from '../support/useWorkspaceFilesChangedRefresh'

import { useWorkbenchController } from './useWorkbenchController'
import { useWorkbenchEditorNavigationState } from './useWorkbenchEditorNavigationState'
import { useWorkbenchGitChangeActions } from './useWorkbenchGitChangeActions'
import { useWorkbenchGitState } from './useWorkbenchGitState'
import { useWorkbenchMergeResolutionOffer } from './useWorkbenchMergeResolutionOffer'
import {
  readWorkbenchProjectSearchSeed,
  useWorkbenchProjectSearchPanel,
} from './useWorkbenchProjectSearchPanel'
import { useWorkbenchProjectSessionPersistence } from './useWorkbenchProjectSessionPersistence'
import { useWorkbenchTopRunControl } from './useWorkbenchTopRunControl'

const LIGHT_FILE_PREVIEW_MAX_CHARS = 300_000
/** 「文件监听停了」提示的固定 id：同一时刻只挂一张，恢复或换项目时按 id 收起。 */
const WorkspaceWatchUnavailableNoticeId = 'workbench-workspace-watch-unavailable'
const WORKBENCH_NATIVE_AI_RULES_PATH = '.velar/rules.md'
const log = Log.tag('workbench-page')

export type PendingWorkbenchBrowserElementSelection = WorkbenchBrowserElementSelectionDelivery

/** 一次页面导航：去向（决定编辑区落在哪一组、左侧切到哪个面板）加上要放进编辑区的东西。 */
type WorkbenchNavigationRequest =
  | {
      target: 'file'
      path: string
      /** 给出时定位到这一行；不给只切到文件。 */
      line?: number
      column?: number
      /** 给出时选中 line:column 到 endLine:endColumn 这一段（项目搜索的一处匹配）。 */
      endLine?: number
      endColumn?: number
      /** 以预览标签打开（单击搜索结果）；不给就是普通标签。文件已经开着时只是切过去。 */
      preview?: boolean
    }
  | { target: 'file-preview'; tab: WorkbenchLightEditorTab }
  | { target: 'ai-changes'; round: WorkbenchChatRunChangesTarget }
  /** 打开项目搜索；给了 seed 就拿它当查找词。 */
  | { target: 'search'; seed?: string }

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
    encoding: file.encoding,
    eol: file.eol,
    textIssue: file.textIssue,
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
  const activeRoot = normalizeWorkbenchProjectRootPath(activeProjectRoot)

  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]
    if (!entry) continue

    const entryRoot = normalizeWorkbenchProjectRootPath(entry.rootPath ?? '')
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

export function useStandaloneWorkbenchPageModel(project: WorkbenchProject) {
  const translate = useStableWorkbenchMessageTranslate()
  const { locale, t } = translate
  const {
    config: { defaultEditor, git: globalGitConfig },
  } = useWorkbenchProductRuntime()
  const sessionCursorByPathRef = useRef<Record<string, PersistedWorkbenchEditorCursor>>({})
  const workbenchPreferences = useWorkbenchPreferences()
  const workbench = useWorkbenchController({
    project,
    previewTabsEnabled: workbenchPreferences.preferences.editorPreviewTabs,
    sessionCursorByPathRef,
  })
  const chat = useWorkbenchChatProjectRuntime(toNullable(workbench.activeProject?.rootPath))
  const { currentSession, sessions } = chat
  const surface = useWorkbenchSurfaceState()
  const layout = useWorkbenchLayoutController({
    commandPanelOpen: !surface.isCommandPanelCollapsed,
    rightToolOpen: surface.isRightToolOpen,
  })
  const projectGitSettings = useWorkbenchProjectGitSettings(workbench.activeProject?.rootPath)
  const projectRunSettings = useWorkbenchProjectRunSettings(workbench.activeProject?.rootPath)
  // 用户建的运行配置（按项目存在应用里）与「编辑运行配置」对话框的开关。
  const namedRunConfigurations = useWorkbenchNamedRunConfigurations(workbench.activeProject?.id)
  const [runConfigurationsOpen, setRunConfigurationsOpen] = useState(false)
  const workbenchKeymap = useWorkbenchKeymapController()
  const [settingsOpen, setSettingsOpen] = useState(false)
  // ⌘W / Ctrl+W 菜单命令的序号：编辑区看到它变了就关掉当前那个标签（它才知道哪个标签在前台）。
  const [closeActiveEditorTabRequestId, setCloseActiveEditorTabRequestId] = useState(0)
  const [velarLogicGraphOpen, setVelarLogicGraphOpen] = useState(false)
  const [velarLogicGraphActive, setVelarLogicGraphActive] = useState(false)
  const [pendingBrowserElementSelections, setPendingBrowserElementSelections] = useState<
    PendingWorkbenchBrowserElementSelection[]
  >([])
  const [pendingChatFileReferences, setPendingChatFileReferences] = useState<
    WorkbenchChatFileReferenceDelivery[]
  >([])
  const chatFileReferenceDeliverySeqRef = useRef(0)

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
  // 编辑区里起的运行（测试的 ▶）：先把没存的改动存盘——运行器读的是磁盘上的文件——再起运行卡。
  const launchRunSessionFromEditor = useMemoizedFn(
    async (...launch: Parameters<typeof workbench.launchRunSession>): Promise<Nullable<string>> => {
      await workbench.saveAllOpenFiles()
      return workbench.launchRunSession(...launch)
    }
  )
  useEffect(() => {
    installWorkbenchRunSessionLauncher(launchRunSessionFromEditor)
    return () => installWorkbenchRunSessionLauncher(null)
  }, [launchRunSessionFromEditor])
  const topRunControl = useWorkbenchTopRunControl({
    commandHistory: workbench.commandHistory,
    runConfigurations: [...activePackageScriptRunConfigurations, ...workbench.runConfigurations],
    namedConfigurations: namedRunConfigurations.configurations,
    runningSessions: workbench.runSessions,
    configuredCommand: projectRunSettings.settings.command,
    configuredConfigurationId: projectRunSettings.settings.configurationId,
    lastLaunchedCommand: workbench.lastLaunchedCommand,
    onLaunchCommand: (command, label, launch) =>
      // 调试也先存盘：程序跑的是磁盘上的文件，断点的行号要与它对得上。
      void (launch?.debug ? launchRunSessionFromEditor : workbench.launchRunSession)(
        command,
        label,
        launch
      ),
    onRestartRunSession: (sessionId) => void workbench.restartRunSession(sessionId),
    onConfigureCommand: projectRunSettings.setCommand,
    onSelectConfiguration: projectRunSettings.setConfigurationId,
    onEditConfigurations: () => setRunConfigurationsOpen(true),
  })
  // 此刻有没有在调试、是不是停着：快捷键、命令面板、左下角的工具按钮都看它。
  const debugStatus = useSyncExternalStore(subscribeWorkbenchDebugStatus, getWorkbenchDebugStatus)
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
  const editorLayoutLatest = useLatest(workbench.editorLayout)
  const editorNavigation = useWorkbenchEditorNavigationState({
    gitChangeItems: gitState.changeItems,
    selectedFilePath: workbench.selectedFilePath,
    focusedGroupIndex: workbench.editorLayout.focusedGroup,
    resolveFileGroupIndex: (path, preferredGroupIndex) =>
      resolveWorkbenchEditorTabGroupIndex(editorLayoutLatest.current, path, preferredGroupIndex),
    onSelectFile: workbench.selectFile,
    // Git 对比、只读预览、网页调试这些标签只在左边那组里：用户打开或切到它们，全局动作就交给左边那组。
    onPrimaryGroupTabShown: () => workbench.focusEditorGroup(0),
  })
  // 要求把键盘焦点放进编辑区某一组的编辑器（⌘1 / ⌘2、把标签挪到另一组之后）：每要求一次 id 加一。
  const [editorGroupFocusRequest, setEditorGroupFocusRequest] = useState({ id: 0, groupIndex: 0 })

  /**
   * 把全局动作（保存、查找、跳行、状态栏……）交给编辑区的某一组：点进那一组、焦点落进去，或 ⌘1 / ⌘2。
   * 先记下现在的位置，后退能回到原来那一组。`takeKeyboardFocus` 时把键盘焦点也放进那一组的编辑器。
   */
  const focusEditorGroup = useMemoizedFn(
    (groupIndex: number, options: { takeKeyboardFocus?: boolean } = {}): void => {
      const layout = editorLayoutLatest.current
      if (!layout.groups[groupIndex]) return
      if (groupIndex !== layout.focusedGroup) {
        editorNavigation.recordNavigationPoint()
        workbench.focusEditorGroup(groupIndex)
      }
      if (options.takeKeyboardFocus)
        setEditorGroupFocusRequest((request) => ({ id: request.id + 1, groupIndex }))
    }
  )

  // 一组关空、收掉了（关掉了它的最后一个标签）：键盘焦点原来在那一组里的话，交给留下来的那一组。
  const editorGroupCount = workbench.editorLayout.groups.length
  const previousEditorGroupCountRef = useRef(editorGroupCount)
  useEffect(() => {
    const previousCount = previousEditorGroupCountRef.current
    previousEditorGroupCountRef.current = editorGroupCount
    if (editorGroupCount >= previousCount || document.activeElement !== document.body) return
    setEditorGroupFocusRequest((request) => ({
      id: request.id + 1,
      groupIndex: editorLayoutLatest.current.focusedGroup,
    }))
  }, [editorGroupCount, editorLayoutLatest])

  /**
   * 把标签挪到另一组并切过去（标签右键「拆分并右移」/「移到另一侧」、拖到另一组上）：右边那组还不存在就
   * 新开出来；键盘焦点跟着标签走。落在左边那组时，盖在那组编辑器上的 Git 对比、只读预览让开——挪过去的
   * 标签就在眼前，与在那一组里打开文件一样。
   */
  const moveEditorTabToGroup = useMemoizedFn(
    (path: string, groupIndex: number, beforePath?: Nullable<string>): void => {
      const layout = workbench.moveOpenFileToGroup(path, groupIndex, beforePath)
      const landedIndex = findWorkbenchEditorGroupIndex(layout, path)
      if (landedIndex < 0) return
      if (landedIndex === 0) editorNavigation.uncoverPrimaryGroup()
      setEditorGroupFocusRequest((request) => ({ id: request.id + 1, groupIndex: landedIndex }))
    }
  )
  // Agent 浏览器：当前会话的浏览器进了站点就在编辑区开出（切到）它的标签，离站或换会话就收起。
  const agentBrowserSite = useWorkbenchAgentBrowserSite(
    toNullable(workbench.activeProject?.rootPath),
    currentSession.id
  )
  const agentBrowserBindingSessionId = agentBrowserSite ? currentSession.id : null
  const openAgentBrowserTab = editorNavigation.debug.agentBrowser.open
  const closeAgentBrowserTab = editorNavigation.debug.agentBrowser.close
  useEffect(() => {
    if (agentBrowserBindingSessionId) {
      openAgentBrowserTab(agentBrowserBindingSessionId)
      return
    }
    closeAgentBrowserTab()
  }, [agentBrowserBindingSessionId, closeAgentBrowserTab, openAgentBrowserTab])
  const recentFilePaths = useWorkbenchRecentFiles({
    projectId: toNullable(workbench.activeProject?.id),
    selectedFilePath: workbench.selectedFilePath,
    persist: true,
  })
  // 快速打开按文件名找文件用的整份清单：项目打开后空闲时先读好，快速打开开着时过期了就重读。
  const projectFiles = useWorkbenchProjectFileList({
    projectRoot: toNullable(workbench.activeProject?.rootPath),
    active: surface.isQuickOpenOpen,
  })
  useWorkbenchProjectSessionPersistence({
    enabled: workbench.projectSessionReady,
    projectId: toNullable(workbench.activeProject?.id),
    expandedPaths: workbench.expandedPaths,
    selectedEntryPath: workbench.selectedEntryPath,
    editorLayout: workbench.editorLayout,
    selectedFilePath: workbench.selectedFilePath,
    cursorPosition: editorNavigation.cursorPosition,
    cursorByPathRef: sessionCursorByPathRef,
  })

  const goToLocationLatest = useLatest(editorNavigation.goToLocation)
  useEffect(() => {
    const pending = workbench.pendingSessionNavigation
    const selectedFilePath = workbench.selectedFilePath
    if (!pending || !selectedFilePath) return

    // 恢复会话时回到上次的光标：当前文件是预览标签的话照旧是预览标签（普通打开会把它留下）。
    void goToLocationLatest
      .current(selectedFilePath, pending.line, pending.column, { preview: true })
      .finally(() => {
        workbench.clearPendingSessionNavigation()
      })
  }, [
    goToLocationLatest,
    workbench.clearPendingSessionNavigation,
    workbench.pendingSessionNavigation?.id,
    workbench.selectedFilePath,
  ])

  // 侧栏的项目搜索（⇧⌘F）：面板开关与表单跟着页面走；查找词与按文件名找共用。
  const projectSearch = useWorkbenchProjectSearchPanel({
    onQueryChange: workbench.setSearchQuery,
    onResetQuery: workbench.resetSearch,
  })
  /** 打开搜索结果里的一处匹配：经 `navigate` 打开文件并选中匹配。单击是预览标签，双击、回车是普通标签。 */
  const openProjectSearchMatch = useMemoizedFn(
    (
      path: string,
      match: WorkbenchContentSearchMatchResult,
      intent?: WorkbenchEditorOpenTabIntent
    ): void =>
      void navigate({
        target: 'file',
        path,
        line: match.line,
        column: match.column,
        endLine: match.endLine,
        endColumn: match.endColumn,
        preview: intent?.preview,
      })
  )
  const effectiveGitSshKeyPath =
    projectGitSettings.settings.gitSshKeyPath.trim() || globalGitConfig.privateKeyPath
  const shellStyle: CSSProperties = {
    ...layout.style,
    ...workbenchPreferences.style,
  }

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
    enabled: !settingsOpen,
    isQuickOpenOpen: surface.isQuickOpenOpen,
    keymap: workbenchKeymap.keymap,
    onCloseRightTool: surface.closeRightTool,
    onFindInFiles: () => void navigate({ target: 'search', seed: readProjectSearchSeed() }),
    onFocusEditorGroup: (groupIndex) => focusEditorGroup(groupIndex, { takeKeyboardFocus: true }),
    onSplitEditorRight: () => splitEditorRight(),
    onNavigateBack: () => void editorNavigation.goBack(),
    onNavigateForward: () => void editorNavigation.goForward(),
    onOpenQuickOpen: surface.openQuickOpen,
    onOpenCommandPalette: surface.openCommandPalette,
    onOpenSymbolOutline: surface.openSymbolOutline,
    onReopenClosedTab: () => void reopenClosedEditorTab(),
    onRunLastCommand: workbench.rerunLastCommand,
    onSaveAll: () => workbench.saveAllOpenFiles(),
    onSaveCurrent: () => workbench.saveSelectedFile(),
    onToggleBottomTool: toggleBottomTool,
    onToggleRightTool: surface.toggleRightTool,
  })
  useWorkbenchDebugShortcuts({
    enabled: !settingsOpen,
    keymap: workbenchKeymap.keymap,
  })
  useEffect(() => {
    document.title = project.name
  }, [project.name])

  // 鼠标侧键：后退键（按钮 3）、前进键（按钮 4）与快捷键一样走编辑区的后退 / 前进。
  const navigateBackLatest = useLatest(editorNavigation.goBack)
  const navigateForwardLatest = useLatest(editorNavigation.goForward)
  useEffect(() => {
    const handleMouseUp = (event: MouseEvent): void => {
      if (event.button !== 3 && event.button !== 4) return
      event.preventDefault()
      void (event.button === 3 ? navigateBackLatest : navigateForwardLatest).current()
    }
    window.addEventListener('mouseup', handleMouseUp)
    return () => window.removeEventListener('mouseup', handleMouseUp)
  }, [navigateBackLatest, navigateForwardLatest])

  const zoomEditor = useMemoizedFn((action: WorkbenchEditorZoomAction): void => {
    workbenchPreferences.updatePreferences({
      editorZoomLevel: getZoomedWorkbenchEditorZoomLevel(
        workbenchPreferences.preferences.editorZoomLevel,
        action
      ),
    })
  })

  // 关窗与退出前的确认：这个窗口有没有未保存的改动随时报给主进程（macOS 顺带标在关闭按钮上）；
  // 主进程拦下关闭时交回这里，先存能存的，存不下的再问用户，答复送回去由主进程放行或作罢。
  const { hasUnsavedOpenTabs, confirmWindowClose } = workbench
  useEffect(() => {
    window.velarosWorkbenchWindowClose.setUnsavedChanges(hasUnsavedOpenTabs)
  }, [hasUnsavedOpenTabs])

  useEffect(() => {
    const unsubscribe = window.velarosWorkbenchWindowClose.onCloseRequested((request) => {
      void confirmWindowClose(request.reason)
        .catch((error: unknown) => {
          log.error('关窗前确认未保存改动失败', { error })
          return false
        })
        .then((proceed) => {
          window.velarosWorkbenchWindowClose.resolveCloseRequest({ id: request.id, proceed })
        })
    })
    return () => {
      unsubscribe()
      window.velarosWorkbenchWindowClose.setUnsavedChanges(false)
    }
  }, [confirmWindowClose])

  useEffect(
    () =>
      window.velarosWorkbenchProjectHub.onMenuCommand((command) => {
        switch (command) {
          case 'close-editor': {
            // 设置页盖在编辑区上时不去关背后看不见的标签。
            if (!settingsOpen) setCloseActiveEditorTabRequestId((requestId) => requestId + 1)
            return
          }
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
      }),
    [exitCurrentProject, settingsOpen, zoomEditor]
  )
  const workspaceFileRefreshInFlightRef = useRef(false)
  const workspaceFileRefreshQueuedRef = useRef(false)

  const gitChangeActions = useWorkbenchGitChangeActions({
    workspaceRoot: workbench.activeProject?.rootPath ?? '',
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
  // 冲突文件在编辑器里解决完、存了盘：问一句要不要标记为已解决。
  useWorkbenchMergeResolutionOffer({
    workspaceRoot: toNullable(workbench.activeProject?.rootPath),
    changeItems: gitState.changeItems,
    openTabs: workbench.openTabs,
    onResolved: refreshGitPanelWithWorkspace,
    translate,
  })

  // 文件树按磁盘事件刷新，一次只跑一轮；正在刷新时又来了事件就记下来，读完紧接着再刷一轮——
  // 丢掉的话 Agent 连着新建的第二个文件在树里一直不出现。
  const runWorkspaceFileRefresh = useMemoizedFn(async (): Promise<void> => {
    if (workspaceFileRefreshInFlightRef.current) {
      workspaceFileRefreshQueuedRef.current = true
      return
    }
    workspaceFileRefreshInFlightRef.current = true
    try {
      await workbench.refreshLoadedDirectories()
    } finally {
      workspaceFileRefreshInFlightRef.current = false
    }
    if (!workspaceFileRefreshQueuedRef.current) return
    workspaceFileRefreshQueuedRef.current = false
    await runWorkspaceFileRefresh()
  })

  // 文件监听停了（起不来、出错后还没恢复）：一直挂着提示，恢复了或换了项目再收起。恢复时主进程补发
  // 一次整个根目录的变更，文件树、打开的文件、Git 状态会各自重读。
  const showWorkspaceWatchStatus = useMemoizedFn((status: WorkbenchWatchStatus): void => {
    const message = translate.messageLatest.current
    if (status.state === 'watching') {
      message.dismiss(WorkspaceWatchUnavailableNoticeId)
      return
    }

    message.warning({
      id: WorkspaceWatchUnavailableNoticeId,
      title: translate.tLatest.current('workbench.fileWatchUnavailableTitle'),
      description: translate.tLatest.current('workbench.fileWatchUnavailableDescription', {
        reason: status.message ?? '',
      }),
      duration: Number.POSITIVE_INFINITY,
    })
  })
  const watchedProjectRoot = workbench.activeProject?.rootPath
  useEffect(
    () => () => translate.messageLatest.current.dismiss(WorkspaceWatchUnavailableNoticeId),
    [translate.messageLatest, watchedProjectRoot]
  )

  useWorkspaceFilesChangedRefresh({
    rootPath: workbench.activeProject?.rootPath,
    enabled: !!workbench.activeProject,
    onChanged: runWorkspaceFileRefresh,
    onWatchStatus: showWorkspaceWatchStatus,
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
        if (request.line === undefined)
          await editorNavigation.selectFile(request.path, { preview: request.preview })
        else
          await editorNavigation.goToLocation(request.path, request.line, request.column, {
            endLine: request.endLine,
            endColumn: request.endColumn,
            preview: request.preview,
          })
        // 文件树平时跟着编辑器的当前文件自己定位（见 useWorkbenchController），但文件本来就是当前文件时
        // 当前文件不变、那边不会动；导航是「把它带到眼前」，左侧也要定位到它。
        await workbench.revealEntryPath(request.path, { quiet: true })
        return
      case 'file-preview':
        editorNavigation.openLightTab(request.tab)
        return
      case 'ai-changes':
        await aiChanges.openRound(request.round)
        return
      case 'search':
        projectSearch.openPanel(request.seed)
    }
  })

  // 调试停下时：把程序停在的位置带到眼前（还没开着的文件开成预览标签，已经开着的在它所在的那组里切过去），
  // 并打开底部的调试面板。
  const openBottomToolLatest = useLatest(surface.openBottomTool)
  useEffect(() => {
    installWorkbenchDebugPageHooks({
      revealLocation: (location) => void navigate({ target: 'file', ...location, preview: true }),
      openPanel: () => openBottomToolLatest.current('debug'),
    })
    return () => installWorkbenchDebugPageHooks(null)
  }, [navigate, openBottomToolLatest])

  /**
   * 快速打开里选中的文件：给了位置跳到那里；没给就回到上次在这个文件里的光标（没有记录是开头）。
   * 都按「跳到位置」走，焦点随之落进编辑器，回车之后接着就能敲。
   */
  const openQuickOpenFile = useMemoizedFn(
    async (path: string, position?: { line: number; column?: number }): Promise<void> => {
      const cursor = position ?? sessionCursorByPathRef.current[path] ?? { line: 1, column: 1 }
      await navigate({ target: 'file', path, line: cursor.line, column: cursor.column })
    }
  )

  /**
   * 当前文件的编辑器前面盖着别的，看到的不是它：结构图、AI 改动占着整个编辑区；Git 对比、只读预览、
   * 调试页只盖在左边那组上，当前组是右边那组时不算。
   */
  const editorCovered =
    aiChanges.active ||
    velarLogicGraphActive ||
    (workbench.editorLayout.focusedGroup === 0 &&
      (!!editorNavigation.diffItem ||
        !!editorNavigation.lightTab ||
        !!editorNavigation.debug.activeTabId))

  /** ⌘\ / Ctrl+\：把当前标签挪到右边那组（没有就新开）；已经在右边、或眼前不是它的编辑器时什么也不做。 */
  const splitEditorRight = useMemoizedFn((): void => {
    const path = workbench.selectedFilePath
    if (path && !editorCovered) moveEditorTabToGroup(path, 1)
  })

  /**
   * ⇧⌘F 的查找词：眼前是当前文件的编辑器、里面选中了一行以内的文字时才有（被别的盖住时选区看不见，不取）。
   * 焦点已经在搜索表单里（再按一次 ⇧⌘F）时也不取：只把焦点交回查找框，不拿编辑器的选区盖掉正在输入的查找词。
   */
  function readProjectSearchSeed(): string | undefined {
    if (document.activeElement?.closest('[data-project-search-form]')) return undefined
    if (!workbench.selectedFilePath || editorCovered) return undefined
    return readWorkbenchProjectSearchSeed(
      workbench.editorContent,
      editorNavigation.cursorPosition.selection
    )
  }

  /** 重新打开最近关掉的文件标签；记得上次的光标位置就回到那里。 */
  const reopenClosedEditorTab = useMemoizedFn(async (): Promise<void> => {
    const path = workbench.takeRecentlyClosedTabPath()
    if (!path) return

    const cursor = toNullable(sessionCursorByPathRef.current[path])
    await navigate(
      cursor
        ? { target: 'file', path, line: cursor.line, column: cursor.column }
        : { target: 'file', path }
    )
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

  /** 保存轻量预览标签里的文件；返回存下了没有（存不了的、写盘失败的是 false）。 */
  async function saveEmbeddedLightTab(): Promise<boolean> {
    const tab = editorNavigation.lightTab
    if (!tab || tab.truncated || tab.textIssue) return false

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
      return true
    } catch (error) {
      const appError = AppError.from(error)
      translate.messageLatest.current.error({
        title: translate.tLatest.current('workbench.saveFileFailed'),
        description: appError.message,
      })
      return false
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

    const entryRoot = normalizeWorkbenchProjectRootPath(entry.rootPath ?? '')
    const activeRoot = normalizeWorkbenchProjectRootPath(activeProject.rootPath)

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
  /** 文件树右键「在访达中显示」：打不开时说明原因。 */
  const revealPathInSystem = useCallback(
    (absolutePath: string): void => {
      void window.velarosWorkbenchProjectHub
        .revealSystemPath(absolutePath)
        .catch((error: unknown) => ({
          opened: false,
          error: error instanceof Error ? error.message : String(error),
        }))
        .then((result) => {
          if (result.opened) return
          translate.messageLatest.current.error({
            title: translate.tLatest.current('workbench.revealInSystemFailed'),
            description: result.error,
          })
        })
    },
    [translate.messageLatest, translate.tLatest]
  )
  /**
   * 右键「添加到聊天」：把文件作为引用挂到聊天输入框上——只挂路径，内容由 Agent 自己去读。聊天面板收着就
   * 打开它；已经开着的留在用户正在用的那个聊天里，不替他换 Agent。
   */
  const addWorkbenchFilesToChat = useCallback(
    (paths: readonly string[]): void => {
      const incoming = paths.filter((path) => !!path.trim())
      if (incoming.length === 0) return
      setPendingChatFileReferences((current) => [
        ...current,
        ...incoming
          .filter(
            (path) =>
              !current.some(
                (delivery) =>
                  delivery.path === path && delivery.targetSessionId === currentSession.id
              )
          )
          .map((path) => {
            chatFileReferenceDeliverySeqRef.current += 1
            return {
              deliveryId: `file-reference-${chatFileReferenceDeliverySeqRef.current}`,
              targetSessionId: currentSession.id,
              path,
            }
          }),
      ])
      if (!surface.activeRightTool) surface.openRightTool('chat')
    },
    [currentSession.id, surface.activeRightTool, surface.openRightTool]
  )
  const consumeWorkbenchChatFileReferences = useCallback((deliveryIds: readonly string[]): void => {
    const consumed = new Set(deliveryIds)
    setPendingChatFileReferences((current) =>
      current.filter((item) => !consumed.has(item.deliveryId))
    )
  }, [])

  function toggleBottomTool(tool: Parameters<typeof surface.openBottomTool>[0]): void {
    if (surface.activeBottomTool === tool && !surface.isCommandPanelCollapsed) {
      surface.toggleCommandPanelCollapsed()
      return
    }

    surface.openBottomTool(tool)
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

  // 命令面板（⇧⌘P）：各条命令接到上面这些已有的动作上。
  const commandPalette = useWorkbenchCommandPalette({
    workbench,
    surface,
    editorCovered,
    editorIndentation: editorNavigation.indentation,
    closeActiveEditor: () => setCloseActiveEditorTabRequestId((requestId) => requestId + 1),
    exitCurrentProject,
    findInFiles: () => void navigate({ target: 'search', seed: readProjectSearchSeed() }),
    focusEditorGroup: (groupIndex) => focusEditorGroup(groupIndex, { takeKeyboardFocus: true }),
    splitEditorRight,
    navigateBack: editorNavigation.goBack,
    navigateForward: editorNavigation.goForward,
    openSettings: () => setSettingsOpen(true),
    editRunConfigurations: () => setRunConfigurationsOpen(true),
    debugStatus,
    canDebugConfiguration: topRunControl.canDebugActiveConfiguration,
    debugConfiguration: topRunControl.debug,
    reopenClosedEditorTab,
    runEditorCommand: editorNavigation.requestEditorCommand,
    showEditorSurface,
    toggleBottomTool,
    zoomEditor,
  })

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
    /** 此刻有没有在调试、是不是停着。 */
    debugStatus,
    /** 当前项目里用户建的运行配置。 */
    namedRunConfigurations,
    editorNavigation,
    /** ⌘W / Ctrl+W 的请求序号：变了就关掉编辑区当前的标签。 */
    closeActiveEditorTabRequestId,
    /** 要求把键盘焦点放进编辑区的哪一组（⌘1 / ⌘2、标签挪到另一组之后）。 */
    editorGroupFocusRequest,
    /** 当前会话的 Agent 浏览器此刻进的站点；没进为 null。 */
    agentBrowser: { sessionId: currentSession.id, site: agentBrowserSite },
    pendingBrowserElementSelections,
    pendingChatFileReferences,
    aiChanges,
    gitChangeActions,
    /** 当前项目最近打开过的文件，最近的在前（快速打开用）。 */
    recentFilePaths,
    /** 当前项目的整份文件清单（快速打开用）。 */
    projectFiles,
    /** 命令面板里各条命令此刻能不能跑、怎么跑。 */
    commandPalette,
    /** 侧栏的项目搜索与替换。 */
    projectSearch,
    /** 页面 chrome / i18n / 派生展示值。 */
    chrome: {
      translate,
      locale,
      t,
      effectiveGitSshKeyPath,
      shellStyle,
      velarLogicGraphAvailable,
      macTitleInset,
      hostPlatform,
      commandStatusLabel,
    },
    /** 对话框 / 浮层开关状态。 */
    dialogs: {
      settingsOpen,
      setSettingsOpen,
      runConfigurationsOpen,
      setRunConfigurationsOpen,
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
      openQuickOpenFile,
      openProjectSearchMatch,
      focusEditorGroup,
      moveEditorTabToGroup,
      showEditorSurface,
      handleWorkbenchChatWorkspacePathOpen: openChatWorkspacePath,
      handleWorkbenchBrowserElementPicked,
      consumeWorkbenchBrowserElementSelections,
      addWorkbenchFilesToChat,
      revealPathInSystem,
      consumeWorkbenchChatFileReferences,
      saveEmbeddedLightTab,
      toggleBottomTool,
      createProjectAiRulesFile,
      exitCurrentProject,
    },
  }
}

export type StandaloneWorkbenchPageModel = ReturnType<typeof useStandaloneWorkbenchPageModel>
