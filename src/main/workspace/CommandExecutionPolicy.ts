import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'

import type { ToolConfirmationDecisionOptions } from '@velaros-ai/agent/protocol'
import { createManualApprovalOptions } from '@velaros-ai/agent/tool-contract'
import { isEmpty } from '@velaros-ai/core'
import { analyzeCommandExecution, type CommandExecutionPlan } from '@velaros-ai/project/execution'

import { containsTokenSequence, tokenizeShellCommand } from './CommandParsingHelper'
import { isPathInsideRoot } from './PathContainmentHelper'

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
 * 以下三类在通用策略里不算「危险」，但在 IDE 语境下值得先问用户一句：
 *
 * 1. **会丢工作区改动、切换分支或改写 HEAD 的 Git 调用**——按子命令和实参形态逐条判，见
 *    {@link GitInvocationRules}；只动索引、或只挪当前分支指针而不碰工作区文件的形态不算；
 * 2. **写到工作区外**——写操作的目标是工作区外的绝对路径（或 `~`），命令路径上唯一的工作区逃逸护栏；
 * 3. **通用正则打不到的高危形态**——递归删除目录（`rm -r`，不论带不带 `-f`）、`chmod 777` 这类
 *    全局可写授权、macOS `diskutil erase` 与几个平台侧未覆盖的 PowerShell 磁盘 cmdlet。
 *
 * ## 命中之后：先问，不是拒绝
 *
 * `isDangerous` 的意思是「执行前必须经用户确认」。发起执行的工具经当轮审批端口问用户，批准后带
 * `allowDangerous` 照常执行，拒绝则返回 skipped：`project:run` 里平台判危险的由平台自己问、带着
 * `allowDangerous` 进宿主，平台放行而本层判危险的由宿主补问（`ProjectCapabilityProvider`），同一条
 * 命令只问一次；`workbench:start_run` 同理。只有**没人问过**的执行路径（`CommandHelper.validateCommand`
 * 收到 `allowDangerous = false`）才会把危险命令挡回去。
 */

/** 分段边界：命令位置判定与参数尾巴都以它为界，避免跨管道/跨分号误判。 */
const ShellSegmentBoundaryTokens = new Set(['&&', '||', ';', '|', '(', ')'])

/** 出现在真正可执行文件之前、不改变「这条命令是什么」的中性前缀。 */
const NeutralCommandWrappers = new Set(['command', 'env', 'exec', 'nice', 'sudo', 'time', 'timeout'])

/** 后面跟一个取值 token 的 Git 全局选项（与平台只读判定同一张表），找子命令时要连值一起跳过。 */
const GitGlobalOptionsWithValue = new Set([
  '-C', '-c', '--config-env', '--git-dir', '--namespace', '--work-tree',
])

/** 一条 Git 子命令的危险判定。 */
interface GitInvocationRule {
  readonly subcommand: string
  /** 判危险时给用户看的理由。 */
  readonly reason: string
  /** 实参（子命令之后、`--` 之前）形态无害时返回 true；缺省表示这条子命令任何形态都要先问。 */
  readonly isHarmless?: (args: readonly string[]) => boolean
}

/**
 * Git 调用的危险判定表。
 *
 * 判据只有一条：**会不会丢掉工作区里还没提交的内容、或把分支 / HEAD 从用户和其他 Agent 脚下换掉**。
 * 只改索引、或只挪当前分支指针而工作区文件一个字节不动的形态不算危险——真机里 Agent 用
 * `git reset -q HEAD -- <files>`、`git rm --cached` 清理自己暂存的临时文件，被一刀切的「reset / rm
 * 一律拒绝」挡住，正是这张表要纠正的误伤。表里没有的子命令（status / diff / add / commit / fetch /
 * push 普通推送……）按平台结论走。
 */
