import type { WorkbenchRunCommandOutputEvent } from '@shared/contracts'
import type { WorkbenchDebuggerLaunchTarget } from '@shared/workbenchDebugger'

export interface WorkbenchTerminalSessionView {
  id: string
  title: string
  shell: string
  /** 启动目录；shell 自己的提示符跟随真实目录，这里只记起点。 */
  cwd: string
  isRunning: boolean
  /** 运行卡才有：启动该会话的命令，用于「重启」；普通终端会话为 undefined。 */
  command?: string
  /** 运行卡才有：命令之外的启动条件（工作目录、环境变量、出自哪份运行配置），「重启」时照旧。 */
  launch?: WorkbenchRunSessionLaunchOptions
  /** 拆分出来的终端才有：同一个标签里并排的几个共用一个组号。没有就是自己一组（组号即自己的 id）。 */
  groupId?: string
  /** 并排时占的宽度份额（同组里按比例分）；没有就是 1。 */
  paneWeight?: number
}

/** 起一张运行卡时命令之外的条件；都不给就是在项目根、用终端自己的环境跑。 */
export interface WorkbenchRunSessionLaunchOptions {
  /** 工作目录：项目里的相对路径。 */
  cwd?: string
  /** 盖在终端环境之上的环境变量。 */
  env?: Record<string, string>
  /** 由用户建的哪份运行配置起的（▶ 据此认出「这份配置正在跑」）。 */
  configurationId?: string
  /**
   * 这张卡是一次调试：程序由调试器带着检查器起（起什么见 `target`），不是直接在终端里跑命令。卡片照旧是
   * 一个终端会话，输出、停止、重启都一样；重启时重新起一次调试。
   */
  debug?: { target: WorkbenchDebuggerLaunchTarget }
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
