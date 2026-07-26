import type {
  WorkbenchRunCommandOutputEvent,
  WorkbenchTerminalOutputEvent,
} from '../../contracts/index'

export interface WorkbenchTerminalLine {
  id: string
  stream: WorkbenchTerminalOutputEvent['stream'] | 'input'
  text: string
  createdAt: number
}

export interface WorkbenchTerminalSessionView {
  id: string
  title: string
  shell: string
  cwd: string
  input: string
  lines: WorkbenchTerminalLine[]
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

export function createTerminalLine(
  stream: WorkbenchTerminalLine['stream'],
  text: string
): WorkbenchTerminalLine {
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    stream,
    text,
    createdAt: Date.now(),
  }
}