const GitInvocationRules: readonly GitInvocationRule[] = [
  {
    // 默认的 --mixed 与 --soft 只改索引和分支指针，工作区不动，撤下的提交还在 reflog 里；
    // 只有这三种模式会把工作区文件改写成目标提交的样子。
    subcommand: 'reset',
    reason: '命令会重置 Git 工作区，未提交的改动可能被覆盖。',
    isHarmless: (args) => !args.some((arg) => ['--hard', '--merge', '--keep'].includes(arg)),
  },
  {
    // restore 默认写工作区；只有纯 --staged（不带 --worktree）才是「取消暂存」，只动索引。
    subcommand: 'restore',
    reason: '命令会用 Git 里的版本覆盖工作区文件，未提交的改动会丢失。',
    isHarmless: (args) =>
      hasGitOption(args, 'S', '--staged') && !hasGitOption(args, 'W', '--worktree'),
  },
  {
    // --cached 只把文件移出索引、磁盘上原样保留；不带 --cached 时 Git 自己会拒绝删有本地改动的文件，
    // 只有 -f 会连未提交的改动一起删掉。
    subcommand: 'rm',
    reason: '命令会强制删除工作区文件，未提交的改动会一起丢失。',
    isHarmless: (args) => hasGitOption(args, null, '--cached') || !hasGitOption(args, 'f', '--force'),
  },
  {
    // -n / --dry-run 只列出将要删除的文件。
    subcommand: 'clean',
    reason: '命令会删除未跟踪的文件，尚未提交的新文件会一起消失。',
    isHarmless: (args) => hasGitOption(args, 'n', '--dry-run'),
  },
  { subcommand: 'checkout', reason: '命令会切换 Git 分支或用 Git 里的版本覆盖文件，可能丢掉当前工作区的改动。' },
  { subcommand: 'switch', reason: '命令会切换 Git 分支，可能打断其他智能体或工作台正在进行的工作。' },
  { subcommand: 'merge', reason: '命令会合并 Git 历史，可能改写当前工作区内容。' },
  { subcommand: 'pull', reason: '命令会更新当前 Git HEAD，可能与正在进行的文件修改冲突。' },
  { subcommand: 'rebase', reason: '命令会变基 Git 历史，可能改写提交或工作区内容。' },
  { subcommand: 'revert', reason: '命令会回滚已有提交，可能与当前工作区的改动冲突。' },
  {
    // 普通推送只在远端追加提交；强推（-f / --force* / +refspec）会覆盖远端已有的历史。
    subcommand: 'push',
    reason: '命令会强制推送 Git 分支，可能覆盖远端历史。',
    isHarmless: (args) =>
      !hasGitOption(args, 'f', '--force')
      && !args.some((arg) => arg.startsWith('--force-') || (arg.startsWith('+') && arg.length > 1)),
  },
  {
    // stash push / pop / apply 不丢内容；drop / clear 会把暂存的改动永久扔掉。
    subcommand: 'stash',
    reason: '命令会永久丢弃 Git stash 里暂存的改动。',
    isHarmless: (args) => {
      const action = args.find((arg) => !arg.startsWith('-'))
      return action !== 'drop' && action !== 'clear'
    },
  },
]

/** 以路径为目标的写操作；配合工作区外的路径实参构成「写到工作区外」的信号。 */
const PathMutatingCommands = new Set([
  'chmod', 'chown', 'clear-content', 'copy', 'copy-item', 'cp', 'del', 'erase', 'mkdir',
  'move', 'move-item', 'mv', 'new-item', 'out-file', 'remove-item', 'ren', 'rename',
  'rename-item', 'rm', 'rmdir', 'robocopy', 'set-content', 'touch', 'truncate', 'xcopy',
])

/** 平台侧 `windowsDestructivePatterns` 未覆盖的 PowerShell 磁盘 cmdlet。 */
const UncoveredDiskCommands = new Set([
  'clear-disk', 'format-volume', 'initialize-disk', 'remove-partition',
])

/** 可执行文件名：`/usr/bin/git` 与 `git` 是同一条命令。 */
function executableName(token: string): string {
  return token.split('/').at(-1) ?? token
}

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

/** `--` 之后都是路径实参；叫 `-f` 的文件不能被当成选项。 */
function argsBeforePathspec(args: readonly string[]): readonly string[] {
  const separator = args.indexOf('--')
  return separator < 0 ? args : args.slice(0, separator)
}

/** 选项是否出现：长选项（含 `--x=value`）或合写的短选项（`-SW` 同时带 S 与 W）。区分大小写。 */
function hasGitOption(args: readonly string[], short: Nullable<string>, long: string): boolean {
  return args.some((arg) =>
    arg === long
    || arg.startsWith(`${long}=`)
    || (!!short && /^-[A-Za-z]+$/u.test(arg) && arg.includes(short)))
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
    if (/^[A-Za-z_]\w*=/u.test(token) || NeutralCommandWrappers.has(token.toLowerCase())) {
      cursor += 1
      continue
    }
    return false
  }

  return cursor === index
}

/** 命令位置上以 `name` 为可执行文件的每一处调用，返回它们的实参。 */
function invocationsOf(tokens: readonly string[], name: string): string[][] {
  return tokens.flatMap((token, index) =>
    executableName(token).toLowerCase() === name && isCommandPosition(tokens, index)
      ? [commandTail(tokens, index)]
      : [])
}

/** 跳过 Git 全局选项找到子命令；`git -C sub reset --hard` 与 `git reset --hard` 是同一条。 */
function parseGitInvocation(args: readonly string[]): Nullable<{ subcommand: string; args: string[] }> {
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]
    if (!token.startsWith('-')) return { subcommand: token, args: args.slice(index + 1) }
    if (GitGlobalOptionsWithValue.has(token)) index += 1
  }
  return null
}

function resolveGitDangerReason(tokens: readonly string[]): Nullable<string> {
  for (const args of invocationsOf(tokens, 'git')) {
    const invocation = parseGitInvocation(args)
    const rule = GitInvocationRules.find((candidate) => candidate.subcommand === invocation?.subcommand)
    if (!invocation || !rule) continue
    if (!rule.isHarmless?.(argsBeforePathspec(invocation.args))) return rule.reason
  }
  return null
}

