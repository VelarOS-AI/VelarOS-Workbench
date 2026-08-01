import { useEffect } from 'react'
import type { Dispatch, MutableRefObject, SetStateAction } from 'react'

import type { WorkbenchTerminalOutputEvent } from '@shared/contracts'

import { useWorkbenchHostRuntime } from '../../host'
import {
  createRunOutputLine,
  createTerminalLine,
  type WorkbenchRunOutputLine,
  type WorkbenchTerminalSessionView,
} from '../../models/commands/workbenchCommandLines'

function applyTerminalOutputEvent(
  sessions: WorkbenchTerminalSessionView[],
  event: WorkbenchTerminalOutputEvent
): WorkbenchTerminalSessionView[] {
  return sessions.map((session) => {
    if (session.id !== event.sessionId) return session

    // cwd 探针可能只带 cwd、chunk 为空：更新目录但不产生空行。
    const shouldAppendLine = event.chunk.length > 0
    return {
      ...session,
      cwd: event.cwd ?? session.cwd,
      isRunning: event.closed ? false : session.isRunning,
      lines: shouldAppendLine
        ? [...session.lines, createTerminalLine(event.stream, event.chunk)].slice(-500)
        : session.lines,
    }
  })
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

    const unsubscribe = hostRuntime.kernel.project.onWorkbenchTerminalOutput((event) => {
      // 一个 sessionId 只会命中终端会话或运行卡其中一处；两处都按 sessionId 更新即可。
      setTerminalSessions((current) => applyTerminalOutputEvent(current, event))
      setRunSessions((current) => applyTerminalOutputEvent(current, event))
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
