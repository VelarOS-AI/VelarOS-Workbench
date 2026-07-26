/**
 * 工作台命令辅助器（照搬 desktop `workspace/storage/commands/Helpers.ts` 中 CommandRunner
 * 消费的子面：安全校验 / 超时与输出钳制 / shell 规格 / 进程组终止；语义保形，常量同值）。
 *
 * 裁剪说明：desktop 原文件还承载 agent shell 工具族的后台启动包装（pid 标记 / 输出日志
 * 文件 / 进程组收割），那一族属 agent 链后端，工作台一次性命令运行不消费——未随迁。
 */
import { execFileSync } from 'node:child_process'

import { Log } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'
import { systemPlatformCompatibility } from '@velaros-ai/system-tools/platform-compatibility'

import { analyzeCommandExecution } from './CommandExecutionPolicy'

const DEFAULT_COMMAND_TIMEOUT_MS = 60_000
const DEFAULT_COMMAND_OUTPUT_CHARS = 20_000
const MAX_COMMAND_OUTPUT_CHARS = 50_000
const FORCE_KILL_DELAY_MS = 1_000
const log = Log.tag('WorkbenchCommandHelper')

/** 前台命令返回的滚动输出缓冲。 */
interface WorkspaceCommandBuffer {
  text: string
  truncated: boolean
  maxChars: number
}

/** 平台兼容层返回的 shell 执行规格。 */
interface WorkspaceShellSpec {
  file: string
  args: string[]
}

class CommandHelper {
  /** 默认前台命令超时时间。 */
  public getDefaultTimeoutMs(): number {
    return DEFAULT_COMMAND_TIMEOUT_MS
  }

  /** SIGTERM 后等待多久再强杀。 */
  public getForceKillDelayMs(): number {
    return FORCE_KILL_DELAY_MS
  }

  /** 创建一个只保留末尾内容的输出缓冲。 */
  public createOutputBuffer(maxOutputChars?: number): WorkspaceCommandBuffer {
    return {
      text: '',
      truncated: false,
      maxChars: this.normalizeMaxOutputChars(maxOutputChars),
    }
  }

  /**
   * 校验命令文本。
   *
   * 空命令直接拒绝；危险命令默认拒绝，除非调用方明确传入 allowDangerous。
   */
  public validateCommand(command: string, allowDangerous = false): string {
    const trimmed = command.trim()
    if (!trimmed) {
      throw new AppError('VALIDATION', '命令不能为空')
    }

    if (!allowDangerous && analyzeCommandExecution(trimmed).isDangerous) {
      throw new AppError('PERMISSION', `命令被安全策略拒绝：${trimmed}`)
    }

    return trimmed
  }

  /** 把超时时间限制在 1 秒到 10 分钟之间。 */
  public normalizeTimeoutMs(timeoutMs?: number): number {
    if (!timeoutMs) return DEFAULT_COMMAND_TIMEOUT_MS
    return Math.max(1_000, Math.min(timeoutMs, 10 * 60 * 1_000))
  }

  /** 把返回输出大小限制在可控范围内。 */
  public normalizeMaxOutputChars(maxOutputChars?: number): number {
    if (!maxOutputChars) return DEFAULT_COMMAND_OUTPUT_CHARS
    return Math.max(1, Math.min(maxOutputChars, MAX_COMMAND_OUTPUT_CHARS))
  }

  /**
   * 追加输出到滚动缓冲。
   *
   * 超过 maxChars 时保留末尾内容，因为错误信息通常出现在输出末尾。
   */
  public appendOutput(buffer: WorkspaceCommandBuffer, chunk: string): void {
    const nextText = `${buffer.text}${chunk}`
    if (nextText.length > buffer.maxChars) {
      buffer.text = nextText.slice(-buffer.maxChars)
      buffer.truncated = true
      return
    }

    buffer.text = nextText
  }

  /** 获取当前平台应该如何调用 shell 执行这条命令。 */
  public getShellSpec(command: string, shellPath?: string): WorkspaceShellSpec {
    return systemPlatformCompatibility.getShellCommandSpec(command, {
      shellPath,
      env: process.env,
    })
  }

  /** 前台命令是否应以独立进程组启动，方便超时时整体终止。 */
  public shouldDetachForegroundProcess(): boolean {
    return systemPlatformCompatibility.shouldUseDetachedProcessGroup()
  }

  /**
   * 终止前台进程。
   *
   * 在支持进程组的平台先杀进程组；如果进程组不存在，再回退到 shell 进程本身。
   */
  public terminateForegroundProcess(
    pid: number | undefined,
    signal: NodeJS.Signals = 'SIGTERM'
  ): void {
    if (!pid) return

    const treeKillSpec = systemPlatformCompatibility.getProcessTreeKillCommandSpec(pid, signal)
    if (treeKillSpec) {
      try {
        execFileSync(treeKillSpec.file, treeKillSpec.args, { stdio: 'ignore' })
        return
      } catch (error) {
        log.debug('终止 Windows 前台进程树失败，回退到进程 pid', {
          pid,
          signal,
          error,
        })
      }
    }

    const killPid = systemPlatformCompatibility.getProcessKillPid(pid)
    try {
      process.kill(killPid, signal)
      return
    } catch (error) {
      log.debug('终止前台进程组失败，回退到进程 pid', {
        pid,
        killPid,
        signal,
        error,
      })
      // Fall back to the shell process if the process group is already gone.
    }

    if (killPid === pid) return

    try {
      process.kill(pid, signal)
    } catch (error) {
      log.debug('按 pid 终止前台进程失败', { pid, signal, error })
      // Process may have exited between timeout scheduling and delivery.
    }
  }
}

export { CommandHelper, CommandHelper as WorkbenchCommandHelper }
