import { type ChildProcess, type ChildProcessByStdio, spawn } from 'node:child_process'
import { rm } from 'node:fs/promises'
import type { Readable } from 'node:stream'

import { currentPlatform } from '@velaros-ai/velaros/core/platform'

import {
  shouldDetachExternalLspProcess,
  terminateExternalLspProcessTree,
} from '../../src/main/workspace/language/ExternalLspProcessLifecycle'
import {
  ExternalLspTerminationReserveMs,
  withinLspDeadline,
} from '../../src/main/workspace/language/ExternalLspTransport'

/** 与独立测试 runner 的单文件预算相同；关闭余量从中扣除，不另加等待预算。 */
const CommandBudgetMs = 120_000
/** 沿用前台命令的输出上限；截断必须使验收失败，不能把半截 JSON 当完整结果。 */
const OutputChars = 50_000

interface OwnedCommand {
  child: ChildProcessByStdio<null, Readable, Readable>
  closed: Promise<{ code: number | null; signal: NodeJS.Signals | null }>
  didClose: boolean
  deadlineAt: number
  groupOwned: boolean
  stopping?: Promise<void>
}

interface SessionDependencies {
  spawn: typeof spawn
  released(command: OwnedCommand): boolean
  stop(command: OwnedCommand, terminationCommands: Map<ChildProcess, Promise<void>>): Promise<void>
  remove(directory: string): Promise<void>
}

/** 只拥有本次验收的命令、信号与临时目录；语言服务仍由原 launcher 负责。 */
export class InstalledToolchainSession {
  private readonly cancellation = new AbortController()
  private readonly commands = new Set<OwnedCommand>()
  private readonly terminationCommands = new Map<ChildProcess, Promise<void>>()
  private closing = false

  public constructor(
    private readonly temporary: string,
    private readonly dependencies: SessionDependencies = {
      spawn,
      released: commandReleased,
      stop: stopCommand,
      remove: (directory) => rm(directory, { recursive: true, force: true }),
    },
    private readonly budgetMs = CommandBudgetMs,
    private readonly reserveMs = ExternalLspTerminationReserveMs
  ) {
    if (!Number.isFinite(budgetMs) || budgetMs <= reserveMs || reserveMs <= 0)
      throw new Error('Command budget must include a positive termination reserve')
  }

  public get signal(): AbortSignal {
    return this.cancellation.signal
  }

  public abort(reason: unknown): void {
    this.cancellation.abort(reason)
  }

  public async run(
    command: string,
    arguments_: readonly string[],
    cwd: string,
    env: NodeJS.ProcessEnv = process.env
  ): Promise<{ stdout: string; stderr: string }> {
    this.signal.throwIfAborted()
    if (this.closing) throw new Error('Installed toolchain session is closing')
    const deadlineAt = Date.now() + this.budgetMs
    const child = this.dependencies.spawn(command, [...arguments_], {
      cwd,
      env,
      detached: shouldDetachExternalLspProcess(),
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let owned!: OwnedCommand
    let rejectFailure!: (reason: unknown) => void
    const failure = new Promise<never>((_resolve, reject) => {
      rejectFailure = reject
    })
    const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve) => {
        child.once('error', rejectFailure)
        child.once('close', (code, signal) => {
          owned.didClose = true
          resolve({ code, signal })
        })
      }
    )
    owned = {
      child,
      closed,
      didClose: false,
      deadlineAt,
      groupOwned: shouldDetachExternalLspProcess(),
    }
    this.commands.add(owned)
    const output = { stdout: '', stderr: '' }
    for (const stream of ['stdout', 'stderr'] as const) {
      child[stream].setEncoding('utf8')
      child[stream].on('error', rejectFailure)
      child[stream].on('data', (chunk: string) => {
        const text = output[stream] + chunk
        output[stream] = text.slice(-OutputChars)
        if (text.length > OutputChars)
          rejectFailure(new Error(`${command} ${stream} exceeded ${OutputChars} characters`))
      })
    }
    const onAbort = (): void => rejectFailure(this.signal.reason)
    this.signal.addEventListener('abort', onAbort, { once: true })
    try {
      if (this.signal.aborted) onAbort()
      const exit = await withinLspDeadline(
        Promise.race([closed, failure]),
        deadlineAt - this.reserveMs
      )
      this.signal.throwIfAborted()
      if (!this.dependencies.released(owned))
        throw new Error('Command exited with a live process group')
      if (exit.code !== 0) throw new Error(`Command exited with ${exit.signal ?? exit.code}`)
      return output
    } catch (error) {
      let cleanupFailed = false
      let cleanupFailure: unknown
      try {
        await this.stop(owned)
      } catch (cleanupError) {
        cleanupFailed = true
        cleanupFailure = cleanupError
      }
      const primary = new Error(
        `${command} ${arguments_.join(' ')} failed\n${output.stdout}\n${output.stderr}`,
        { cause: error }
      )
      if (cleanupFailed)
        throw new AggregateError(
          [primary, cleanupFailure],
          'Command failed and its resources remain owned'
        )
      throw primary
    } finally {
      this.signal.removeEventListener('abort', onAbort)
      if (this.dependencies.released(owned)) this.commands.delete(owned)
    }
  }

