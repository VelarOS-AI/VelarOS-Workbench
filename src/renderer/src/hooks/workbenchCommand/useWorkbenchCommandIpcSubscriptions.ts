import { useEffect } from 'react'
import type { Dispatch, MutableRefObject, SetStateAction } from 'react'

import { useWorkbenchHostRuntime } from '../../host'
import {
  createRunOutputLine,
  type WorkbenchRunOutputLine,
  type WorkbenchTerminalSessionView,
} from '../../models/commands/workbenchCommandLines'
import { publishWorkbenchTerminalOutput } from '../../models/commands/workbenchTerminalOutputBus'

export function markWorkbenchTerminalSessionClosed(
  sessions: WorkbenchTerminalSessionView[],
  sessionId: string
): WorkbenchTerminalSessionView[] {
  return sessions.some((session) => session.id === sessionId && session.isRunning)
    ? sessions.map((session) =>
        session.id === sessionId ? { ...session, isRunning: false } : session
      )
    : sessions
}

export function useWorkbenchCommandIpcSubscriptions(
  activeRunIdRef: MutableRefObject<Nullable<string>>,
  setRunOutputLines: Dispatch<SetStateAction<WorkbenchRunOutputLine[]>>,
  setTerminalSessions: Dispatch<SetStateAction<WorkbenchTerminalSessionView[]>>,
  setRunSessions: Dispatch<SetStateAction<WorkbenchTerminalSessionView[]>>,
  setIsRunningCommand: Dispatch<SetStateAction<boolean>>
): void {
  const hostRuntime = useWorkbenchHostRuntime()
  useEffect(() => {
    const unsubscribeRunOutput = hostRuntime.kernel.project.onWorkbenchRunCommandOutput((event) => {
      if (event.runId !== activeRunIdRef.current) return

      if (event.closed) {
        setIsRunningCommand(false)
        return
      }

      if (!event.chunk) return

      setIsRunningCommand(false)
      setRunOutputLines((current) =>
        [...current, createRunOutputLine(event.runId, event.stream, event.chunk)].slice(-800)
      )
    })

    // 伪终端输出直送 xterm，不经 React；只有收口状态走 React。
    const unsubscribe = hostRuntime.kernel.project.onWorkbenchTerminalOutput((event) => {
      publishWorkbenchTerminalOutput(event.sessionId, event.chunk)
      if (!event.closed) return
      setTerminalSessions((current) => markWorkbenchTerminalSessionClosed(current, event.sessionId))
      setRunSessions((current) => markWorkbenchTerminalSessionClosed(current, event.sessionId))
    })

    return () => {
      unsubscribeRunOutput()
      unsubscribe()
    }
  }, [
    activeRunIdRef,
    hostRuntime,
    setIsRunningCommand,
    setRunOutputLines,
    setRunSessions,
    setTerminalSessions,
  ])
}
