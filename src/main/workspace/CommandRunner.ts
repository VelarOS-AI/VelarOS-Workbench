/** Workbench 前台命令执行：有界增量输出、超时/取消与进程组清理。 */
import { spawn } from 'node:child_process'
import { stat } from 'node:fs/promises'
import { isAbsolute, resolve as resolvePath } from 'node:path'
import { StringDecoder } from 'node:string_decoder'

import { AppError } from '@velaros-ai/velaros/core/error'
import { type TimerLease, TimerScope } from '@velaros-ai/velaros/core/utils/TimerScope'

import {
  type WorkbenchRunCommandOutputEvent,
  type WorkbenchRunCommandRequest,
  type WorkbenchRunCommandResult,
} from '@shared/contracts/workbench'

import { workbenchMainText } from '../i18n/workbenchMainMessages'

import type { CommandHelper } from './CommandHelper'
import { getRelativePathInsideRoot } from './PathContainmentHelper'
import type { PathResolver } from './PathResolver'

const DEFAULT_COMMAND_OUTPUT_CHARS = 8_000

class CommandRunner {
  constructor(
    private readonly pathResolver: PathResolver,
    private readonly commandHelper: CommandHelper
  ) {}

  /**
   * @param allowDangerous 用户已经确认过这条命令：命令就是用户自己在命令面板里输入的。不传的调用方遇到
   *   危险命令在这里被挡回。
   */
  public async runCommand(
    request: WorkbenchRunCommandRequest,
    onOutput?: (event: WorkbenchRunCommandOutputEvent) => void,
    abortSignal?: AbortSignal,
    allowDangerous = false
  ): Promise<WorkbenchRunCommandResult> {
    abortSignal?.throwIfAborted()
    const projectRoot = await this.pathResolver.resolveProjectRoot(request.projectRoot)
    // A project root may be an alias (for example /var -> /private/var on macOS). Translate
    // absolute cwd paths under that same requested root before checking canonical containment.
    const relativeCwd =
      request.cwd && isAbsolute(request.cwd)
        ? getRelativePathInsideRoot(request.projectRoot, request.cwd)
        : null
    const cwd = relativeCwd !== null ? resolvePath(projectRoot, relativeCwd) : (request.cwd ?? '.')
    const cwdPath = await this.pathResolver.resolveInsideProject(projectRoot, cwd)
    const cwdStats = await stat(cwdPath.realPath)
    if (!cwdStats.isDirectory()) {
      throw new AppError('VALIDATION', workbenchMainText('commands.cwdNotFolder'))
    }

    // 工作区边界用调用方给的原始根：与它问用户前的判定同一个输入，两层结论才不会因符号链接而分叉。
    const command = this.commandHelper.validateCommand(
      request.command,
      request.projectRoot,
      allowDangerous
    )
    const timeoutMs = this.commandHelper.normalizeTimeoutMs(request.timeoutMs)
    const shellEnv = { ...process.env }
    const shellSpec = this.commandHelper.getShellSpec(command)
    const stdoutBuffer = this.commandHelper.createOutputBuffer(
      request.maxOutputChars ?? DEFAULT_COMMAND_OUTPUT_CHARS
    )
    const stderrBuffer = this.commandHelper.createOutputBuffer(
      request.maxOutputChars ?? DEFAULT_COMMAND_OUTPUT_CHARS
    )
    const startedAt = Date.now()
    const detached = this.commandHelper.shouldDetachForegroundProcess()
    const runId = request.runId ?? `run-${startedAt}-${Math.random().toString(36).slice(2, 8)}`
    const emit = (event: Omit<WorkbenchRunCommandOutputEvent, 'runId'>): void => {
      onOutput?.({
        runId,
        ...event,
      })
    }

    abortSignal?.throwIfAborted()
    const timers = new TimerScope({ name: 'WorkbenchCommandRunner.runCommand' })
    return new Promise<WorkbenchRunCommandResult>((resolve, reject) => {
      let timedOut = false
      let abortRequested = false
      let settled = false
      let terminationRequested = false
      let forceKillHandle: TimerLease | undefined
      let groupTermination: Promise<void> | undefined

      const child = spawn(shellSpec.file, shellSpec.args, {
        cwd: cwdPath.realPath,
        detached,
        windowsVerbatimArguments: shellSpec.windowsVerbatimArguments,
        windowsHide: true,
        env: shellEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
      })

      const isChildRunning = (): boolean =>
        !settled && child.exitCode === null && child.signalCode === null

      const requestTermination = (reason: 'abort' | 'timeout'): void => {
        if (terminationRequested || !isChildRunning()) return

        terminationRequested = true
        timedOut = reason === 'timeout'
        abortRequested = reason === 'abort'
        this.commandHelper.terminateForegroundProcess(child.pid, 'SIGTERM')

        groupTermination = new Promise<void>((done) => {
          forceKillHandle = timers.after(this.commandHelper.getForceKillDelayMs(), () => {
            try {
              // shell 已退出时，同组子孙仍可能忽略 SIGTERM；关闭事件不能撤掉它们的强杀。
              if (detached || isChildRunning())
                this.commandHelper.terminateForegroundProcess(child.pid, 'SIGKILL')
            } finally {
              done()
            }
          })
        })
      }

      const handleAbort = (): void => requestTermination('abort')
      const timeoutHandle = timers.after(timeoutMs, () => {
        requestTermination('timeout')
      })

      const cleanup = (): void => {
        timeoutHandle.cancel()
        forceKillHandle?.cancel()
        abortSignal?.removeEventListener('abort', handleAbort)
        timers.dispose()
      }

      const decoders = { stdout: new StringDecoder('utf8'), stderr: new StringDecoder('utf8') }
      const append = (stream: 'stdout' | 'stderr', text: string): void => {
        if (!text) return
        this.commandHelper.appendOutput(stream === 'stdout' ? stdoutBuffer : stderrBuffer, text)
        emit({ stream, chunk: text })
      }
      for (const stream of ['stdout', 'stderr'] as const) {
        child[stream].on('data', (chunk: Buffer | string) => {
          append(stream, typeof chunk === 'string' ? chunk : decoders[stream].write(chunk))
        })
      }

      child.on('error', (error) => {
        if (settled) return
        settled = true
        cleanup()
        reject(
          new AppError(
            'PLATFORM',
            workbenchMainText('commands.startFailed', { reason: error.message }),
            error
          )
        )
      })

      child.on('close', async (exitCode, signal) => {
        if (settled) return
        settled = true
        if (detached && groupTermination) await groupTermination
        cleanup()

        for (const stream of ['stdout', 'stderr'] as const) append(stream, decoders[stream].end())
        const finishedAt = Date.now()
        const truncated = stdoutBuffer.truncated || stderrBuffer.truncated
        emit({ stream: 'system', chunk: '', closed: true, exitCode, signal })
        resolve({
          projectRoot,
          command,
          cwd: cwdPath.realPath,
          exitCode,
          signal,
          stdout: stdoutBuffer.text,
          stderr: stderrBuffer.text,
          durationMs: finishedAt - startedAt,
          timedOut,
          truncated,
          success: !timedOut && !abortRequested && exitCode === 0,
          startedAt,
          finishedAt,
        })
      })

      abortSignal?.addEventListener('abort', handleAbort, { once: true })
      if (abortSignal?.aborted) handleAbort()
    })
  }
}

export { CommandRunner }
