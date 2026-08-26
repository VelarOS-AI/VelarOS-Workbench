import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { delimiter } from 'node:path'
import { promisify } from 'node:util'

import { currentSystemPlatform as systemPlatformCompatibility } from '@velaros-ai/system/platform-compatibility'

import { WorkbenchCommandHelper } from '../../../main/workspace/CommandHelper'

const execFileAsync = promisify(execFile)
const LoginEnvironmentTimeoutMs = 5_000
let environmentPromise: Promise<NodeJS.ProcessEnv> | null = null

/** Electron 从 Finder 启动时没有交互式 shell 的 PATH；外部引擎统一从登录 shell 补齐。 */
export function getWorkbenchAgentEngineEnvironment(): Promise<NodeJS.ProcessEnv> {
  environmentPromise ??= readLoginEnvironment()
  return environmentPromise.then((environment) => ({ ...environment }))
}

export function shouldDetachAgentEngineProcess(): boolean {
  return systemPlatformCompatibility.shouldUseDetachedProcessGroup()
}

export function terminateAgentEngineProcessTree(
  pid: number | undefined,
  signal: NodeJS.Signals = 'SIGTERM'
): void {
  new WorkbenchCommandHelper().terminateForegroundProcess(pid, signal)
}

async function readLoginEnvironment(): Promise<NodeJS.ProcessEnv> {
  const base = { ...process.env }
  if (process.platform === 'win32') return base
  const shell = resolveShell()
  try {
    const { stdout } = await execFileAsync(shell, ['-ilc', 'env -0'], {
      encoding: 'buffer',
      maxBuffer: 2 * 1_024 * 1_024,
      timeout: LoginEnvironmentTimeoutMs,
    })
    const parsed = parseNullSeparatedEnvironment(stdout.toString('utf8'))
    return withCommonExecutableDirectories({ ...base, ...parsed })
  } catch {
    return withCommonExecutableDirectories(base)
  }
}

function resolveShell(): string {
  const configured = process.env.SHELL
  if (configured && existsSync(configured)) return configured
  return existsSync('/bin/zsh') ? '/bin/zsh' : '/bin/sh'
}

function parseNullSeparatedEnvironment(value: string): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {}
  for (const entry of value.split('\0')) {
    const separator = entry.indexOf('=')
    if (separator <= 0) continue
    environment[entry.slice(0, separator)] = entry.slice(separator + 1)
  }
  return environment
}

function withCommonExecutableDirectories(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const current = environment.PATH?.split(delimiter).filter(Boolean) ?? []
  const common = process.platform === 'darwin'
    ? ['/opt/homebrew/bin', '/usr/local/bin']
    : ['/usr/local/bin']
  environment.PATH = [...current, ...common]
    .filter((path, index, paths) => existsSync(path) && paths.indexOf(path) === index)
    .join(delimiter)
  return environment
}
