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
} from '@renderer/composition'
import { useWorkbenchAiChangeArchive } from '@renderer/hooks/useWorkbenchAiChangeArchive'
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
import { resolveWorkbenchChatWorkspacePath } from '@renderer/models/chat/workbenchChatWorkspacePath'
import { getWorkbenchCommandStatusLabel } from '@renderer/models/commands/workbenchCommandStatusModel'
import { inferPackageManagerCommand } from '@renderer/models/commands/workbenchCommandSuggestions'
import { inferWorkbenchPackageManagerForPackageJsonPath } from '@renderer/models/commands/workbenchPackageScriptCommand'
import {
  buildWorkbenchEditorAnimationPlan,
  buildWorkbenchEditorDeleteFrame,
  buildWorkbenchEditorTypeFrame,
  type WorkbenchEditorAutomationState,
} from '@renderer/models/editor/workbenchEditorAutomation'
import { buildWorkbenchPackageScriptRunActions } from '@renderer/models/editor/workbenchPackageScriptRunGutter'
import { resolveWorkbenchGitSurfacesActive } from '@renderer/models/git/workbenchGitSurfaceActivation'
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
  getZoomedWorkbenchEditorFontSize,
  type WorkbenchEditorZoomAction,
} from '@renderer/models/settings/workbenchPreferences'
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
  WorkbenchEditorCommand,
  WorkbenchEditorCommandEvent,
  WorkbenchReadFileResult,
} from '@shared/contracts'

import { useStableWorkbenchMessageTranslate } from '../runtime/useStableWorkbenchMessaging'
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

function normalizeWorkspaceRoot(root: LooseOptional<string>): string {
  return (root ?? '').replace(/[\\/]+$/, '')
}

type WorkbenchEditorWriteCommand = Extract<WorkbenchEditorCommand, { action: 'replace' | 'write' }>

function getWorkbenchEditorCommandPath(command: WorkbenchEditorCommand): Nullable<string> {
  switch (command.action) {
    case 'open':
    case 'reveal':
    case 'close':
    case 'delete':
    case 'write':
    case 'replace':
      return command.path
    case 'move':
      return command.toPath
    default:
      return null
  }
}

