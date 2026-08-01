import { type KeyboardEvent, useEffect, useMemo, useState } from 'react'

import { isEmpty } from '@velaros-ai/core'

import type { WorkbenchCommandHistoryItem } from '../../models/commands/workbenchCommandHistory'
import type { WorkbenchRunConfiguration } from '../../models/commands/workbenchRunConfigurations'
import {
  applyWorkbenchTerminalCompletion,
  buildWorkbenchTerminalCompletionSuggestions,
} from '../../models/commands/workbenchTerminalCompletion'
import type { WorkbenchProjectContextFile } from '../../models/project/workbenchProjectContextIndex'

interface TerminalSessionLike {
  id: string
  input: string
}

interface UseWorkbenchTerminalCompletionInteractionsParams<TSession extends TerminalSessionLike> {
  terminalSessions: readonly TSession[]
  activeTerminalSessionId: LooseOptional<string>
  commandHistory: readonly WorkbenchCommandHistoryItem[]
  projectFiles: readonly WorkbenchProjectContextFile[]
  runConfigurations: readonly WorkbenchRunConfiguration[]
  onTerminalInputChange: (sessionId: string, input: string) => void
  onRunTerminalInput: (sessionId: string) => void
}

function useWorkbenchTerminalCompletionInteractions<TSession extends TerminalSessionLike>(
  params: UseWorkbenchTerminalCompletionInteractionsParams<TSession>
): {
  activeTerminalSession: LooseOptional<TSession>
  terminalSuggestions: ReturnType<typeof buildWorkbenchTerminalCompletionSuggestions>
  activeSuggestionIndex: number
  chooseTerminalSuggestion: (index: number) => void
  handleTerminalKeyDown: (event: KeyboardEvent<HTMLInputElement>) => void
} {
  const {
    terminalSessions,
    activeTerminalSessionId,
    commandHistory,
    projectFiles,
    runConfigurations,
    onTerminalInputChange,
    onRunTerminalInput,
  } = params

  const activeTerminalSession =
    terminalSessions.find((session) => session.id === activeTerminalSessionId) ?? terminalSessions[0]

  const terminalSuggestions = useMemo(
    () =>
      activeTerminalSession
        ? buildWorkbenchTerminalCompletionSuggestions({
            commandHistory: [...commandHistory],
            files: [...projectFiles],
            input: activeTerminalSession.input,
            runConfigurations: [...runConfigurations],
          })
        : [],
    [activeTerminalSession, commandHistory, projectFiles, runConfigurations]
  )

  const [activeSuggestionIndex, setActiveSuggestionIndex] = useState(0)

  useEffect(() => {
    setActiveSuggestionIndex(0)
  }, [activeTerminalSession?.input, activeTerminalSession?.id])

  function chooseTerminalSuggestion(index: number): void {
    if (!activeTerminalSession || isEmpty(terminalSuggestions)) return

    const suggestion = terminalSuggestions[index] ?? terminalSuggestions[0]
    if (!suggestion) return

    onTerminalInputChange(
      activeTerminalSession.id,
      applyWorkbenchTerminalCompletion(activeTerminalSession.input, suggestion)
    )
  }

  function handleTerminalKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    if (!activeTerminalSession) return

    if (event.key === 'Tab') {
      if (!isEmpty(terminalSuggestions)) {
        event.preventDefault()
        chooseTerminalSuggestion(activeSuggestionIndex)
      }
      return
    }

    if (event.key === 'ArrowDown' && !isEmpty(terminalSuggestions)) {
      event.preventDefault()
      setActiveSuggestionIndex((index) => (index + 1) % terminalSuggestions.length)
      return
    }

    if (event.key === 'ArrowUp' && !isEmpty(terminalSuggestions)) {
      event.preventDefault()
      setActiveSuggestionIndex(
        (index) => (index - 1 + terminalSuggestions.length) % terminalSuggestions.length
      )
      return
    }

    if (event.key === 'Enter') {
      event.preventDefault()
      onRunTerminalInput(activeTerminalSession.id)
    }
  }

  return {
    activeTerminalSession,
    terminalSuggestions,
    activeSuggestionIndex,
    chooseTerminalSuggestion,
    handleTerminalKeyDown,
  }
}

export { useWorkbenchTerminalCompletionInteractions }
