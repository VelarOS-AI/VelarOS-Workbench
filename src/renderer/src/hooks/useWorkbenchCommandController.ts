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
  type WorkbenchTerminalSessionView,
} from '@renderer/models/commands/workbenchCommandLines'
import type { WorkbenchCommandSuggestion } from '@renderer/models/commands/workbenchCommandSuggestions'
import { buildWorkbenchRunConfigurations } from '@renderer/models/commands/workbenchRunConfigurations'
import { discardWorkbenchTerminalOutput } from '@renderer/models/commands/workbenchTerminalOutputBus'
import { buildWorkbenchTerminalSessionTitle } from '@renderer/models/commands/workbenchTerminalPresentation'
import type { WorkbenchProject } from '@renderer/models/project/workbenchProjects'

import { isPresent,toNullable } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'
import { Result } from '@velaros-ai/core/result'

import type { WorkbenchDirectoryEntry, WorkbenchRunCommandResult } from '@shared/contracts'

import { useStableWorkbenchMessageTranslate } from '../runtime/useStableWorkbenchMessaging'
import {
  useLatest, useMemoizedFn, useUnmount } from '../support/genericHooks'

export type {
  WorkbenchRunOutputLine,
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

  useWorkbenchCommandIpcSubscriptions(
    activeRunIdRef,
    setRunOutputLines,
    setTerminalSessions,
    setRunSessions,
    setIsRunningCommand
  )

  const createTerminalSessionForProject = useMemoizedFn(
    async (project: WorkbenchProject): Promise<void> => {
      const owningProject = project
      const owningProjectId = owningProject.id

      try {
        const result = Result.unwrap(
          await workbenchHost.kernel.project.startWorkbenchTerminalSession({
            projectRoot: owningProject.rootPath,
          })
        )

        if (activeProjectRef.current?.id !== owningProjectId) {
          void workbenchHost.kernel.project.stopWorkbenchTerminalSession({ sessionId: result.sessionId })
          return
        }

        const sessionIndex = terminalSessionsRef.current.length
        const title = buildWorkbenchTerminalSessionTitle(sessionIndex, {
          local: tLatest.current('workbench.terminalLocalTab'),
          localIndexed: (index) =>
            tLatest.current('workbench.terminalLocalTabIndexed', { index }),
        })
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

  const closeTerminalSession = useMemoizedFn((sessionId: string): void => {
    void workbenchHost.kernel.project.stopWorkbenchTerminalSession({ sessionId })
    discardWorkbenchTerminalOutput(sessionId)
    setTerminalSessions((current) => {
      const next = current.filter((session) => session.id !== sessionId)
      setActiveTerminalSessionId((currentActive) =>
        currentActive === sessionId ? (toNullable(next.at(-1)?.id)) : currentActive
      )
      return next
    })
  })

  // ── 运行卡（PTY 支持的运行会话，走终端会话基础设施）─────────────────────────

  /** 启动一张运行卡；返回会话 id（期间切走了项目时为 null，进程随即停掉）。 */
  const startRunSessionForProject = useMemoizedFn(
    async (project: WorkbenchProject, command: string, label: string): Promise<string | null> => {
      const owningProjectId = project.id
      const result = Result.unwrap(
        await workbenchHost.kernel.project.startWorkbenchTerminalSession({
          projectRoot: project.rootPath,
          initialCommand: command,
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
      }
      setRunSessions((current) => [...current, session])
      setActiveRunSessionId(result.sessionId)
      return result.sessionId
    }
  )

  /** 返回新运行卡的会话 id；没有项目、命令为空或启动失败（已提示用户）时为 null。 */
  const launchRunSession = useMemoizedFn(
    async (commandInput: string, label?: string): Promise<string | null> => {
      const project = activeProjectRef.current
      const command = commandInput.trim()
      if (!project || !command) return null

      // 记住最近一次运行的命令：侧边栏 ▶ 默认指向它，并进入右键切换列表。
      setLastLaunchedCommand(command)

      try {
        return await startRunSessionForProject(project, command, label?.trim() || command)
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
    try {
      const result = Result.unwrap(
        await workbenchHost.kernel.project.startWorkbenchTerminalSession({
          projectRoot: project.rootPath,
          initialCommand: command,
        })
      )
      const fresh: WorkbenchTerminalSessionView = {
        id: result.sessionId,
        title: label,
        shell: result.shell,
        cwd: result.cwd,
        isRunning: true,
        command,
      }
      // 就地替换该卡（保持标签位置），旧 sessionId 的收口事件因 id 已不在集合而自然忽略。
      setRunSessions((current) => current.map((item) => (item.id === sessionId ? fresh : item)))
      setActiveRunSessionId(result.sessionId)
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
        writeTerminalData,
        resizeTerminalSession,
        stopTerminalSession,
        closeTerminalSession,
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