/** 递归删除目录：`rm -r` / `-R` / `--recursive`，带不带 `-f` 都算——目录里有什么都会一起没。 */
function hasRecursiveRemove(tokens: readonly string[]): boolean {
  return invocationsOf(tokens, 'rm').some((args) =>
    argsBeforePathspec(args).some((arg) =>
      arg.toLowerCase() === '--recursive' || /^-[a-z]*r[a-z]*$/iu.test(arg)))
}

/** `chmod 777` / `a+w` 这类把文件放开成全局可写的授权（平台侧只覆盖 `chmod -R`）。 */
function hasWorldWritableChmod(tokens: readonly string[]): boolean {
  return invocationsOf(tokens, 'chmod').some((args) => {
    const mode = args.find((candidate) => !candidate.startsWith('-'))?.toLowerCase()
    return mode === '777' || mode === '0777' || mode === 'a+w' || mode === 'ugo+w'
  })
}

/** 写操作的实参里第一个落在工作区外的路径（绝对路径或 `~`）；工作区内的绝对路径照常放行。 */
function findOutsideWorkspaceTarget(tokens: readonly string[], projectRoot: string): Nullable<string> {
  for (const [index, token] of tokens.entries()) {
    if (!PathMutatingCommands.has(executableName(token).toLowerCase()) || !isCommandPosition(tokens, index)) continue

    for (const candidate of commandTail(tokens, index)) {
      if (candidate.startsWith('-')) continue
      const target = candidate === '~' || candidate.startsWith('~/')
        ? join(homedir(), candidate.slice(1))
        : candidate
      if (isAbsolute(target) && !isPathInsideRoot(projectRoot, target)) return candidate
    }
  }
  return null
}

/** Workbench 特有的补充危险判定；返回 null 表示「按平台结论走」。 */
function resolveWorkspaceIntegrityDangerReason(command: string, projectRoot: string): Nullable<string> {
  const tokens = tokenizeShellCommand(command)
  if (isEmpty(tokens)) return null
  const lowered = tokens.map((token) => token.toLowerCase())

  const gitReason = resolveGitDangerReason(tokens)
  if (gitReason) return gitReason

  if (containsTokenSequence(lowered, ['gh', 'pr', 'checkout'])) return '命令会通过 GitHub CLI 切换分支或修改当前工作区。'

  if (hasRecursiveRemove(tokens)) return '命令会递归删除整个目录，目录里的内容会一起删掉。'

  if (hasWorldWritableChmod(tokens)) return '命令会把文件权限改成 777 或全局可写，可能扩大写入和执行权限。'

  const outsideTarget = findOutsideWorkspaceTarget(tokens, projectRoot)
  if (outsideTarget) return `命令涉及当前工作区之外的路径 ${outsideTarget}，可能改动项目外的文件。`

  if (lowered.includes('halt') || lowered.includes('poweroff')) return '命令可能会关闭、重启或中断当前系统环境。'

  // `diskutil erase` 之外还要覆盖 eraseDisk / eraseVolume 这类拼接子命令。
  const erasesDisk =
    containsTokenSequence(lowered, ['diskutil', 'erase']) ||
    (lowered[0] === 'diskutil' && !!lowered[1]?.startsWith('erase'))
  if (erasesDisk) return '命令看起来会抹除磁盘或卷。'

  if (lowered.some((token) => UncoveredDiskCommands.has(token))) return '命令可能会格式化、初始化或修改磁盘分区。'

  return null
}

/**
 * Workbench 的命令执行分析：平台结论 + 工作区完整性补充。
 *
 * 平台已判危险时原样返回（不覆盖它的理由）；只有平台放行、而 IDE 语境下需要先问用户的命令，
 * 才由本层升格为危险并附上工作区视角的理由。`projectRoot` 划定「工作区外」的边界。
 */
export function analyzeWorkbenchCommandExecution(command: string, projectRoot: string): CommandExecutionPlan {
  const plan = analyzeCommandExecution(command)
  if (plan.isDangerous) return plan

  const dangerousReason = resolveWorkspaceIntegrityDangerReason(command, projectRoot)
  if (!dangerousReason) return plan

  return { ...plan, isDangerous: true, dangerousReason, shouldRequestConfirmation: true }
}

/**
 * 危险命令的审批请求：每次都由用户亲自点头，批准只管这一次。
 *
 * 光有 `:dangerous` 后缀的 riskScope 兑现不了「每次都问」：任务审批端口（`createTaskApprovalPort`）
 * 把 riskScope 换成 operation key 再交给权限策略，后缀在那一步就丢了——标准档会记住这条命令的答案，
 * 「完全访问」档直接放行。人工审批标记能原样穿过去，它正是平台给「承诺等用户确认」准备的构造器。
 */
export function createDangerousCommandApprovalOptions(
  riskScope: `${string}:dangerous`,
  operation: NonNullable<ToolConfirmationDecisionOptions['operation']>
): ToolConfirmationDecisionOptions {
  return createManualApprovalOptions({ approvalRisk: 'high', riskScope, operation })
}

export type { CommandExecutionPlan }
