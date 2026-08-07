import { isEmpty } from '@velaros-ai/core'
import { analyzeCommandExecution, type CommandExecutionPlan } from '@velaros-ai/project/execution'

import { containsTokenSequence, tokenizeShellCommand } from './CommandParsingHelper'

/**
 * Workbench 命令执行策略 = 平台权威源 + 一层「IDE 工作区完整性」补充判定。
 *
 * ## 为什么不是自己一套
 *
 * 通用判定——只读性、长驻进程、端口、跨平台破坏性命令、提权——单一权威源是
 * `@velaros-ai/project/execution` 的 {@link analyzeCommandExecution}。本文件**不复制也不改写**
 * 它的语义，只在其结论之上叠加 Workbench 作为 IDE 宿主特有的一类判定。
 *
 * ## 补充判定的边界（只有这三类）
 *
 * Workbench 的命令运行器跑在用户打开的项目里：编辑器可能持有未保存缓冲区，Agent 可能正在改文件。
 * 以下三类在通用策略里不算「危险」，但在 IDE 语境下必须拦：
 *
 * 1. **改写 Git 工作区或 HEAD** 的子命令——会覆盖未提交改动、把分支从用户脚下换掉；
 * 2. **逃出工作区**、以绝对路径为目标的写操作——命令路径上唯一的工作区逃逸护栏；
 * 3. **通用正则打不到的高危变体**——平台的 `rm` 正则要求 `r`/`f` 落在同一个 token
 *    （`rm -rf` 命中、`rm -r -f` 漏网）；`chmod 777` 这类全局可写授权；macOS `diskutil erase`
 *    与几个平台侧未覆盖的 PowerShell 磁盘 cmdlet。
 *
 * 命中即 `isDangerous`，由 `CommandHelper.validateCommand` 直接拒绝（其 `allowDangerous` 恒为 false）。
 */

/** 分段边界：命令位置判定与参数尾巴都以它为界，避免跨管道/跨分号误判。 */
const ShellSegmentBoundaryTokens = new Set(['&&', '||', ';', '|', '(', ')'])

/** 出现在真正可执行文件之前、不改变「这条命令是什么」的中性前缀。 */
const NeutralCommandWrappers = new Set(['command', 'env', 'exec', 'nice', 'sudo', 'time', 'timeout'])

/** 会改写 Git 工作区内容或 HEAD 的子命令。键是子命令，值是给用户看的拒绝理由。 */
const WorkspaceMutatingGitSubcommands: ReadonlyArray<readonly [string, string]> = [
  ['checkout', '命令会切换 Git 分支或恢复文件，可能覆盖当前工作区变更。'],
  ['clean', '命令会清理未跟踪文件，可能删除尚未提交的工作内容。'],
  ['merge', '命令会合并 Git 历史，可能改写当前工作区内容。'],
  ['pull', '命令会更新当前 Git HEAD，可能与正在进行的文件修改冲突。'],
  ['rebase', '命令会变基 Git 历史，可能改写提交或工作区内容。'],
  ['reset', '命令会重置 Git 状态，可能丢弃或覆盖当前工作区变更。'],
  ['restore', '命令会恢复文件内容，可能覆盖当前工作区变更。'],
  ['revert', '命令会创建回退提交，可能与当前工作区变更冲突。'],
  ['switch', '命令会切换 Git 分支，可能打断其他智能体或工作台正在进行的工作。'],
]

/** 以路径为目标的写操作；配合绝对路径实参构成「写到工作区外」的信号。 */
const AbsolutePathMutatingCommands = new Set([
  'chmod', 'chown', 'clear-content', 'copy', 'copy-item', 'cp', 'del', 'erase', 'mkdir',
  'move', 'move-item', 'mv', 'new-item', 'out-file', 'remove-item', 'ren', 'rename',
  'rename-item', 'rm', 'rmdir', 'robocopy', 'set-content', 'touch', 'truncate', 'xcopy',
])

/** 平台侧 `windowsDestructivePatterns` 未覆盖的 PowerShell 磁盘 cmdlet。 */
const UncoveredDiskCommands = new Set([
  'clear-disk', 'format-volume', 'initialize-disk', 'remove-partition',
])

/** 取第 `index` 个 token 之后、同一分段内的实参。 */
function commandTail(tokens: readonly string[], index: number): string[] {
  const tail: string[] = []
  for (let cursor = index + 1; cursor < tokens.length; cursor += 1) {
    const token = tokens[cursor]
    if (ShellSegmentBoundaryTokens.has(token)) break
    tail.push(token)
  }
  return tail
}

/**
 * 判断 token 是否处在「可执行文件」位置，而不是某条命令的实参。
 *
 * 回退到分段起点后跳过环境变量赋值与中性前缀（`sudo chmod` / `env A=1 chmod` 都算命令位置），
 * 避免把 `echo chmod 777` 这类文本误判成真的 chmod。
 */