  /** 原错误和清理错误分别保留；未确认资源退出时，不删除其工作目录。 */
  public async finish(input: {
    failed: boolean
    failure?: unknown
    disposeLanguageServices?: () => Promise<void>
    unregister?: () => void
  }): Promise<void> {
    this.closing = true
    const errors: unknown[] = input.failed ? [input.failure] : []
    const results = await Promise.allSettled([
      this.closeCommands(),
      Promise.resolve().then(() => input.disposeLanguageServices?.()),
    ])
    let released = true
    for (const result of results)
      if (result.status === 'rejected') {
        errors.push(result.reason)
        released = false
      }
    try {
      input.unregister?.()
    } catch (error) {
      errors.push(error)
    }
    if (released) {
      try {
        await this.dependencies.remove(this.temporary)
      } catch (error) {
        errors.push(error)
      }
    } else
      errors.push(
        new Error(`Resources remain owned; retained temporary directory: ${this.temporary}`)
      )
    if (!input.failed && this.signal.aborted) errors.unshift(this.signal.reason)
    if (errors.length === 1) throw errors[0]
    if (errors.length > 1)
      throw new AggregateError(errors, 'Installed toolchain acceptance or cleanup failed')
  }

  private stop(command: OwnedCommand): Promise<void> {
    if (this.dependencies.released(command)) return Promise.resolve()
    command.stopping ??= this.dependencies.stop(command, this.terminationCommands)
    return command.stopping
  }

  private async closeCommands(): Promise<void> {
    const results = await Promise.allSettled(
      [...this.commands].map((command) => this.stop(command))
    )
    for (const command of this.commands)
      if (this.dependencies.released(command)) this.commands.delete(command)
    const errors = results.flatMap((result) =>
      result.status === 'rejected' ? [result.reason] : []
    )
    if (this.commands.size || this.terminationCommands.size)
      errors.push(new Error('Command resources have not closed'))
    if (errors.length)
      throw new AggregateError(errors, 'Installed toolchain commands did not close')
  }
}

/** 只把 ESRCH 当作消失；EPERM 等错误不能释放进程组所有权。 */
function commandReleased(command: OwnedCommand): boolean {
  if (!command.didClose) return false
  if (!command.child.pid || !command.groupOwned) return true
  try {
    process.kill(-command.child.pid, 0)
    return false
  } catch (error) {
    if (!currentPlatform.isProcessMissingError(error)) return false
    command.groupOwned = false
    return true
  }
}

async function stopCommand(
  command: OwnedCommand,
  terminationCommands: Map<ChildProcess, Promise<void>>
): Promise<void> {
  const { child, deadlineAt } = command
  // 已经退出的 Windows 根 PID 不再发信号，避免误伤复用 PID；未 close 的管道仍保留 owner。
  if (child.exitCode === null && child.signalCode === null)
    await terminateExternalLspProcessTree(child.pid, 'SIGTERM', deadlineAt, terminationCommands)
  if (command.groupOwned && child.pid && !commandReleased(command)) {
    try {
      process.kill(-child.pid, 'SIGKILL')
    } catch (error) {
      if (!currentPlatform.isProcessMissingError(error)) throw error
    }
  }
  await withinLspDeadline(command.closed, deadlineAt)
  while (!commandReleased(command)) {
    await withinLspDeadline(new Promise<void>((resolve) => setTimeout(resolve, 25)), deadlineAt)
  }
  await withinLspDeadline(Promise.all([...terminationCommands.values()]), deadlineAt)
}
