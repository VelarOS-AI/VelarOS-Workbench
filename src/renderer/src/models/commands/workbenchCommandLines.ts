import { isRecord } from '@velaros-ai/velaros/core/utils/unknownJsonRecord'

import {
  type WorkbenchNodeArguments,
  type WorkbenchPackageManagerTarget,
  type WorkbenchProcessTarget,
  type WorkbenchRunCommandOutputEvent,
} from '@shared/contracts/workbench'
import type { WorkbenchDebuggerLaunchTarget } from '@shared/workbenchDebugger'
import { readWorkbenchRunEnvironment } from '@shared/workbenchRunEnvironment'

/** 显示文本和真实启动条件一起传递；生成的显示文本不能再当 shell 源码执行。 */
export interface WorkbenchRunCommand {
  command: string
  label?: string
  launch?: WorkbenchRunSessionLaunchOptions
}

export interface WorkbenchTerminalSessionView {
  id: string
  title: string
  shell: string
  /** 启动目录；shell 自己的提示符跟随真实目录，这里只记起点。 */
  cwd: string
  isRunning: boolean
  /** 运行卡显示的命令；真实 process 由 launch 保存，普通终端会话为 undefined。 */
  command?: string
  /** 运行卡才有：命令之外的启动条件（工作目录、环境变量、出自哪份运行配置），「重启」时照旧。 */
  launch?: WorkbenchRunSessionLaunchOptions
}

/** 运行卡的启动目标与条件；不给 process 时 command 是用户的 shell 原文。 */
export interface WorkbenchRunSessionLaunchOptions {
  /** 程序生成的启动目标；不给时 command 才是用户输入的 shell 原文。 */
  process?: WorkbenchProcessTarget
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

function displayArgument(value: string): string {
  return /^[\w./:=@-]+$/u.test(value) ? value : JSON.stringify(value)
}

/** 仅供卡片与菜单显示，不是交给 shell 的转义器。 */
export function describeWorkbenchProcessTarget(process: WorkbenchProcessTarget): string {
  if (process.kind === 'package-manager')
    return [process.program, ...process.argv.map(displayArgument)].join(' ')

  if (process.kind === 'python-script')
    return ['python3', displayArgument(process.script), ...process.argv.map(displayArgument)].join(' ')

  const script =
    process.kind === 'node-package-bin' ? process.binName ?? process.packageName : process.script
  const prefix = `node ${displayArgument(script)}`
  if (process.argv) return [prefix, ...process.argv.map(displayArgument)].join(' ')
  return process.args ? `${prefix} ${process.args}` : prefix
}

export function buildWorkbenchProcessRunCommand(
  process: WorkbenchProcessTarget,
  launch: Omit<WorkbenchRunSessionLaunchOptions, 'process'> = {}
): WorkbenchRunCommand {
  const command = describeWorkbenchProcessTarget(process)
  return {
    command: launch.cwd ? `cd ${displayArgument(launch.cwd)} && ${command}` : command,
    launch: { ...launch, process },
  }
}

function processIdentity(process: WorkbenchProcessTarget): unknown[] {
  if (process.kind === 'package-manager') return [process.kind, process.program, process.argv]
  if (process.kind === 'python-script') return [process.kind, process.script, process.argv]
  const entry =
    process.kind === 'node-script'
      ? [process.kind, process.script]
      : [process.kind, process.packageName, process.binName ?? null]
  return [...entry, process.argv ? ['argv', process.argv] : ['args', process.args]]
}

/** 同一显示文本的 shell 与 argv、不同工作目录不能互相冒充运行卡或菜单项。 */
export function workbenchRunCommandKey(
  command: string,
  launch?: WorkbenchRunSessionLaunchOptions
): string {
  const target = launch?.debug?.target
  const debug =
    target?.kind === 'inspect-process'
      ? [target.kind, processIdentity(target.process)]
      : target?.kind === 'inspect-command'
        ? [target.kind, target.command]
        : target ? processIdentity(target) : null
  return JSON.stringify([
    launch?.configurationId ?? null,
    debug ?? (launch?.process ? processIdentity(launch.process) : ['shell', command]),
    launch?.cwd ?? '',
    Object.entries(launch?.env ?? {}).sort(([left], [right]) => left.localeCompare(right)),
  ])
}

/** 已保存的生成启动项只接受完整目标；坏元数据不能降级成执行显示字符串。 */
export function readWorkbenchGeneratedRunLaunch(
  value: unknown
): Nullable<WorkbenchRunSessionLaunchOptions> {
  if (!isRecord(value) || !isRecord(value.process)) return null
  const input = value.process
  const argv =
    Array.isArray(input.argv) && input.argv.every((argument) => typeof argument === 'string')
      ? [...input.argv] as string[]
      : null
  let process: WorkbenchProcessTarget
  if (input.kind === 'package-manager') {
    if (
      typeof input.program !== 'string' ||
      !['bun', 'bunx', 'npm', 'npx', 'pnpm', 'yarn'].includes(input.program) ||
      !argv
    )
      return null
    process = {
      kind: input.kind,
      program: input.program as WorkbenchPackageManagerTarget['program'],
      argv,
    }
  } else if (input.kind === 'python-script') {
    if (typeof input.script !== 'string' || !input.script || !argv) return null
    process = { kind: input.kind, script: input.script, argv }
  } else if (input.kind === 'node-script' || input.kind === 'node-package-bin') {
    const arguments_: Nullable<WorkbenchNodeArguments> =
      argv && input.args === undefined
        ? { argv }
        : typeof input.args === 'string' && input.argv === undefined ? { args: input.args } : null
    if (!arguments_) return null
    if (input.kind === 'node-script') {
      if (typeof input.script !== 'string' || !input.script) return null
      process = { kind: input.kind, script: input.script, ...arguments_ }
    } else {
      if (typeof input.packageName !== 'string' || !input.packageName) return null
      if (input.binName !== undefined && typeof input.binName !== 'string') return null
      process = { kind: input.kind, packageName: input.packageName, ...arguments_ }
      if (typeof input.binName === 'string') process.binName = input.binName
    }
  } else return null

  if (value.cwd !== undefined && typeof value.cwd !== 'string') return null
  const env = value.env === undefined ? undefined : readWorkbenchRunEnvironment(value.env)
  if (env === null) return null
  const launch: WorkbenchRunSessionLaunchOptions = { process }
  if (typeof value.cwd === 'string' && value.cwd) launch.cwd = value.cwd
  if (env) launch.env = env
  return launch
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
