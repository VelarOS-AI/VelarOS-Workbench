import { spawn } from 'node:child_process'

import { optionalWhen } from '@velaros-ai/core'
import { logRuntime } from '@velaros-ai/core/logger'
import { SystemPlatformCompatibility } from '@velaros-ai/system/platform-compatibility'

type ExternalLspProcessTreeTerminationPlan =
  | {
      kind: 'command'
      file: string
      args: string[]
    }
  | {
      kind: 'signal'
      pid: number
      fallbackPid?: number
      signal: NodeJS.Signals
    }

/** SIGTERM 之后留给语言服务器清理索引缓存/临时文件的时间，超时才升级到 SIGKILL。 */
const TerminationEscalationMs = 1_000
/** SIGKILL 之后确认进程已退出的有界等待，使 POSIX 信号升级路径低于 5 秒关闭预算。 */
const TerminationKillConfirmationMs = 1_000
/** 探测进程是否已退出的轮询间隔。 */
const TerminationPollIntervalMs = 25
/** 进程树终止命令（taskkill）自身的兜底超时，避免 await 把关闭流程永久挂住。 */
const TerminationCommandTimeoutMs = 5_000

const log = logRuntime.tag('ExternalLspProcessLifecycle')
const currentPlatform = new SystemPlatformCompatibility()

function shouldDetachExternalLspProcess(
  platform: NodeJS.Platform = process.platform
): boolean {
  return new SystemPlatformCompatibility({ platform }).shouldUseDetachedProcessGroup()
}

function buildExternalLspProcessTreeTerminationPlan(
  pid: number,
  signal: NodeJS.Signals,
  platform: NodeJS.Platform = process.platform
): ExternalLspProcessTreeTerminationPlan {
  const compatibility = new SystemPlatformCompatibility({ platform })
  const command = compatibility.getProcessTreeKillCommandSpec(pid, signal)
  if (command) return { kind: 'command', file: command.file, args: command.args }

  const killPid = compatibility.getProcessKillPid(pid)
  return {
    kind: 'signal',
    pid: killPid,
    fallbackPid: optionalWhen(killPid !== pid, pid),
    signal,
  }
}

/**
 * 进程是否仍然存活。
 *
 * `EPERM` 表示进程存在但不属于本用户，仍算存活；只有"进程不存在"才是死亡判据。
 */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return !currentPlatform.isProcessMissingError(error)
  }
}

async function waitForProcessExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return true
    await new Promise((resolve) => {
      setTimeout(resolve, TerminationPollIntervalMs)
    })
  }
  return !isProcessAlive(pid)
}

/** 异步执行平台的进程树终止命令；主进程不阻塞，但调用方仍可 await 到它结束。 */
async function runTerminationCommand(file: string, args: string[]): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const child = spawn(file, args, { stdio: 'ignore', windowsHide: true })
    const timer = setTimeout(() => child.kill('SIGKILL'), TerminationCommandTimeoutMs)
    const settle = (value: boolean): void => {
      clearTimeout(timer)
      resolve(value)
    }
    child.once('error', (error) => {
      log.warn('failed to run external LSP process tree termination command', { file, error })
      settle(false)
    })
    child.once('close', (code) => settle(code === 0))
  })
}

async function deliverTermination(pid: number, signal: NodeJS.Signals): Promise<boolean> {
  const plan = buildExternalLspProcessTreeTerminationPlan(pid, signal)
  if (plan.kind === 'command') return runTerminationCommand(plan.file, plan.args)

  try {
    process.kill(plan.pid, plan.signal)
    return true
  } catch (groupError) {
    // 进程组不存在（detached 没生效）时才退回杀单进程；两者是同一个 pid 说明就是单进程失败。
    if (plan.fallbackPid === undefined) return reportTerminationFailure(pid, signal, groupError)
    try {
      process.kill(plan.fallbackPid, plan.signal)
      return true
    } catch (processError) {
      return reportTerminationFailure(pid, signal, processError)
    }
  }
}

/** ESRCH 属于正常竞态（进程自己退了）；其它 errno（EPERM、命令缺失）必须留下可观测信号。 */
function reportTerminationFailure(pid: number, signal: NodeJS.Signals, error: unknown): boolean {
  if (currentPlatform.isProcessMissingError(error)) return false
  log.warn('failed to terminate external LSP process tree', { pid, signal, error })
  return false
}

/**
 * 语言服务器可能经 .cmd 或运行时再派生子进程，关闭时必须收完整棵树。
 *
 * 三条判据：
 * 1. **异步执行**：终止时机正是关闭工作区/退出应用，同步 `execFileSync`（Windows 上是
 *    `taskkill /T`，进程树大时数百毫秒）会整段冻结 Electron 主进程。调用方 `await`
 *    即可保住"确认杀完再继续"的顺序保证，代价不再落在主线程上。
 * 2. **先探活再动手**：pid 可能已在 LSP 关闭握手与终止动作之间自然退出并被系统回收，
 *    而 POSIX 上终止目标是整个进程组，误杀的是一整组无关进程。
 * 3. **信号升级阶梯**：先 SIGTERM 给服务器清理索引缓存/临时文件的机会，超时才 SIGKILL。
 */
async function terminateExternalLspProcessTree(
  pid: number | undefined,
  signal: NodeJS.Signals = 'SIGTERM'
): Promise<boolean> {
  if (!pid) return false
  if (!isProcessAlive(pid)) return false

  const delivered = await deliverTermination(pid, signal)
  if (signal === 'SIGKILL')
    return delivered
      ? waitForProcessExit(pid, TerminationKillConfirmationMs)
      : !isProcessAlive(pid)
  if (delivered && await waitForProcessExit(pid, TerminationEscalationMs)) return true

  const killed = await deliverTermination(pid, 'SIGKILL')
  if (!killed) return !isProcessAlive(pid)
  return waitForProcessExit(pid, TerminationKillConfirmationMs)
}

export {
  buildExternalLspProcessTreeTerminationPlan,
  shouldDetachExternalLspProcess,
  terminateExternalLspProcessTree,
}
export type { ExternalLspProcessTreeTerminationPlan }
