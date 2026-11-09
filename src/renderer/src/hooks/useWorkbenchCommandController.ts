import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useWorkbenchCommandIpcSubscriptions } from '@renderer/hooks/workbenchCommand/useWorkbenchCommandIpcSubscriptions'
import { useWorkbenchCommandPackageSuggestions } from '@renderer/hooks/workbenchCommand/useWorkbenchCommandPackageSuggestions'
import { useWorkbenchCommandProjectBootstrap } from '@renderer/hooks/workbenchCommand/useWorkbenchCommandProjectBootstrap'
import { workbenchHost } from '@renderer/host/WorkbenchHost'
import {
  upsertWorkbenchCommandHistory,
  type WorkbenchCommandHistoryItem,
} from '@renderer/models/commands/workbenchCommandHistory'
import {
  createRunOutputLine,
  formatRunDuration,
  type WorkbenchRunOutputLine,
  type WorkbenchRunSessionLaunchOptions,
  type WorkbenchTerminalSessionView,
} from '@renderer/models/commands/workbenchCommandLines'
import type { WorkbenchCommandSuggestion } from '@renderer/models/commands/workbenchCommandSuggestions'
import { buildWorkbenchRunConfigurations } from '@renderer/models/commands/workbenchRunConfigurations'
import { publishWorkbenchRunSessionRestart } from '@renderer/models/commands/workbenchRunSessionBridge'
import { discardWorkbenchTerminalOutput } from '@renderer/models/commands/workbenchTerminalOutputBus'
import {
  buildWorkbenchTerminalSessionTitle,
  closeWorkbenchTerminalSessions,
  pickWorkbenchTerminalTitle,
} from '@renderer/models/commands/workbenchTerminalPresentation'
import { startWorkbenchDebugRunSession } from '@renderer/models/debug/workbenchDebugBridge'
import type { WorkbenchProject } from '@renderer/models/project/workbenchProjects'

import { isPresent, Log, toNullable } from '@velaros-ai/velaros/core'
import { AppError } from '@velaros-ai/velaros/core/error'
import { Result } from '@velaros-ai/velaros/core/result'

import {
  type WorkbenchDirectoryEntry,
  type WorkbenchRunCommandResult,
} from '@shared/contracts/workbench'

import { useStableWorkbenchMessageTranslate } from '../runtime/useStableWorkbenchMessaging'
import { useLatest, useMemoizedFn } from '../support/genericHooks'

export type {
  WorkbenchRunOutputLine,
  WorkbenchRunSessionLaunchOptions,
  WorkbenchTerminalSessionView,
} from '@renderer/models/commands/workbenchCommandLines'

interface UseWorkbenchCommandControllerOptions {
  activeProject: Nullable<WorkbenchProject>
  rootEntries: WorkbenchDirectoryEntry[]
}

interface WorkbenchCommandResourceOwner {
  projectId: Nullable<string>
  signal: AbortSignal
  sessionIds: Set<string>
  restarts: Map<string, AbortController>
}

const log = Log.tag('workbench-command-controller')

/** 回收只在真实退出后确认；失败仍保留在 owner 中，不能伪报资源已释放。 */
async function releaseCommandSession(
  owner: WorkbenchCommandResourceOwner,
  sessionId: string
): Promise<void> {
  try {
    Result.unwrap(
      await workbenchHost.kernel.project.stopWorkbenchTerminalSession({
        sessionId,
        waitForExit: true,
      })
    )
    owner.sessionIds.delete(sessionId)
    discardWorkbenchTerminalOutput(sessionId)
  } catch (error) {
    log.warn('回收终端会话失败', { sessionId, error: AppError.getMessage(error) })
  }
}

