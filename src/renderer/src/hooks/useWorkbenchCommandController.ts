import { useMemo,useState } from 'react'
import { useWorkbenchCommandIpcSubscriptions } from '@renderer/hooks/workbenchCommand/useWorkbenchCommandIpcSubscriptions'
import { useWorkbenchCommandPackageSuggestions } from '@renderer/hooks/workbenchCommand/useWorkbenchCommandPackageSuggestions'
import { useWorkbenchCommandProjectBootstrap } from '@renderer/hooks/workbenchCommand/useWorkbenchCommandProjectBootstrap'
import { workbenchHost } from '@renderer/host'
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
import { buildWorkbenchTerminalSessionTitle } from '@renderer/models/commands/workbenchTerminalPresentation'
import {
  closeWorkbenchTerminalSessions,
  insertWorkbenchTerminalSplit,
  pickWorkbenchTerminalTitle,
} from '@renderer/models/commands/workbenchTerminalSplits'
import type { WorkbenchProject } from '@renderer/models/project/workbenchProjects'

import { isPresent, toNullable, toOptional } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'
import { Result } from '@velaros-ai/core/result'

import type { WorkbenchDirectoryEntry, WorkbenchRunCommandResult } from '@shared/contracts'

import { useStableWorkbenchMessageTranslate } from '../runtime/useStableWorkbenchMessaging'
import {
  useLatest, useMemoizedFn, useUnmount } from '../support/genericHooks'

export type {
  WorkbenchRunOutputLine,
  WorkbenchRunSessionLaunchOptions,
  WorkbenchTerminalSessionView,
} from '@renderer/models/commands/workbenchCommandLines'

interface UseWorkbenchCommandControllerOptions {
  activeProject: Nullable<WorkbenchProject>
  rootEntries: WorkbenchDirectoryEntry[]
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
  const activeTerminalSessionIdRef = useLatest(activeTerminalSessionId)
  const [runSessions, setRunSessions] = useState<WorkbenchTerminalSessionView[]>([])
  const [activeRunSessionId, setActiveRunSessionId] = useState<Nullable<string>>(null)
  const [lastLaunchedCommand, setLastLaunchedCommand] = useState('')
  const runSessionsRef = useLatest(runSessions)
  const activeProjectRef = useLatest(activeProject)
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

  useUnmount(() => {
    terminalSessionsRef.current.forEach((session) => {
      void workbenchHost.kernel.project.stopWorkbenchTerminalSession({ sessionId: session.id })
    })
    runSessionsRef.current.forEach((session) => {
      void workbenchHost.kernel.project.stopWorkbenchTerminalSession({ sessionId: session.id })
    })
  })

