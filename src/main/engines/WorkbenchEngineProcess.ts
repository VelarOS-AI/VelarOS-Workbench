import { type ChildProcessWithoutNullStreams, execFile, spawn } from 'node:child_process'
import { access, constants } from 'node:fs/promises'
import { homedir } from 'node:os'
import { delimiter, extname, isAbsolute, join } from 'node:path'

import { Log } from '@velaros-ai/velaros/core'
import { AppError } from '@velaros-ai/velaros/core/error'
import { type CommandSpec, currentPlatform } from '@velaros-ai/velaros/core/platform'

import type {
  WorkbenchAgentEngineId,
  WorkbenchAgentEngineStatus,
} from '../../shared/workbenchConversation'
import { workbenchMainText } from '../i18n/workbenchMainMessages'
import { WorkbenchCommandHelper } from '../workspace/CommandHelper'

const log = Log.tag('WorkbenchEngineProcess')

/** 进程是怎么结束的（「被信号 SIGTERM 结束」「退出码 1」），拼进「已退出」的提示里。 */
export function describeEngineExitStatus(
  code: Nullable<number>,
  signal: Nullable<NodeJS.Signals>
): string {
  return signal
    ? workbenchMainText('engines.exitedBySignal', { signal })
    : workbenchMainText('engines.exitedWithCode', { code: String(code) })
}

/** 引擎命令行起在登录 shell 的环境里：从 Finder 打开的应用只有最小的 PATH，找不到用户装的命令行。 */
export interface WorkbenchEngineEnvironmentSource {
  getEnvironment(signal?: AbortSignal): Promise<NodeJS.ProcessEnv>
}

/** 引擎命令行的位置与起它的环境。 */
export interface WorkbenchEngineCommand {
  executable: string
  env: NodeJS.ProcessEnv
}

/** 常见的命令行安装目录：登录 shell 没放进 PATH 时补在最后（Claude Code、Codex 的安装脚本默认装到 ~/.local/bin）。 */
function commonExecutableDirectories(): string[] {
  const directories = [join(homedir(), '.local', 'bin')]
  if (process.platform === 'darwin') directories.push('/opt/homebrew/bin', '/usr/local/bin')
  else if (process.platform !== 'win32') directories.push('/usr/local/bin')
  return directories
}

/**
 * 找到引擎命令行：登录 shell 的 PATH 加上常见安装目录。找不到时报「没装」，原因给用户看。读登录环境失败
 * 就退回应用自己的环境，不拦这一次。
 */
export async function resolveEngineCommand(
  source: WorkbenchEngineEnvironmentSource,
  name: string,
  label: string,
  signal?: AbortSignal
): Promise<WorkbenchEngineCommand> {
  let env: NodeJS.ProcessEnv
  try {
    env = await source.getEnvironment(signal)
  } catch (error) {
    signal?.throwIfAborted()
    log.warn('读不到登录 shell 环境，按应用自己的环境找引擎', { error: AppError.getMessage(error) })
    env = { ...process.env }
  }
  const path = [
    ...new Set([
      ...(env.PATH ?? '').split(delimiter).filter(Boolean),
      ...commonExecutableDirectories(),
    ]),
  ].join(delimiter)
  env.PATH = path
  const executable = await findExecutable(name, env)
  if (!executable)
    throw new AppError('NOT_FOUND', workbenchMainText('engines.commandNotFound', { label, name }))
  return { executable, env }
}

async function findExecutable(name: string, env: NodeJS.ProcessEnv): Promise<Nullable<string>> {
  const extensions =
    process.platform === 'win32'
      ? (env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';').filter(Boolean)
      : ['']
  for (const directory of (env.PATH ?? '').split(delimiter)) {
    if (!directory || !isAbsolute(directory)) continue
    for (const extension of extensions) {
      const candidate = join(directory, `${name}${extension.toLowerCase()}`)
      try {
        await access(candidate, constants.X_OK)
        return candidate
      } catch {
        // 这个目录里没有，接着找。
      }
    }
  }
  return null
}

/**
 * 起引擎的子进程：独立进程组（停下时连同它起的命令一起结束），stdin / stdout / stderr 全走管道。Windows 上
 * npm 装的是 .cmd 包装，得经 shell 起。
 */
