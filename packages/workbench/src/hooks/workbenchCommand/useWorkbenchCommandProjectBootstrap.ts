import { useEffect } from 'react'
import type { Dispatch, MutableRefObject, SetStateAction } from 'react'

import type { WorkbenchRunCommandResult } from '@velaros/core/types'

import { workbenchHost } from '../../host'
import {
  readWorkbenchCommandHistory,
  type WorkbenchCommandHistoryItem,
} from '../../models/commands/workbenchCommandHistory'
import type {
  WorkbenchRunOutputLine,
  WorkbenchTerminalSessionView,
} from '../../models/commands/workbenchCommandLines'
import type { WorkbenchCommandSuggestion } from '../../models/commands/workbenchCommandSuggestions'
import type { WorkbenchProject } from '../../models/project/workbenchProjects'

interface UseWorkbenchCommandProjectBootstrapOptions {
  activeProjectId?: string
  activeProjectRef: MutableRefObject<Nullable<WorkbenchProject>>
  terminalSessionsRef: MutableRefObject<WorkbenchTerminalSessionView[]>
  setTerminalSessions: Dispatch<SetStateAction<WorkbenchTerminalSessionView[]>>
  setActiveTerminalSessionId: Dispatch<SetStateAction<Nullable<string>>>
  setCommandHistory: Dispatch<SetStateAction<WorkbenchCommandHistoryItem[]>>
  setCommandInput: Dispatch<SetStateAction<string>>
  setCommandResult: Dispatch<SetStateAction<Nullable<WorkbenchRunCommandResult>>>
  setRunOutputLines: Dispatch<SetStateAction<WorkbenchRunOutputLine[]>>
  setCommandSuggestions: Dispatch<SetStateAction<WorkbenchCommandSuggestion[]>>
  setIsRunningCommand: Dispatch<SetStateAction<boolean>>
  setActiveRunId: Dispatch<SetStateAction<Nullable<string>>>
  setIsValidationStale: Dispatch<SetStateAction<boolean>>
  createTerminalSession: (project: WorkbenchProject) => Promise<void>
}

export function useWorkbenchCommandProjectBootstrap({
  activeProjectId,
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
  createTerminalSession,
}: UseWorkbenchCommandProjectBootstrapOptions): void {
  useEffect(() => {
    terminalSessionsRef.current.forEach((session) => {
      void workbenchHost.kernel.project.stopWorkbenchTerminalSession({ sessionId: session.id })
    })
    setTerminalSessions([])
    setActiveTerminalSessionId(null)

    const project = activeProjectRef.current
    const history = project ? readWorkbenchCommandHistory(project.id) : []
    setCommandHistory(history)
    setCommandInput(history[0]?.command || '')
    setCommandResult(null)
    setRunOutputLines([])
    setCommandSuggestions([])
    setIsRunningCommand(false)
    setActiveRunId(null)
    setIsValidationStale(false)
    if (project) {
      void createTerminalSession(project)
    }
  }, [
    activeProjectId,
    activeProjectRef,
    createTerminalSession,
    setActiveTerminalSessionId,
    setCommandHistory,
    setCommandInput,
    setCommandResult,
    setCommandSuggestions,
    setIsRunningCommand,
    setActiveRunId,
    setIsValidationStale,
    setRunOutputLines,
    setTerminalSessions,
    terminalSessionsRef,
  ])
}