export function useWorkbenchCommandController({
  activeProject,
  rootEntries,
}: UseWorkbenchCommandControllerOptions) {
  const { messageLatest, tLatest } = useStableWorkbenchMessageTranslate()
  const [commandInput, setCommandInput] = useState('')
  const [commandResult, setCommandResult] = useState<Nullable<WorkbenchRunCommandResult>>(null)
  const [commandHistory, setCommandHistory] = useState<WorkbenchCommandHistoryItem[]>([])
  const [commandSuggestions, setCommandSuggestions] = useState<WorkbenchCommandSuggestion[]>([])
  const [isRunningCommand, setIsRunningCommand] = useState(false)
  const [activeRunId, setActiveRunId] = useState<Nullable<string>>(null)
  const activeRunIdRef = useLatest(activeRunId)
  const [isValidationStale, setIsValidationStale] = useState(false)
  const [runOutputLines, setRunOutputLines] = useState<WorkbenchRunOutputLine[]>([])
  const [terminalSessions, setTerminalSessions] = useState<WorkbenchTerminalSessionView[]>([])
  const [activeTerminalSessionId, setActiveTerminalSessionId] = useState<Nullable<string>>(null)
  const terminalSessionsRef = useLatest(terminalSessions)
  const [runSessions, setRunSessions] = useState<WorkbenchTerminalSessionView[]>([])
  const [activeRunSessionId, setActiveRunSessionId] = useState<Nullable<string>>(null)
  const [lastLaunchedCommand, setLastLaunchedCommand] = useState('')
  const runSessionsRef = useLatest(runSessions)
  const activeProjectRef = useLatest(activeProject)
  const resourceOwnerRef = useRef<Nullable<WorkbenchCommandResourceOwner>>(null)
  const activeProjectId = activeProject?.id ?? null
  const runConfigurations = useMemo(
    () =>
      buildWorkbenchRunConfigurations({
        suggestions: commandSuggestions,
        history: commandHistory,
      }),
    [commandHistory, commandSuggestions]
  )
  const rootEntrySignature = rootEntries
    .map((entry) => `${entry.type}:${entry.name}`)
    .sort()
    .join('\n')

  // 提交阶段撤销旧 owner，覆盖卸载到被动 effect 清理之间的迟到回执。
  useLayoutEffect(() => {
    const controller = new AbortController()
    const owner: WorkbenchCommandResourceOwner = {
      projectId: activeProjectId,
      signal: controller.signal,
      sessionIds: new Set(),
      restarts: new Map(),
    }
    resourceOwnerRef.current = owner
    return () => {
      controller.abort()
      for (const restart of owner.restarts.values()) restart.abort()
      if (resourceOwnerRef.current === owner) resourceOwnerRef.current = null
      for (const sessionId of owner.sessionIds) void releaseCommandSession(owner, sessionId)
    }
  }, [activeProjectId])

  const ownsCurrentProject = (owner: WorkbenchCommandResourceOwner): boolean =>
    !owner.signal.aborted && resourceOwnerRef.current === owner

  /** 关闭终端标签及其会话。 */
  const closeTerminalSessions = useMemoizedFn((sessionIds: readonly string[]): void => {
    const owner = resourceOwnerRef.current
    if (!owner || !ownsCurrentProject(owner)) return
    for (const sessionId of sessionIds) {
      void releaseCommandSession(owner, sessionId)
      discardWorkbenchTerminalOutput(sessionId)
    }
    setTerminalSessions((current) => {
      setActiveTerminalSessionId(
        (currentActive) =>
          closeWorkbenchTerminalSessions(current, currentActive, sessionIds).activeSessionId
      )
      return closeWorkbenchTerminalSessions(current, null, sessionIds).sessions
    })
  })

  /** 用户在终端里退出了 shell：是终端（不是运行卡）就把它关掉，返回 true。 */
  const closeExitedTerminalSession = useMemoizedFn((sessionId: string): boolean => {
    if (!terminalSessionsRef.current.some((session) => session.id === sessionId)) return false
    closeTerminalSessions([sessionId])
    return true
  })

  useWorkbenchCommandIpcSubscriptions(
    activeRunIdRef,
    setRunOutputLines,
    setTerminalSessions,
    setRunSessions,
    setIsRunningCommand,
    closeExitedTerminalSession
  )

  /** 从项目根目录创建终端标签。 */
  const createTerminalSessionForProject = useMemoizedFn(
    async (project: WorkbenchProject): Promise<void> => {
      const owningProject = project
      const owner = resourceOwnerRef.current
      if (!owner || owner.projectId !== owningProject.id || !ownsCurrentProject(owner)) return

      try {
        const result = Result.unwrap(
          await workbenchHost.kernel.project.startWorkbenchTerminalSession({
            projectRoot: owningProject.rootPath,
          })
        )

        owner.sessionIds.add(result.sessionId)
        if (!ownsCurrentProject(owner)) {
          await releaseCommandSession(owner, result.sessionId)
          return
        }

        const sessions = terminalSessionsRef.current
        const title = pickWorkbenchTerminalTitle(sessions, (sessionIndex) =>
          buildWorkbenchTerminalSessionTitle(sessionIndex, {
            local: tLatest.current('workbench.terminalLocalTab'),
            localIndexed: (index) =>
              tLatest.current('workbench.terminalLocalTabIndexed', { index }),
          })
        )
        const session: WorkbenchTerminalSessionView = {
          id: result.sessionId,
          title,
          shell: result.shell,
          cwd: result.cwd,
          isRunning: true,
        }

        setTerminalSessions((current) => [...current, session])
        setActiveTerminalSessionId(result.sessionId)
      } catch (error) {
        if (!ownsCurrentProject(owner)) return

        const appError = AppError.from(error)
        messageLatest.current.error({
          title: tLatest.current('workbench.terminalStartFailed'),
          description: appError.message,
        })
      }
    }
  )

  const createTerminalSession = useMemoizedFn(async (): Promise<void> => {
    const project = activeProjectRef.current
    if (project) {
      await createTerminalSessionForProject(project)
    }
  })

  useWorkbenchCommandProjectBootstrap({
    activeProjectId: activeProject?.id,
    activeProjectRef,
    setTerminalSessions,
    setActiveTerminalSessionId,
    setCommandHistory,
    setCommandInput,
    setCommandResult,
    setRunOutputLines,
    setCommandSuggestions,
    setIsRunningCommand,
    setActiveRunId,
    setIsValidationStale,
    createTerminalSession: createTerminalSessionForProject,
  })

  useWorkbenchCommandPackageSuggestions({
    activeProject,
    rootEntries,
    rootEntrySignature,
    activeProjectRef,
    setCommandSuggestions,
    setCommandInput,
  })

  const markValidationStale = useMemoizedFn((): void => {
    if (commandResult || commandHistory.length) {
      setIsValidationStale(true)
    }
  })

  const runCommand = useMemoizedFn(async (commandOverride?: string): Promise<void> => {
    const projectNow = activeProjectRef.current
    if (!projectNow || activeRunIdRef.current) return

    const command = (commandOverride ?? commandInput).trim()
    if (!command) {
      messageLatest.current.warning({
        title: tLatest.current('workbench.commandRequired'),
      })
      return
    }

    const owningProject = projectNow
    const owningProjectId = owningProject.id

    const runId = `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    setActiveRunId(runId)

    try {
      setCommandInput(command)
      setIsRunningCommand(true)
      setIsValidationStale(false)
      setCommandResult(null)
      setRunOutputLines([createRunOutputLine(runId, 'system', `$ ${command}\n`)])
      const result = Result.unwrap(
        await workbenchHost.kernel.project.runWorkbenchCommand({
          projectRoot: owningProject.rootPath,
          command,
          runId,
          timeoutMs: 60_000,
          maxOutputChars: 12_000,
        })
      )

      if (activeProjectRef.current?.id !== owningProjectId || activeRunIdRef.current !== runId)
        return

      setCommandResult(result)
      const resultFooter = [
        tLatest.current('workbench.commandExitCode', {
          code: result.exitCode ?? result.signal ?? '-',
        }),
        tLatest.current('workbench.commandDuration', {
          duration: formatRunDuration(result.durationMs),
        }),
        result.truncated ? tLatest.current('workbench.commandOutputTruncated') : null,
      ]
        .filter((item): item is string => !!item)
        .join(' · ')
      setRunOutputLines((current) =>
        [...current, createRunOutputLine(runId, 'system', `\n${resultFooter}\n`)].slice(-800)
      )
      setCommandHistory(
        upsertWorkbenchCommandHistory(owningProject.id, {
          command,
          lastRunAt: result.finishedAt,
          lastSuccess: result.success,
          durationMs: result.durationMs,
          exitCode: result.exitCode,
        })
      )
    } catch (error) {
      if (activeProjectRef.current?.id !== owningProjectId || activeRunIdRef.current !== runId)
        return

      const appError = AppError.from(error)
      setRunOutputLines((current) =>
        [...current, createRunOutputLine(runId, 'stderr', `\n${appError.message}\n`)].slice(-800)
      )
      messageLatest.current.error({
        title: tLatest.current('workbench.commandFailed'),
        description: appError.message,
      })
    } finally {
      setActiveRunId((current) => (current === runId ? null : current))
      setIsRunningCommand(false)
    }
  })

  const rerunLastCommand = useMemoizedFn(async (): Promise<void> => {
    const command = commandResult?.command ?? commandHistory[0]?.command ?? commandInput
    await runCommand(command)
  })

  const clearCommandResult = useMemoizedFn((): void => {
    setCommandResult(null)
    setRunOutputLines([])
    setIsValidationStale(false)
  })

  /** xterm 收齐的按键原样进伪终端。会话已经结束时写入失败是常态（用户还在敲），不弹提示。 */
  const writeTerminalData = useMemoizedFn((sessionId: string, data: string): void => {
    void workbenchHost.kernel.project.writeWorkbenchTerminalInput({ sessionId, input: data })
  })

  const resizeTerminalSession = useMemoizedFn(
    (sessionId: string, cols: number, rows: number): void => {
      void workbenchHost.kernel.project.resizeWorkbenchTerminalSession({ sessionId, cols, rows })
    }
  )

  const stopTerminalSession = useMemoizedFn(async (sessionId: string): Promise<void> => {
    try {
      Result.unwrap(await workbenchHost.kernel.project.stopWorkbenchTerminalSession({ sessionId }))
      setTerminalSessions((current) =>
        current.map((session) =>
          session.id === sessionId ? { ...session, isRunning: false } : session
        )
      )
    } catch (error) {
      const appError = AppError.from(error)
      messageLatest.current.error({
        title: tLatest.current('workbench.terminalStopFailed'),
        description: appError.message,
      })
    }
  })

  // ── 运行卡（PTY 支持的运行会话，走终端会话基础设施）─────────────────────────

  /**
   * 起运行卡背后的那个终端会话（启动与重启共用）：平常是在终端里跑命令；`launch.debug` 是一次调试——程序由
   * 调试器带着检查器起，同样跑在一个终端会话里，输出、停止都照旧。工作目录和环境变量两种都交过去。
   */
  const startRunSessionProcess = async (
    project: WorkbenchProject,
    command: string,
    launch: LooseOptional<WorkbenchRunSessionLaunchOptions>
  ): Promise<{ sessionId: string; shell: string; cwd: string }> => {
    if (launch?.debug) {
      const started = await startWorkbenchDebugRunSession({
        projectRoot: project.rootPath,
        target: launch.debug.target,
        cwd: launch.cwd,
        env: launch.env,
      })
      return { sessionId: started.terminalSessionId, shell: started.shell, cwd: started.cwd }
    }
    return Result.unwrap(
      await workbenchHost.kernel.project.startWorkbenchTerminalSession({
        projectRoot: project.rootPath,
        initialCommand: command,
        cwd: launch?.cwd,
        env: launch?.env,
      })
    )
  }

  /** 启动一张运行卡；返回会话 id（期间切走了项目时为 null，进程随即停掉）。 */
  const startRunSessionForProject = useMemoizedFn(
    async (
      project: WorkbenchProject,
      command: string,
      label: string,
      launch?: WorkbenchRunSessionLaunchOptions
    ): Promise<string | null> => {
      const owner = resourceOwnerRef.current
      if (!owner || owner.projectId !== project.id || !ownsCurrentProject(owner)) return null
      const result = await startRunSessionProcess(project, command, launch)

      owner.sessionIds.add(result.sessionId)
      if (!ownsCurrentProject(owner)) {
        await releaseCommandSession(owner, result.sessionId)
        return null
      }

      const session: WorkbenchTerminalSessionView = {
        id: result.sessionId,
        title: label || command,
        shell: result.shell,
        cwd: result.cwd,
        isRunning: true,
        command,
        launch,
      }
      setRunSessions((current) => [...current, session])
      setActiveRunSessionId(result.sessionId)
      return result.sessionId
    }
  )

  /**
   * 返回新运行卡的会话 id；没有项目、命令为空或启动失败（已提示用户）时为 null。`launch` 是命令之外的条件
   * （运行配置的工作目录、环境变量），重启这张卡时照旧。
   */
  const launchRunSession = useMemoizedFn(
    async (
      commandInput: string,
      label?: string,
      launch?: WorkbenchRunSessionLaunchOptions
    ): Promise<string | null> => {
      const project = activeProjectRef.current
      const owner = resourceOwnerRef.current
      const command = commandInput.trim()
      if (
        !project ||
        !command ||
        !owner ||
        owner.projectId !== project.id ||
        !ownsCurrentProject(owner)
      )
        return null

      // 记住最近一次运行的命令：侧边栏 ▶ 默认指向它，并进入右键切换列表。运行配置起的不算——同一条命令换了
      // 目录、变量就是另一回事，它们在菜单里有自己的一行。调试也不算：▶ 是运行。
      if (!launch?.configurationId && !launch?.debug) setLastLaunchedCommand(command)

      try {
        return await startRunSessionForProject(project, command, label?.trim() || command, launch)
      } catch (error) {
        if (!ownsCurrentProject(owner)) return null
        const appError = AppError.from(error)
        messageLatest.current.error({
          title: tLatest.current('workbench.commandFailed'),
          description: appError.message,
        })
        return null
      }
    }
  )

  const stopRunSession = useMemoizedFn(async (sessionId: string): Promise<void> => {
    try {
      Result.unwrap(await workbenchHost.kernel.project.stopWorkbenchTerminalSession({ sessionId }))
      setRunSessions((current) =>
        current.map((session) =>
          session.id === sessionId ? { ...session, isRunning: false } : session
        )
      )
    } catch (error) {
      const appError = AppError.from(error)
      messageLatest.current.error({
        title: tLatest.current('workbench.terminalStopFailed'),
        description: appError.message,
      })
    }
  })

  const restartRunSession = useMemoizedFn(async (sessionId: string): Promise<void> => {
    const session = runSessionsRef.current.find((candidate) => candidate.id === sessionId)
    const project = activeProjectRef.current
    const owner = resourceOwnerRef.current
    if (
      !session?.command ||
      !project ||
      !owner ||
      owner.projectId !== project.id ||
      !ownsCurrentProject(owner)
    )
      return
    if (owner.restarts.has(sessionId)) return

    const restart = new AbortController()
    owner.restarts.set(sessionId, restart)
    const canRestart = (): boolean =>
      ownsCurrentProject(owner) &&
      !restart.signal.aborted &&
      runSessionsRef.current.some((candidate) => candidate.id === sessionId)

    const command = session.command
    const label = session.title
    const launch = session.launch
    try {
      // 停止失败时保留旧卡和输出；只有真实退出成功才启动新进程。
      Result.unwrap(
        await workbenchHost.kernel.project.stopWorkbenchTerminalSession({
          sessionId,
          waitForExit: true,
        })
      )
      owner.sessionIds.delete(sessionId)
      discardWorkbenchTerminalOutput(sessionId)
      if (!canRestart()) return
      const result = await startRunSessionProcess(project, command, launch)
      owner.sessionIds.add(result.sessionId)
      if (!canRestart()) {
        await releaseCommandSession(owner, result.sessionId)
        return
      }
      const fresh: WorkbenchTerminalSessionView = {
        id: result.sessionId,
        title: label,
        shell: result.shell,
        cwd: result.cwd,
        isRunning: true,
        command,
        launch,
      }
      // 就地替换该卡（保持标签位置），旧 sessionId 的收口事件因 id 已不在集合而自然忽略。
      setRunSessions((current) => current.map((item) => (item.id === sessionId ? fresh : item)))
      setActiveRunSessionId(result.sessionId)
      publishWorkbenchRunSessionRestart(sessionId, result.sessionId)
    } catch (error) {
      if (!canRestart()) {
        log.warn('重启运行会话失败', { sessionId, error: AppError.getMessage(error) })
        return
      }
      const appError = AppError.from(error)
      messageLatest.current.error({
        title: tLatest.current('workbench.commandFailed'),
        description: appError.message,
      })
    } finally {
      owner.restarts.delete(sessionId)
    }
  })

  const closeRunSession = useMemoizedFn((sessionId: string): void => {
    const owner = resourceOwnerRef.current
    if (!owner || !ownsCurrentProject(owner)) return
    owner.restarts.get(sessionId)?.abort()
    void releaseCommandSession(owner, sessionId)
    discardWorkbenchTerminalOutput(sessionId)
    setRunSessions((current) => {
      const next = current.filter((session) => session.id !== sessionId)
      setActiveRunSessionId((currentActive) =>
        currentActive === sessionId ? toNullable(next.at(-1)?.id) : currentActive
      )
      return next
    })
  })

  return {
    state: {
      command: {
        commandInput,
        commandResult,
        commandHistory,
        commandSuggestions,
        runConfigurations,
        runOutputLines,
        isRunningCommand,
        hasActiveRunCommand: isPresent(activeRunId),
        isValidationStale,
        lastLaunchedCommand,
      },
      terminal: {
        terminalSessions,
        activeTerminalSessionId,
      },
      run: {
        runSessions,
        activeRunSessionId,
      },
    },
    actions: {
      command: {
        setCommandInput,
        markValidationStale,
        clearCommandResult,
        runCommand,
        rerunLastCommand,
      },
      terminal: {
        setActiveTerminalSessionId,
        createTerminalSession,
        writeTerminalData,
        resizeTerminalSession,
        stopTerminalSession,
        closeTerminalSessions,
      },
      run: {
        setActiveRunSessionId,
        launchRunSession,
        stopRunSession,
        restartRunSession,
        closeRunSession,
      },
    },
  }
}
