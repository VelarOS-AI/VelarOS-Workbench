/**
 * 工作台一次性命令运行器（照搬 desktop `workspace/workbench/CommandRunner.ts`，保形零改动；
 * CommandHelper 改为本目录裁剪版，见 `CommandHelper.ts` 头注）。
 */
import { spawn } from 'node:child_process'
import { stat } from 'node:fs/promises'

import { AppError } from '@velaros-ai/core/error'
import { type TimerLease, TimerScope } from '@velaros-ai/core/utils/TimerScope'

import type {
  WorkbenchRunCommandOutputEvent,
  WorkbenchRunCommandRequest,
  WorkbenchRunCommandResult,
} from '@shared/contracts'

import type { CommandHelper } from './CommandHelper'
import type { PathResolver } from './PathResolver'

const DEFAULT_COMMAND_OUTPUT_CHARS = 8_000

class CommandRunner {
  constructor(
    private readonly pathResolver: PathResolver,
    private readonly commandHelper: CommandHelper
  ) {}

  public async runCommand(
    request: WorkbenchRunCommandRequest,
    onOutput?: (event: WorkbenchRunCommandOutputEvent) => void,
    abortSignal?: AbortSignal
  ): Promise<WorkbenchRunCommandResult> {
    abortSignal?.throwIfAborted()
    const projectRoot = await this.pathResolver.resolveProjectRoot(request.projectRoot)
    const cwdPath = await this.pathResolver.resolveInsideProject(projectRoot, request.cwd ?? '.')
    const cwdStats = await stat(cwdPath.realPath)
    if (!cwdStats.isDirectory()) {
      throw new AppError('VALIDATION', '工作台命令运行目录必须是目录。')
    }

    const command = this.commandHelper.validateCommand(request.command, false)
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

      const child = spawn(shellSpec.file, shellSpec.args, {
        cwd: cwdPath.realPath,
        detached,
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

        forceKillHandle = timers.after(this.commandHelper.getForceKillDelayMs(), () => {
          if (isChildRunning()) {
            this.commandHelper.terminateForegroundProcess(child.pid, 'SIGKILL')
          }
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

      child.stdout.on('data', (chunk: Buffer | string) => {
        const text = chunk.toString()
        this.commandHelper.appendOutput(stdoutBuffer, text)
        emit({ stream: 'stdout', chunk: text })
      })

      child.stderr.on('data', (chunk: Buffer | string) => {
        const text = chunk.toString()
        this.commandHelper.appendOutput(stderrBuffer, text)
        emit({ stream: 'stderr', chunk: text })
      })

      child.on('error', (error) => {
        if (settled) return
        settled = true
        cleanup()
        reject(new AppError('PLATFORM', `工作台命令启动失败：${error.message}`, error))
      })

      child.on('close', (exitCode, signal) => {
        if (settled) return
        settled = true
        cleanup()

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

export { CommandRunner, CommandRunner as WorkbenchCommandService }
