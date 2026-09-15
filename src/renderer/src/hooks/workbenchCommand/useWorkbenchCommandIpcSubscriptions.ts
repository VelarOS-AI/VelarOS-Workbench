import { useEffect } from 'react'
import type { Dispatch, MutableRefObject, SetStateAction } from 'react'

import { useWorkbenchHostRuntime } from '../../host'
import {
  createRunOutputLine,
  createTerminalLine,
  type WorkbenchRunOutputLine,
  type WorkbenchTerminalSessionView,
} from '../../models/commands/workbenchCommandLines'
import { publishWorkbenchTerminalOutput } from '../../models/commands/workbenchTerminalOutputBus'
import { createWorkbenchTerminalRunLog } from '../../models/commands/workbenchTerminalRunLog'

/** 运行卡文本日志落进 React 状态的合并周期。 */
const RunLogFlushDelayMs = 100
const MaxRunLogLines = 500

/** 运行卡的文本日志追加一段（终端会话不在 runSessions 里，自然跳过）。 */
export function appendWorkbenchRunLogChunks(
  sessions: WorkbenchTerminalSessionView[],
  chunksBySession: ReadonlyMap<string, string>
): WorkbenchTerminalSessionView[] {
  if (chunksBySession.size === 0) return sessions
  let changed = false
  const next = sessions.map((session) => {
    const chunk = chunksBySession.get(session.id)
    if (!chunk) return session
    changed = true
    return {
      ...session,
      lines: [...session.lines, createTerminalLine('stdout', chunk)].slice(-MaxRunLogLines),
    }
  })
  return changed ? next : sessions
}

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

    // 伪终端输出直送 xterm；只有运行卡的文本日志（给 Agent 读、给 waitFor 等）与收口状态走 React。
    const runLog = createWorkbenchTerminalRunLog({
      flushDelayMs: RunLogFlushDelayMs,
      onFlush: (chunksBySession) =>
        setRunSessions((current) => appendWorkbenchRunLogChunks(current, chunksBySession)),
    })
    const unsubscribe = hostRuntime.kernel.project.onWorkbenchTerminalOutput((event) => {
      publishWorkbenchTerminalOutput(event.sessionId, event.chunk)
      runLog.append(event.sessionId, event.chunk)
      if (!event.closed) return
      runLog.flush()
      setTerminalSessions((current) => markWorkbenchTerminalSessionClosed(current, event.sessionId))
      setRunSessions((current) => markWorkbenchTerminalSessionClosed(current, event.sessionId))
    })

    return () => {
      unsubscribeRunOutput()
      unsubscribe()
      runLog.dispose()
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
