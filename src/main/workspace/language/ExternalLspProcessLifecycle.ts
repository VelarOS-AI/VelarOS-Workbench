import { execFileSync } from 'node:child_process'

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
    ...(killPid === pid ? {} : { fallbackPid: pid }),
    signal,
  }
}

/** 语言服务器可能经 .cmd 或运行时再派生子进程，关闭时必须收完整棵树。 */
function terminateExternalLspProcessTree(
  pid: number | undefined,
  signal: NodeJS.Signals = 'SIGKILL'
): boolean {
  if (!pid) return false
  const plan = buildExternalLspProcessTreeTerminationPlan(pid, signal)

  try {
    if (plan.kind === 'command') {
      execFileSync(plan.file, plan.args, { stdio: 'ignore', windowsHide: true })
      return true
    }

    try {
      process.kill(plan.pid, plan.signal)
      return true
    } catch (error) {
      if (!plan.fallbackPid) throw error
      process.kill(plan.fallbackPid, plan.signal)
      return true
    }
  } catch {
    // 进程可能已在 LSP 关闭握手与终止动作之间自然退出。
    return false
  }
}

export {
  buildExternalLspProcessTreeTerminationPlan,
  shouldDetachExternalLspProcess,
  terminateExternalLspProcessTree,
}
export type { ExternalLspProcessTreeTerminationPlan }
