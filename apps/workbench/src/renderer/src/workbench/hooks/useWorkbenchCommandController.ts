import { useMemo,useState } from 'react'

import { isPresent,toNullable } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'
import { Result } from '@velaros-ai/core/result'
import type { WorkbenchDirectoryEntry, WorkbenchRunCommandResult } from '@velaros-ai/workbench/contracts'
import { useWorkbenchCommandIpcSubscriptions } from '@velaros-ai/workbench/hooks/workbenchCommand/useWorkbenchCommandIpcSubscriptions'
import { useWorkbenchCommandPackageSuggestions } from '@velaros-ai/workbench/hooks/workbenchCommand/useWorkbenchCommandPackageSuggestions'
import { useWorkbenchCommandProjectBootstrap } from '@velaros-ai/workbench/hooks/workbenchCommand/useWorkbenchCommandProjectBootstrap'
import { workbenchHost } from '@velaros-ai/workbench/host'
import {
  upsertWorkbenchCommandHistory,
  type WorkbenchCommandHistoryItem,
} from '@velaros-ai/workbench/models/commands/workbenchCommandHistory'
import {
  createRunOutputLine,
  createTerminalLine,
  formatRunDuration,
  type WorkbenchRunOutputLine,
  type WorkbenchTerminalSessionView,
} from '@velaros-ai/workbench/models/commands/workbenchCommandLines'
import type { WorkbenchCommandSuggestion } from '@velaros-ai/workbench/models/commands/workbenchCommandSuggestions'
import { buildWorkbenchRunConfigurations } from '@velaros-ai/workbench/models/commands/workbenchRunConfigurations'
import {
  buildWorkbenchTerminalSessionTitle,
  formatWorkbenchTerminalPrompt,
} from '@velaros-ai/workbench/models/commands/workbenchTerminalPresentation'
import type { WorkbenchProject } from '@velaros-ai/workbench/models/project/workbenchProjects'

import { useStableWorkbenchMessageTranslate } from '../runtime/useStableWorkbenchMessaging'
import {
  useLatest, useMemoizedFn, useUnmount } from '../support/genericHooks'