function resolveWorkbenchAutomatedEditContent(
  command: WorkbenchEditorWriteCommand,
  before: string
): string {
  if (command.action === 'write') return command.content
  if (!before.includes(command.oldText)) {
    throw new AppError('CONFLICT', '要替换的旧代码与编辑器当前内容不一致。')
  }

  return command.replaceAll
    ? before.split(command.oldText).join(command.newText)
    : before.replace(command.oldText, command.newText)
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
  const workbench = useWorkbenchController({
    bootstrapProjects,
    lockedProjectId,
    persistProjectList: shouldPersistProjectList,
    persistProjectSession: shouldUseProjectSession,
    restoreProjectSession: shouldUseProjectSession,
    projectIndexEnabled: codeGraphResourceAvailable,
    sessionCursorByPathRef,
  })
  const chat = useWorkbenchChatProjectRuntime(toNullable(workbench.activeProject?.rootPath))
  const { currentSession, conversationVersion, sessions } = chat
  const agentBrowser = useControlledBrowserSurface({
    sessionId: currentSession.id,
    workspaceRefreshKey: currentSession.workspaceVersion + conversationVersion,
    activationToken: chat.browserActivationToken,
  })
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
  const [pendingBrowserElementSelections, setPendingBrowserElementSelections] = useState<
    PendingWorkbenchBrowserElementSelection[]
  >([])
  const [aiIndexDecisionVersion, setAiIndexDecisionVersion] = useState(0)
  const [workbenchEditorAutomation, setWorkbenchEditorAutomation] =
    useState<Nullable<WorkbenchEditorAutomationState>>(null)
  const workbenchEditorAutomationAbortRef = useRef<Nullable<AbortController>>(null)
  const workbenchEditorAutomationRollbackRef = useRef<Nullable<() => void>>(null)
  const automationTimers = useTimerScope('WorkbenchEditorAutomation')

  const exitCurrentProject = useMemoizedFn(async (): Promise<boolean> => {
    if (!workbench.closeProject()) return false

    setSettingsOpen(false)
    await window.velarosWorkbenchProjectHub.closeProject()
    return true
  })

  useEffect(() => {
    if (codeGraphResourceAvailable) return
    setAiIndexPromptOpen(false)
    setAiIndexDetailsOpen(false)
    setCodeGraphOpen(false)
  }, [codeGraphResourceAvailable])

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
    gitChangeItems: gitState.changeItems,
    selectedFilePath: workbench.selectedFilePath,
    onSelectFile: workbench.selectFile,
  })
  const updateWorkbenchEditorAutomation = useMemoizedFn(
    (
      commandId: string,
      patch: Partial<Pick<WorkbenchEditorAutomationState, 'phase' | 'progress'>>
    ): void => {
      setWorkbenchEditorAutomation((current) =>
        current?.commandId === commandId ? { ...current, ...patch } : current
      )
    }
  )

  const playWorkbenchAutomatedEdit = useMemoizedFn(
    async (
      event: WorkbenchEditorCommandEvent,
      command: WorkbenchEditorWriteCommand,
      signal: AbortSignal
    ): Promise<Record<string, unknown>> => {
      const activeProject = workbench.activeProject
      if (!activeProject) throw new AppError('NOT_FOUND', '当前没有打开的 Workbench 项目。')
      const openTab = workbench.openTabs.find((candidate) => candidate.path === command.path)
      if (openTab && openTab.content !== openTab.file.content) {
        throw new AppError('CONFLICT', '目标文件包含未保存内容，无法开始自动写入。')
      }

      const file = Result.unwrap(
        await workbenchHost.kernel.project.readWorkbenchFile({
          projectRoot: activeProject.rootPath,
          path: command.path,
          maxChars: 1_500_000,
        })
      )
      if (file.truncated) {
        throw new AppError('VALIDATION', '文件过大，Workbench 不会对截断内容播放自动写入。')
      }

      const targetContent = resolveWorkbenchAutomatedEditContent(command, file.content)
      if (targetContent === file.content)
        return { path: command.path, changed: false, charactersWritten: 0 }

      await editorNavigation.selectFile(command.path)
      signal.throwIfAborted()
      workbench.setAutomatedPreviewActive(true)
      const rollback = (): void => workbench.setEditorContent(file.content)
      workbenchEditorAutomationRollbackRef.current = rollback
      const plan = buildWorkbenchEditorAnimationPlan(file.content, targetContent)

      if (plan.deleteFrameCount > 0) {
        updateWorkbenchEditorAutomation(event.commandId, { phase: 'deleting', progress: 0.12 })
        for (let frame = 1; frame <= plan.deleteFrameCount; frame += 1) {
          signal.throwIfAborted()
          workbench.setEditorContent(buildWorkbenchEditorDeleteFrame(plan, frame))
          updateWorkbenchEditorAutomation(event.commandId, {
            progress: 0.12 + (frame / plan.deleteFrameCount) * 0.18,
          })
          await automationTimers.sleep(18, { signal, label: 'automation.delete-frame' })
        }
      }

      updateWorkbenchEditorAutomation(event.commandId, { phase: 'typing', progress: 0.3 })
      for (let frame = 1; frame <= Math.max(1, plan.typeFrameCount); frame += 1) {
        signal.throwIfAborted()
        workbench.setEditorContent(buildWorkbenchEditorTypeFrame(plan, frame))
        updateWorkbenchEditorAutomation(event.commandId, {
          progress: 0.3 + (frame / Math.max(1, plan.typeFrameCount)) * 0.58,
        })
        await automationTimers.sleep(20, { signal, label: 'automation.type-frame' })
      }

      signal.throwIfAborted()
      updateWorkbenchEditorAutomation(event.commandId, { phase: 'saving', progress: 0.92 })
      const saved = Result.unwrap(
        await workbenchHost.kernel.project.saveWorkbenchFile({
          projectRoot: activeProject.rootPath,
          path: command.path,
          content: targetContent,
          expectedModifiedAt: file.modifiedAt,
          expectedSize: file.size,
        })
      )
      workbenchEditorAutomationRollbackRef.current = null
      await workbench.reloadSelectedFileFromDisk()
      await workbench.refreshLoadedDirectories()
      updateWorkbenchEditorAutomation(event.commandId, { phase: 'finishing', progress: 1 })
      return {
        path: saved.path,
        changed: true,
        charactersWritten: plan.afterMiddle.length,
      }
    }
  )

  const exitWorkbenchEditorAutomation = useMemoizedFn((): void => {
    const rollback = workbenchEditorAutomationRollbackRef.current
    workbenchEditorAutomationRollbackRef.current = null
    rollback?.()
    workbenchEditorAutomationAbortRef.current?.abort(
      new AppError('CONFLICT', '用户已退出 Workbench AI 接管。')
    )
    workbenchEditorAutomationAbortRef.current = null
    workbench.setAutomatedPreviewActive(false)
    setWorkbenchEditorAutomation(null)
  })

  const handleWorkbenchEditorCommand = useMemoizedFn(
    async (event: WorkbenchEditorCommandEvent): Promise<void> => {
      const controller = new AbortController()
      workbenchEditorAutomationAbortRef.current?.abort()
      workbenchEditorAutomationAbortRef.current = controller
      setWorkbenchEditorAutomation({
        commandId: event.commandId,
        action: event.command.action,
        path: getWorkbenchEditorCommandPath(event.command),
        phase: 'preparing',
        progress: 0.04,
      })

      try {
        const activeProject = workbench.activeProject
        if (!activeProject) throw new AppError('NOT_FOUND', '当前没有打开的 Workbench 项目。')
        if (
          normalizeWorkspaceRoot(activeProject.rootPath) !==
          normalizeWorkspaceRoot(event.projectRoot)
        ) {
          throw new AppError('CONFLICT', 'AI 命令所属项目与当前 Workbench 项目不一致。')
        }
        if (event.sessionId !== currentSession.id) {
          throw new AppError('CONFLICT', 'AI 命令所属会话已不是当前 Workbench 会话。')
        }

        await automationTimers.sleep(140, {
          signal: controller.signal,
          label: 'automation.enter',
        })
        const command = event.command
        let data: Record<string, unknown> | undefined
        switch (command.action) {
          case 'search':
            surface.setActiveLeftTool('project')
            workbench.setSearchQuery(command.query)
            data = { query: command.query }
            break
          case 'open':
            if (command.line) {
              await editorNavigation.goToLocation(command.path, command.line, command.column)
            } else {
              await editorNavigation.selectFile(command.path)
            }
            data = { path: command.path, line: command.line, column: command.column }
            break
          case 'reveal':
            surface.setActiveLeftTool('project')
            await workbench.revealEntryPath(command.path)
            data = { path: command.path }
            break
          case 'close': {
            const tab = workbench.openTabs.find((candidate) => candidate.path === command.path)
            if (tab && tab.content !== tab.file.content) {
              throw new AppError('CONFLICT', '文件包含未保存内容，Workbench 已拒绝关闭。')
            }
            workbench.closeOpenFile(command.path)
            data = { path: command.path, wasOpen: !!tab }
            break
          }
          case 'refresh':
            await workbench.refreshLoadedDirectories()
            data = { refreshed: true }
            break
          case 'move': {
            const result = await workbench.moveEntryByPath(command.fromPath, command.toPath)
            data = { previousPath: result.previousPath, path: result.entry.path }
            break
          }
          case 'delete': {
            const result = await workbench.deleteEntryByPath(command.path)
            data = { path: result.deletedPath, restoreId: result.restoreId }
            break
          }
          case 'write':
          case 'replace':
            data = await playWorkbenchAutomatedEdit(event, command, controller.signal)
            break
        }

        updateWorkbenchEditorAutomation(event.commandId, { phase: 'finishing', progress: 1 })
        await workbenchHost.kernel.project.acknowledgeWorkbenchEditorCommand({
          commandId: event.commandId,
          success: true,
          message: `Workbench 编辑器已完成 ${command.action} 命令。`,
          data,
        })
      } catch (error) {
        workbenchEditorAutomationRollbackRef.current?.()
        workbenchEditorAutomationRollbackRef.current = null
        const appError = AppError.from(error)
        log.warn('Workbench AI 编辑器命令执行失败', {
          commandId: event.commandId,
          action: event.command.action,
          error: appError,
        })
        await workbenchHost.kernel.project.acknowledgeWorkbenchEditorCommand({
          commandId: event.commandId,
          success: false,
          message: appError.message,
        })
      } finally {
        if (workbenchEditorAutomationAbortRef.current === controller) {
          workbenchEditorAutomationAbortRef.current = null
          workbenchEditorAutomationRollbackRef.current = null
          workbench.setAutomatedPreviewActive(false)
          setWorkbenchEditorAutomation(null)
        }
      }
    }
  )
  useEffect(
    () => workbenchHost.kernel.project.onWorkbenchEditorCommand(handleWorkbenchEditorCommand),
    [handleWorkbenchEditorCommand]
  )
  useEffect(
    () => () => {
      workbenchEditorAutomationAbortRef.current?.abort()
      workbenchEditorAutomationAbortRef.current = null
      workbenchEditorAutomationRollbackRef.current = null
    },
    []
  )
  useEffect(() => {
    if (!workbenchEditorAutomation) return undefined

    const blockAutomationKeydown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        exitWorkbenchEditorAutomation()
        return
      }

      const target = event.target
      if (target instanceof Element && target.closest('[data-workbench-automation-exit]')) return
      event.preventDefault()
      event.stopImmediatePropagation()
    }
    window.addEventListener('keydown', blockAutomationKeydown, true)
    return () => window.removeEventListener('keydown', blockAutomationKeydown, true)
  }, [exitWorkbenchEditorAutomation, workbenchEditorAutomation])
  const agentBrowserBindingSessionId = agentBrowser.active ? currentSession.id : null
  useEffect(() => {
    if (agentBrowserBindingSessionId) {
      editorNavigation.debug.agentBrowser.open(agentBrowserBindingSessionId)
      return
    }

    editorNavigation.debug.agentBrowser.close()
  }, [agentBrowser.activationToken, agentBrowserBindingSessionId])
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
    codeGraphResourceAvailable &&
    workbench.projectAiIndexStatus?.status === 'ready' &&
    !!workbench.projectAiIndexStatus?.codeIndex?.initialized

  /** `titleBarStyle: hiddenInset`: reserve horizontal inset for macOS traffic lights on the standalone window */
  const macTitleInset =
    /^Mac/i.test(navigator.platform) || /\bMac OS X\b/i.test(navigator.userAgent)

  useWorkbenchKeyboardShortcuts({
    activeRightTool: surface.activeRightTool,
    enabled:
      surfaceMode === 'standalone' &&
      !!workbench.activeProject &&
      !settingsOpen &&
      !workbenchEditorAutomation,
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
      editorFontSize: getZoomedWorkbenchEditorFontSize(
        workbenchPreferences.preferences.editorFontSize,
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
      !codeGraphResourceAvailable ||
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
    codeGraphResourceAvailable,
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
    onRefreshGit: gitState.refreshAfterAgentRun,
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
    await gitState.refreshGitPanel()
  }

  async function refreshProjectAndGit(): Promise<void> {
    await refreshProjectTree()
    await gitState.refreshAfterGitAction()
  }

  const isAiChangePathDirty = useMemoizedFn((path: string): boolean =>
    workbench.openTabs.some((tab) => tab.path === path && tab.content !== tab.file.content)
  )
  const refreshAfterAiChangeApply = useMemoizedFn(async (): Promise<void> => {
    await refreshProjectAndGit()
  })
  const aiChangeArchive = useWorkbenchAiChangeArchive({
    active: surfaceMode === 'standalone' && surface.activeLeftTool === 'ai-changes',
    projectRoot: workbench.activeProject?.rootPath,
    sessions,
    sessionGroups: chat.sessionList.archiveGroups,
    isPathDirty: isAiChangePathDirty,
    onFilesChanged: refreshAfterAiChangeApply,
    notify: (notification) =>
      translate.messageLatest.current[notification.tone]({
        title: notification.title,
        description: notification.description,
      }),
  })

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
      await gitState.refreshGitPanel()
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

  async function handleWorkbenchChatFileChangeOpen(
    entry: WorkbenchChatFileChangeEntry
  ): Promise<void> {
    const activeProject = workbench.activeProject
    if (!activeProject) return

    const entryRoot = normalizeWorkspaceRoot(entry.rootPath)
    const activeRoot = normalizeWorkspaceRoot(activeProject.rootPath)

    if (!entryRoot || entryRoot === activeRoot) {
      await editorNavigation.selectFile(entry.path)
      return
    }

    if (!entry.rootPath) return

    const previewTab = buildLightTabFromChangePreview(entry, entry.rootPath)
    if (previewTab) {
      editorNavigation.openLightTab(previewTab)
      return
    }

    try {
      const file = Result.unwrap(
        await workbenchHost.kernel.project.readWorkbenchFile({
          projectRoot: entry.rootPath,
          path: entry.path,
          maxChars: LIGHT_FILE_PREVIEW_MAX_CHARS,
        })
      )
      editorNavigation.openLightTab(buildLightTabFromReadFile(file))
    } catch (error) {
      const appError = AppError.from(error)
      translate.messageLatest.current.error({
        title: translate.tLatest.current('workbench.readFileFailed'),
        description: appError.message,
      })
    }
  }

  function handleWorkbenchChatFileChangeArchiveOpen(entry: WorkbenchChatFileChangeEntry): void {
    surface.setActiveLeftTool('ai-changes')
    aiChangeArchive.selectLinkedEntry({
      sessionId: currentSession.id,
      path: entry.path,
      changeIds: entry.changeIds,
    })
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

    const previewTab = buildLightTabFromChangePreview(
      entry,
      entry.rootPath ?? activeProject.rootPath
    )
    if (previewTab) {
      editorNavigation.openLightTab(previewTab)
      return
    }

    const projectRoot = entry.rootPath ?? activeProject.rootPath
    try {
      const file = Result.unwrap(
        await workbenchHost.kernel.project.readWorkbenchFile({
          projectRoot,
          path: entry.path,
          maxChars: LIGHT_FILE_PREVIEW_MAX_CHARS,
        })
      )
      editorNavigation.openLightTab(buildLightTabFromReadFile(file))
    } catch (error) {
      const appError = AppError.from(error)
      translate.messageLatest.current.error({
        title: translate.tLatest.current('workbench.readFileFailed'),
        description: appError.message,
      })
    }
  }

  async function handleWorkbenchChatWorkspacePathOpen(path: string): Promise<void> {
    const activeProject = workbench.activeProject
    if (!activeProject) return

    const relativePath = resolveWorkbenchChatWorkspacePath(path, activeProject.rootPath)
    if (!relativePath || relativePath === '.') return

    await editorNavigation.selectFile(relativePath)
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

    await workbench.selectFile(WORKBENCH_NATIVE_AI_RULES_PATH)
  }

  const commandStatusLabel = getWorkbenchCommandStatusLabel(
    {
      commandResult: workbench.commandResult,
      isRunningCommand: workbench.isRunningCommand,
      isValidationStale: workbench.isValidationStale,
    },
    t
  )

  return {
    workbench,
    surface,
    layout,
    projectGitSettings,
    workbenchPreferences,
    workbenchKeymap,
    gitState,
    topRunControl,
    editorNavigation,
    agentBrowser,
    pendingBrowserElementSelections,
    aiChangeArchive,
    chatChangePreview,
    gitChangeActions,
    automation: {
      state: workbenchEditorAutomation,
      exit: exitWorkbenchEditorAutomation,
    },
    /** 页面 chrome / i18n / 派生展示值。 */
    chrome: {
      lockedProjectId,
      translate,
      locale,
      t,
      globalGitConfig,
      contentSearchMatches: contentSearch.contentSearchMatches,
      isSearchingContent: contentSearch.isSearchingContent,
      contentSearchTruncated: contentSearch.contentSearchTruncated,
      effectiveGitSshKeyPath,
      shellStyle,
      projectAiIndexSkipped,
      codeGraphAvailable: codeGraphResourceAvailable,
      canOpenCodeGraph,
      macTitleInset,
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
    },
    /** 交互动作。 */
    actions: {
      runTreeMutation,
      refreshGitPanel: refreshGitPanelWithWorkspace,
      refreshProjectAndGit,
      handleRepositoryChanged,
      initializeRepository,
      handleWorkbenchChatFileChangeOpen,
      handleWorkbenchChatFileChangeArchiveOpen,
      handleWorkbenchChatFileChangesReview,
      handleWorkbenchChatWorkspacePathOpen,
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
