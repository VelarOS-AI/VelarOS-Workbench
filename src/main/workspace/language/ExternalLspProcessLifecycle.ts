import { type ChildProcess, spawn } from 'node:child_process'

import { optionalWhen } from '@velaros-ai/velaros/core'
import { AppError } from '@velaros-ai/velaros/core/error'
import { logRuntime } from '@velaros-ai/velaros/core/logger'
import { createPlatform } from '@velaros-ai/velaros/core/platform'

import { withinLspDeadline } from './ExternalLspTransport'

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
const currentPlatform = createPlatform()
/** taskkill 自身也是 main 持有的资源；超时拒绝也不丢掉未 close 的命令。 */
const terminationCommands = new Map<ChildProcess, Promise<void>>()

function shouldDetachExternalLspProcess(platform: NodeJS.Platform = process.platform): boolean {
  return createPlatform({ platform }).shouldUseDetachedProcessGroup()
}

function buildExternalLspProcessTreeTerminationPlan(
  pid: number,
  signal: NodeJS.Signals,
  platform: NodeJS.Platform = process.platform
): ExternalLspProcessTreeTerminationPlan {
  const compatibility = createPlatform({ platform })
  const command = compatibility.getProcessTreeKillCommandSpec(pid, signal)
  if (command) return { kind: 'command', file: command.file, args: command.args }

  const killPid = compatibility.shouldUseDetachedProcessGroup() ? -pid : pid
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
async function runTerminationCommand(
  file: string,
  args: string[],
  deadlineAt: number,
  ownedCommands?: Map<ChildProcess, Promise<void>>
): Promise<boolean> {
  const child = spawn(file, args, { stdio: 'ignore', windowsHide: true })
  let failed = false
  let exitCode: number | null = null
  const closed = new Promise<void>((resolve) => {
    child.once('error', (error) => {
      failed = true
      log.warn('failed to run external LSP process tree termination command', { file, error })
    })
    child.once('close', (code) => {
      exitCode = code
      terminationCommands.delete(child)
      ownedCommands?.delete(child)
      resolve()
    })
  })
  terminationCommands.set(child, closed)
  ownedCommands?.set(child, closed)
  const until = Math.min(deadlineAt, Date.now() + TerminationCommandTimeoutMs)
  try {
    await withinLspDeadline(closed, until)
    return !failed && exitCode === 0
  } catch (error) {
    child.kill('SIGKILL')
    throw error
  }
}

async function deliverTermination(
  pid: number,
  signal: NodeJS.Signals,
  deadlineAt: number,
  ownedCommands?: Map<ChildProcess, Promise<void>>
): Promise<boolean> {
  if (Date.now() >= deadlineAt)
    throw new AppError('TIMEOUT', 'Language server termination timed out')
  const plan = buildExternalLspProcessTreeTerminationPlan(pid, signal)
  if (plan.kind === 'command')
    return runTerminationCommand(plan.file, plan.args, deadlineAt, ownedCommands)

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
  signal: NodeJS.Signals = 'SIGTERM',
  deadlineAt = Date.now() + TerminationCommandTimeoutMs,
  ownedCommands?: Map<ChildProcess, Promise<void>>
): Promise<boolean> {
  if (!pid) return false
  if (!isProcessAlive(pid)) return false

  const delivered = await deliverTermination(pid, signal, deadlineAt, ownedCommands)
  if (signal === 'SIGKILL')
    return delivered
      ? waitForProcessExit(
          pid,
          Math.min(TerminationKillConfirmationMs, Math.max(0, deadlineAt - Date.now()))
        )
      : !isProcessAlive(pid)
  if (
    delivered &&
    (await waitForProcessExit(
      pid,
      Math.min(TerminationEscalationMs, Math.max(0, deadlineAt - Date.now()))
    ))
  )
    return true

  const killed = await deliverTermination(pid, 'SIGKILL', deadlineAt, ownedCommands)
  if (!killed) return !isProcessAlive(pid)
  return waitForProcessExit(
    pid,
    Math.min(TerminationKillConfirmationMs, Math.max(0, deadlineAt - Date.now()))
  )
}

export {
  buildExternalLspProcessTreeTerminationPlan,
  shouldDetachExternalLspProcess,
  terminateExternalLspProcessTree,
}
export type { ExternalLspProcessTreeTerminationPlan }
