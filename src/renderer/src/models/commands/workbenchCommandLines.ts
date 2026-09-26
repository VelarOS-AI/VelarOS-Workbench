import type { WorkbenchRunCommandOutputEvent } from '@shared/contracts'

export interface WorkbenchTerminalSessionView {
  id: string
  title: string
  shell: string
  /** 启动目录；shell 自己的提示符跟随真实目录，这里只记起点。 */
  cwd: string
  isRunning: boolean
  /** 运行卡才有：启动该会话的命令，用于「重启」；普通终端会话为 undefined。 */
  command?: string
}

export interface WorkbenchRunOutputLine {
  id: string
  runId: string
  stream: WorkbenchRunCommandOutputEvent['stream']
  text: string
  createdAt: number
}

export function formatRunDuration(durationMs: number): string {
  if (durationMs < 1000) return `${durationMs}ms`

  return `${(durationMs / 1000).toFixed(1)}s`
}

export function createRunOutputLine(
  runId: string,
  stream: WorkbenchRunOutputLine['stream'],
  text: string
): WorkbenchRunOutputLine {
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    runId,
    stream,
    text,
    createdAt: Date.now(),
  }
}
