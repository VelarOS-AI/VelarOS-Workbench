import { useEffect } from 'react'
import type { Dispatch, MutableRefObject, SetStateAction } from 'react'

import { useWorkbenchHostRuntime } from '../../host'
import {
  createRunOutputLine,
  type WorkbenchRunOutputLine,
  type WorkbenchTerminalSessionView,
} from '../../models/commands/workbenchCommandLines'
import {
  publishWorkbenchTerminalOutput,
  setWorkbenchTerminalOutputAcknowledger,
} from '../../models/commands/workbenchTerminalOutputBus'

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

/** 焦点此刻是不是在这个会话的终端里（用户正在里面打字）。 */
function isWorkbenchTerminalFocused(sessionId: string): boolean {
  const frame = document.activeElement?.closest('[data-terminal-session]')
  return frame?.getAttribute('data-terminal-session') === sessionId
}

export function useWorkbenchCommandIpcSubscriptions(
  activeRunIdRef: MutableRefObject<Nullable<string>>,
  setRunOutputLines: Dispatch<SetStateAction<WorkbenchRunOutputLine[]>>,
  setTerminalSessions: Dispatch<SetStateAction<WorkbenchTerminalSessionView[]>>,
  setRunSessions: Dispatch<SetStateAction<WorkbenchTerminalSessionView[]>>,
  setIsRunningCommand: Dispatch<SetStateAction<boolean>>,
  /** 用户在终端里退出了 shell：关掉这个终端，返回 true；不是终端（运行卡）返回 false。 */
  closeExitedTerminalSession: (sessionId: string) => boolean
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

    // 伪终端输出直送 xterm，不经 React；只有收口状态走 React。处理完的输出确认回主进程（流控）。
    setWorkbenchTerminalOutputAcknowledger((sessionId, chars) =>
      hostRuntime.kernel.project.acknowledgeWorkbenchTerminalOutput({ sessionId, chars })
    )
    const unsubscribe = hostRuntime.kernel.project.onWorkbenchTerminalOutput((event) => {
      publishWorkbenchTerminalOutput(event.sessionId, event.chunk)
      if (!event.closed) return
      // 在终端里敲 exit（shell 正常退出，焦点就在这个终端里）：终端跟着关掉。其余的留着，能看到它是怎么结束的。
      if (
        event.exitCode === 0 &&
        isWorkbenchTerminalFocused(event.sessionId) &&
        closeExitedTerminalSession(event.sessionId)
      )
        return
      setTerminalSessions((current) => markWorkbenchTerminalSessionClosed(current, event.sessionId))
      setRunSessions((current) => markWorkbenchTerminalSessionClosed(current, event.sessionId))
    })

    return () => {
      unsubscribeRunOutput()
      unsubscribe()
      setWorkbenchTerminalOutputAcknowledger(null)
    }
  }, [
    activeRunIdRef,
    closeExitedTerminalSession,
    hostRuntime,
    setIsRunningCommand,
    setRunOutputLines,
    setRunSessions,
    setTerminalSessions,
  ])
}