export function spawnEngineProcess(
  command: WorkbenchEngineCommand,
  args: readonly string[],
  cwd: string
): ChildProcessWithoutNullStreams {
  const spec = engineCommandSpec(command, args)
  return spawn(spec.file, spec.args, {
    cwd,
    env: engineEnvironment(command.env),
    detached: new WorkbenchCommandHelper().shouldDetachForegroundProcess(),
    windowsVerbatimArguments: spec.windowsVerbatimArguments,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  })
}

/** npm 的 CMD 包装需要保留路径与各参数的边界，不能让 spawn 的 shell 选项直接拼接。 */
function engineCommandSpec(command: WorkbenchEngineCommand, args: readonly string[]): CommandSpec {
  if (process.platform !== 'win32' || !/^\.(?:cmd|bat)$/iu.test(extname(command.executable)))
    return { file: command.executable, args: [...args] }

  const shellCommand = [command.executable, ...args]
    .map((value) => currentPlatform.quoteShellArg(value, { kind: 'cmd' }))
    .join(' ')
  return currentPlatform.getShellCommandSpec(shellCommand, {
    shellPath: command.env.ComSpec ?? command.env.COMSPEC ?? 'cmd.exe',
    kind: 'cmd',
  })
}

/** 探引擎失败时的结论：找不到命令行算没装，其余原样说明。 */
export function engineFailure(
  id: WorkbenchAgentEngineId,
  error: unknown
): WorkbenchAgentEngineStatus {
  return {
    id,
    available: false,
    problem: AppError.from(error).code === 'NOT_FOUND' ? 'missing' : 'error',
    reason: AppError.getMessage(error),
    models: [],
  }
}

/** 引擎起它自己的子进程时不该看到的宿主标记：从另一个 Claude Code 会话里打开 Workbench 时，命令行会以为自己被嵌套。 */
const NestedSessionVariables = ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT']

/** 起引擎用的环境：去掉嵌套会话标记。 */
export function engineEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const next = { ...env }
  for (const name of NestedSessionVariables) delete next[name]
  return next
}

/** 跑一条一次性的引擎子命令（查登录之类），读完输出为止；超时或取消就停下。 */
export function runEngineCommand(
  command: WorkbenchEngineCommand,
  args: readonly string[],
  options: { cwd: string; timeoutMs: number; signal?: AbortSignal }
): Promise<{ code: Nullable<number>; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const spec = engineCommandSpec(command, args)
    execFile(
      spec.file,
      spec.args,
      {
        cwd: options.cwd,
        env: engineEnvironment(command.env),
        timeout: options.timeoutMs,
        signal: options.signal,
        maxBuffer: 1_024 * 1_024,
        windowsHide: true,
        windowsVerbatimArguments: spec.windowsVerbatimArguments,
      },
      (error, stdout, stderr) => {
        if (error && typeof (error as { code?: unknown }).code !== 'number') {
          reject(error)
          return
        }
        resolve({
          code: error ? ((error as { code?: number }).code ?? null) : 0,
          stdout: String(stdout),
          stderr: String(stderr),
        })
      }
    )
  })
}

/** 等一件事，最多等这么久；超时或取消时抛错（事情本身由调用方收拾）。 */
export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
  signal?: AbortSignal
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  let abort: (() => void) | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new AppError('TIMEOUT', message)), timeoutMs)
        abort = () =>
          reject(
            signal?.reason ?? new AppError('CANCELLED', workbenchMainText('engines.cancelled'))
          )
        signal?.addEventListener('abort', abort, { once: true })
      }),
    ])
  } finally {
    clearTimeout(timer)
    if (abort) signal?.removeEventListener('abort', abort)
  }
}

/** 停下引擎进程连同它起的命令：先礼后兵，给它一秒收尾。 */
export function terminateEngineProcess(child: ChildProcessWithoutNullStreams): void {
  if (child.exitCode !== null || child.signalCode !== null) return
  const helper = new WorkbenchCommandHelper()
  helper.terminateForegroundProcess(child.pid, 'SIGTERM')
  const timer = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null)
      helper.terminateForegroundProcess(child.pid, 'SIGKILL')
  }, helper.getForceKillDelayMs())
  timer.unref()
  child.once('exit', () => clearTimeout(timer))
}