export type {
  WorkbenchRunOutputLine,
  WorkbenchTerminalLine,
  WorkbenchTerminalSessionView,
} from '@velaros-ai/workbench/models/commands/workbenchCommandLines'

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
          input: '',
          isRunning: true,
          lines: [],
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

  const setTerminalInput = useMemoizedFn((sessionId: string, input: string): void => {
    setTerminalSessions((current) =>
      current.map((session) => (session.id === sessionId ? { ...session, input } : session))
    )
  })

  const runTerminalInput = useMemoizedFn(async (sessionId: string): Promise<void> => {
    const session = terminalSessionsRef.current.find((candidate) => candidate.id === sessionId)
    if (!session || !session.isRunning) return

    const command = session.input.trimEnd()
    if (!command.trim()) return

    setTerminalSessions((current) =>
      current.map((candidate) =>
        candidate.id === sessionId
          ? {
              ...candidate,
              input: '',
              lines: [
                ...candidate.lines,
                createTerminalLine(
                  'input',
                  `${formatWorkbenchTerminalPrompt(candidate)}${command.trim()}\n`
                ),
              ].slice(-500),
            }
          : candidate
      )
    )

    try {
      Result.unwrap(
        await workbenchHost.kernel.project.writeWorkbenchTerminalInput({
          sessionId,
          input: `${command}\n`,
        })
      )
    } catch (error) {
      const appError = AppError.from(error)
      messageLatest.current.error({
        title: tLatest.current('workbench.terminalWriteFailed'),
        description: appError.message,
      })
    }
  })

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
    setTerminalSessions((current) => {
      const next = current.filter((session) => session.id !== sessionId)
      setActiveTerminalSessionId((currentActive) =>
        currentActive === sessionId ? (toNullable(next.at(-1)?.id)) : currentActive
      )
      return next
    })
  })

  // ── 运行卡（PTY 支持的运行会话，走终端会话基础设施）─────────────────────────

  const startRunSessionForProject = useMemoizedFn(
    async (project: WorkbenchProject, command: string, label: string): Promise<void> => {
      const owningProjectId = project.id
      const result = Result.unwrap(
        await workbenchHost.kernel.project.startWorkbenchTerminalSession({
          projectRoot: project.rootPath,
          initialCommand: command,
        })
      )

      if (activeProjectRef.current?.id !== owningProjectId) {
        void workbenchHost.kernel.project.stopWorkbenchTerminalSession({ sessionId: result.sessionId })
        return
      }

      const session: WorkbenchTerminalSessionView = {
        id: result.sessionId,
        title: label || command,
        shell: result.shell,
        cwd: result.cwd,
        input: '',
        isRunning: true,
        command,
        lines: [createTerminalLine('input', `$ ${command}\n`)],
      }
      setRunSessions((current) => [...current, session])
      setActiveRunSessionId(result.sessionId)
    }
  )

  const launchRunSession = useMemoizedFn(
    async (commandInput: string, label?: string): Promise<void> => {
      const project = activeProjectRef.current
      const command = commandInput.trim()
      if (!project || !command) return

      // 记住最近一次运行的命令：侧边栏 ▶ 默认指向它，并进入右键切换列表。
      setLastLaunchedCommand(command)

      try {
        await startRunSessionForProject(project, command, label?.trim() || command)
      } catch (error) {
        const appError = AppError.from(error)
        messageLatest.current.error({
          title: tLatest.current('workbench.commandFailed'),
          description: appError.message,
        })
      }
    }
  )

  const setRunSessionInput = useMemoizedFn((sessionId: string, input: string): void => {
    setRunSessions((current) =>
      current.map((session) => (session.id === sessionId ? { ...session, input } : session))
    )
  })

  const writeRunSessionInput = useMemoizedFn(async (sessionId: string): Promise<void> => {
    const session = runSessionsRef.current.find((candidate) => candidate.id === sessionId)
    if (!session || !session.isRunning) return

    const value = session.input
    setRunSessions((current) =>
      current.map((candidate) =>
        candidate.id === sessionId
          ? {
              ...candidate,
              input: '',
              lines: [...candidate.lines, createTerminalLine('input', `${value}\n`)].slice(-500),
            }
          : candidate
      )
    )

    try {
      Result.unwrap(
        await workbenchHost.kernel.project.writeWorkbenchTerminalInput({
          sessionId,
          input: `${value}\n`,
          raw: true,
        })
      )
    } catch (error) {
      const appError = AppError.from(error)
      messageLatest.current.error({
        title: tLatest.current('workbench.terminalWriteFailed'),
        description: appError.message,
      })
    }
  })

  const sendRunSessionInterrupt = useMemoizedFn(async (sessionId: string): Promise<void> => {
    const session = runSessionsRef.current.find((candidate) => candidate.id === sessionId)
    if (!session || !session.isRunning) return

    setRunSessions((current) =>
      current.map((candidate) =>
        candidate.id === sessionId
          ? {
              ...candidate,
              lines: [...candidate.lines, createTerminalLine('system', '^C\n')].slice(-500),
            }
          : candidate
      )
    )

    // 子进程用 pipe stdio（非 PTY），\x03 不会触发信号；直接向前台进程组发 SIGINT。
    try {
      Result.unwrap(
        await workbenchHost.kernel.project.stopWorkbenchTerminalSession({
          sessionId,
          signal: 'SIGINT',
          skipForceKill: true,
        })
      )
    } catch (error) {
      const appError = AppError.from(error)
      messageLatest.current.error({
        title: tLatest.current('workbench.terminalStopFailed'),
        description: appError.message,
      })
    }
  })

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

    void workbenchHost.kernel.project.stopWorkbenchTerminalSession({ sessionId })

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
        input: '',
        isRunning: true,
        command,
        lines: [createTerminalLine('input', `$ ${command}\n`)],
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
        setTerminalInput,
        runTerminalInput,
        stopTerminalSession,
        closeTerminalSession,
      },
      run: {
        setActiveRunSessionId,
        launchRunSession,
        stopRunSession,
        restartRunSession,
        closeRunSession,
        setRunSessionInput,
        writeRunSessionInput,
        sendRunSessionInterrupt,
      },
    },
  }
}