function isCommandPosition(tokens: readonly string[], index: number): boolean {
  let segmentStart = 0
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    if (!ShellSegmentBoundaryTokens.has(tokens[cursor])) continue
    segmentStart = cursor + 1
    break
  }

  let cursor = segmentStart
  while (cursor < index) {
    const token = tokens[cursor]
    if (/^[A-Za-z_]\w*=/u.test(token) || NeutralCommandWrappers.has(token)) {
      cursor += 1
      continue
    }
    return false
  }

  return cursor === index
}

/** 平台正则要求 `r`/`f` 同 token；这里补 `rm -r -f` 这类分开写的形态。 */
function hasSeparatedRecursiveForceRemove(tokens: readonly string[]): boolean {
  return tokens.some((token, index) => {
    if (token !== 'rm' || !isCommandPosition(tokens, index)) return false

    let recursive = false
    let force = false
    for (const argument of commandTail(tokens, index)) {
      if (!argument.startsWith('-') || argument === '--') continue
      recursive = recursive || argument.includes('r')
      force = force || argument.includes('f')
    }
    return recursive && force
  })
}

/** `chmod 777` / `a+w` 这类把文件放开成全局可写的授权（平台侧只覆盖 `chmod -R`）。 */
function hasWorldWritableChmod(tokens: readonly string[]): boolean {
  return tokens.some((token, index) => {
    if (token !== 'chmod' || !isCommandPosition(tokens, index)) return false

    const mode = commandTail(tokens, index).find((candidate) => !candidate.startsWith('-'))
    return mode === '777' || mode === '0777' || mode === 'a+w' || mode === 'ugo+w'
  })
}

/** 写操作的实参里出现绝对路径（POSIX `/`、Windows 盘符或 UNC），视为可能写到工作区外。 */
function hasAbsolutePathMutation(tokens: readonly string[]): boolean {
  return tokens.some((token, index) => {
    if (!AbsolutePathMutatingCommands.has(token) || !isCommandPosition(tokens, index)) return false

    return commandTail(tokens, index).some(
      (candidate) =>
        !!candidate &&
        !candidate.startsWith('-') &&
        (candidate.startsWith('/') || /^[a-z]:[\\/]/iu.test(candidate) || candidate.startsWith('\\\\'))
    )
  })
}

/** Workbench 特有的补充危险判定；返回 null 表示「按平台结论走」。 */
function resolveWorkspaceIntegrityDangerReason(command: string): Nullable<string> {
  const tokens = tokenizeShellCommand(command).map((token) => token.toLowerCase())
  if (isEmpty(tokens)) return null

  for (const [subcommand, reason] of WorkspaceMutatingGitSubcommands) {
    if (containsTokenSequence(tokens, ['git', subcommand])) return reason
  }

  if (
    containsTokenSequence(tokens, ['git', 'push']) &&
    tokens.some((token) => token === '-f' || token.startsWith('--force'))
  ) return '命令会强制推送 Git 分支，可能覆盖远端历史。'

  if (containsTokenSequence(tokens, ['gh', 'pr', 'checkout'])) return '命令会通过 GitHub CLI 切换分支或修改当前工作区。'

  if (hasSeparatedRecursiveForceRemove(tokens)) return '命令包含高风险的递归删除模式。'

  if (hasWorldWritableChmod(tokens)) return '命令会把文件权限改成 777 或全局可写，可能扩大写入和执行权限。'

  if (hasAbsolutePathMutation(tokens)) return '命令会修改绝对路径；如果目标不在当前工作区内，可能影响项目外文件。'

  if (tokens.includes('halt') || tokens.includes('poweroff')) return '命令可能会关闭、重启或中断当前系统环境。'

  // `diskutil erase` 之外还要覆盖 eraseDisk / eraseVolume 这类拼接子命令。
  const erasesDisk =
    containsTokenSequence(tokens, ['diskutil', 'erase']) ||
    (tokens[0] === 'diskutil' && !!tokens[1]?.startsWith('erase'))
  if (erasesDisk) return '命令看起来会抹除磁盘或卷。'

  if (tokens.some((token) => UncoveredDiskCommands.has(token))) return '命令可能会格式化、初始化或修改磁盘分区。'

  return null
}

/**
 * Workbench 的命令执行分析：平台结论 + 工作区完整性补充。
 *
 * 平台已判危险时原样返回（不覆盖它的理由）；只有平台放行、而 IDE 语境下必须拦的命令，
 * 才由本层升格为危险并附上工作区视角的理由。
 */
export function analyzeWorkbenchCommandExecution(command: string): CommandExecutionPlan {
  const plan = analyzeCommandExecution(command)
  if (plan.isDangerous) return plan

  const dangerousReason = resolveWorkspaceIntegrityDangerReason(command)
  if (!dangerousReason) return plan

  return { ...plan, isDangerous: true, dangerousReason, shouldRequestConfirmation: true }
}

export type { CommandExecutionPlan }