  /** 关掉几个终端：关标签是它那一组全部，关并排里的一个就是那一个。 */
  const closeTerminalSessions = useMemoizedFn((sessionIds: readonly string[]): void => {
    for (const sessionId of sessionIds) {
      void workbenchHost.kernel.project.stopWorkbenchTerminalSession({ sessionId })
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

  /**
   * 开一个终端。给了 `besideSessionId` 是拆分：新终端排在那个终端右边、同一个标签里，从它的 shell 此刻所在的
   * 目录开始；不给就是一个新标签，从项目根开始。
   */
  const createTerminalSessionForProject = useMemoizedFn(
    async (project: WorkbenchProject, besideSessionId: Nullable<string> = null): Promise<void> => {
      const owningProject = project
      const owningProjectId = owningProject.id

      try {
        const result = Result.unwrap(
          await workbenchHost.kernel.project.startWorkbenchTerminalSession({
            projectRoot: owningProject.rootPath,
            inheritCwdFrom: toOptional(besideSessionId),
          })
        )

        if (activeProjectRef.current?.id !== owningProjectId) {
          void workbenchHost.kernel.project.stopWorkbenchTerminalSession({ sessionId: result.sessionId })
          return
        }

        const sessions = terminalSessionsRef.current
        const beside = sessions.find((candidate) => candidate.id === besideSessionId)
        // 拆分出来的跟原来那个同一个标签、同一个名字；新标签取第一个没人用的名字。
        const title =
          beside?.title ??
          pickWorkbenchTerminalTitle(sessions, (sessionIndex) =>
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

        setTerminalSessions((current) =>
          besideSessionId
            ? insertWorkbenchTerminalSplit(current, besideSessionId, session)
            : [...current, session]
        )
        setActiveTerminalSessionId(result.sessionId)
      } catch (error) {
        if (activeProjectRef.current?.id !== owningProjectId) return

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

  /** 在一个终端右边并排再开一个（不指明就是当前那个）；一个终端都没有时等于新开一个。 */
  const splitTerminalSession = useMemoizedFn(async (sessionId?: string): Promise<void> => {
    const project = activeProjectRef.current
    if (project) {
      await createTerminalSessionForProject(
        project,
        sessionId ?? activeTerminalSessionIdRef.current
      )
    }
  })

  useWorkbenchCommandProjectBootstrap({
    activeProjectId: activeProject?.id,
    activeProjectRef,
    terminalSessionsRef,
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

      if (activeProjectRef.current?.id !== owningProjectId || activeRunIdRef.current !== runId) return

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
      if (activeProjectRef.current?.id !== owningProjectId || activeRunIdRef.current !== runId) return

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

  /** 拖完并排终端之间的分隔条：记下各自的宽度份额。 */
  const setTerminalPaneWeights = useMemoizedFn(
    (weights: Readonly<Record<string, number>>): void => {
      setTerminalSessions((current) =>
        current.map((session) => {
          const paneWeight = weights[session.id]
          return paneWeight === undefined ? session : { ...session, paneWeight }
        })
      )
    }
  )

  // ── 运行卡（PTY 支持的运行会话，走终端会话基础设施）─────────────────────────

  /** 启动一张运行卡；返回会话 id（期间切走了项目时为 null，进程随即停掉）。 */
  const startRunSessionForProject = useMemoizedFn(
    async (
      project: WorkbenchProject,
      command: string,
      label: string,
      launch?: WorkbenchRunSessionLaunchOptions
    ): Promise<string | null> => {
      const owningProjectId = project.id
      const result = Result.unwrap(
        await workbenchHost.kernel.project.startWorkbenchTerminalSession({
          projectRoot: project.rootPath,
          initialCommand: command,
          cwd: launch?.cwd,
          env: launch?.env,
        })
      )

      if (activeProjectRef.current?.id !== owningProjectId) {
        void workbenchHost.kernel.project.stopWorkbenchTerminalSession({ sessionId: result.sessionId })
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
      const command = commandInput.trim()
      if (!project || !command) return null

      // 记住最近一次运行的命令：侧边栏 ▶ 默认指向它，并进入右键切换列表。运行配置起的不算——同一条命令换了
      // 目录、变量就是另一回事，它们在菜单里有自己的一行。
      if (!launch?.configurationId) setLastLaunchedCommand(command)

      try {
        return await startRunSessionForProject(project, command, label?.trim() || command, launch)
      } catch (error) {
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
    if (!session?.command || !project) return

    // 等旧进程真的退出（让出端口、释放文件）再起新的，否则新进程一起来就撞上「端口已被占用」。
    await workbenchHost.kernel.project.stopWorkbenchTerminalSession({ sessionId, waitForExit: true })
    discardWorkbenchTerminalOutput(sessionId)

    const command = session.command
    const label = session.title
    const launch = session.launch
    try {
      const result = Result.unwrap(
        await workbenchHost.kernel.project.startWorkbenchTerminalSession({
          projectRoot: project.rootPath,
          initialCommand: command,
          cwd: launch?.cwd,
          env: launch?.env,
        })
      )
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
      const appError = AppError.from(error)
      messageLatest.current.error({
        title: tLatest.current('workbench.commandFailed'),
        description: appError.message,
      })
    }
  })

  const closeRunSession = useMemoizedFn((sessionId: string): void => {
    void workbenchHost.kernel.project.stopWorkbenchTerminalSession({ sessionId })
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
        splitTerminalSession,
        writeTerminalData,
        resizeTerminalSession,
        stopTerminalSession,
        closeTerminalSessions,
        setTerminalPaneWeights,
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
