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
 *    复制类命令只看目的地，从项目外读个模板进来不算；
 * 3. **平台判定没覆盖的高危形态**——`chmod 777` 这类全局可写授权、macOS `diskutil erase` 与几个
 *    平台侧未覆盖的 PowerShell 磁盘 cmdlet。递归删除目录由平台判定（任何形态的 `rm -r` 都算危险）。
 *
 * ## 怎么读一条命令
 *
 * 先切成「一条条命令」再判：`&&`、`||`、`;`、`|`、`&`、换行、括号、反引号和 find 的 `-exec` 都是分界；
 * `bash -lc "…"` 这类把实参当脚本跑的解释器，引号里的脚本拆出来按同样的规则再判一遍。
 * 找「这一段真正执行的是谁」时跳过环境变量赋值、shell 关键字（`if` / `do` / `!` …）和包装命令
 * （`sudo` / `timeout 60` / `nice -n 5` / `xargs -0` …）连同它们的选项。
 *
 * 丢改动的代价远大于多问一句，所以 Git 不依赖这个「命令位置」：段内任何位置出现 `git` 都当一次调用
 * 来判（包装命令列不全，漏一个就是一次静默丢改动），代价是 `echo git reset --hard` 这种文本也会问。写到工作区外、`chmod 777` 才要求出现在命令位置——`grep -rn cp /usr/include`
 * 不是一次复制。
 *
 * ## 命中之后：先问，不是拒绝
 *
 * `isDangerous` 的意思是「执行前必须经用户确认」。发起执行的工具经当轮审批端口问用户，批准后带
 * `allowDangerous` 照常执行，拒绝则返回 skipped：`project:run` 里平台判危险的由平台自己问、带着
 * `allowDangerous` 进宿主，平台放行而本层判危险的由宿主补问（`ProjectCapabilityProvider`），同一条
 * 命令只问一次；`workbench:start_run` 同理；命令面板里用户自己输入的命令，用户就是确认者。
 */

/** 分段边界：两侧是两条独立执行的命令。find 的 `-exec` 族之后是它要跑的命令。 */
const ShellSegmentBoundaryTokens = new Set([
  '\n', '&', '&&', '(', ')', ';', '`', '|', '||', '-exec', '-execdir', '-ok', '-okdir',
])

/** 出现在命令位置、本身不执行任何东西的 shell 关键字：`if git pull; then …`、`! git checkout main`。 */
const ShellKeywords = new Set(['!', '{', 'do', 'elif', 'else', 'if', 'then', 'until', 'while'])

/** 包装命令：把后面的实参当命令来跑。 */
interface CommandWrapper {
  /** 后面跟一个取值 token 的选项，找真正的可执行文件时连值一起跳过。 */
  readonly valueOptions: ReadonlySet<string>
  /** 命令之前还有几个位置实参（`timeout 60 git pull` 的时长）。 */
  readonly positionals: number
}

function wrapper(valueOptions: readonly string[] = [], positionals = 0): CommandWrapper {
  return { valueOptions: new Set(valueOptions), positionals }
}

const CommandWrappers: ReadonlyMap<string, CommandWrapper> = new Map([
  ['builtin', wrapper()],
  ['caffeinate', wrapper(['-t', '-w'])],
  ['chronic', wrapper()],
  ['command', wrapper()],
  ['doas', wrapper(['-C', '-u'])],
  ['env', wrapper(['-C', '-S', '-u', '--chdir', '--split-string', '--unset'])],
  ['exec', wrapper(['-a'])],
  ['ionice', wrapper(['-c', '-n', '-p', '-P', '-u'])],
  ['nice', wrapper(['-n', '--adjustment'])],
  ['nohup', wrapper()],
  ['stdbuf', wrapper(['-e', '-i', '-o'])],
  ['sudo', wrapper(['-C', '-D', '-g', '-h', '-p', '-r', '-t', '-T', '-u', '-U', '--chdir', '--group', '--host', '--user'])],
  ['time', wrapper(['-f', '-o', '--format', '--output'])],
  ['timeout', wrapper(['-k', '-s', '--kill-after', '--signal'], 1)],
  ['unbuffer', wrapper()],
  ['xargs', wrapper(['-a', '-d', '-E', '-I', '-L', '-n', '-P', '-s', '--arg-file', '--delimiter', '--max-args', '--max-procs'])],
])

/** 把 `-c` 后面那个实参当脚本跑的 POSIX shell。 */
const PosixShells = new Set(['ash', 'bash', 'dash', 'fish', 'ksh', 'sh', 'zsh'])

/** 把 `-Command`（`-c`）/ `/c` 之后的全部实参当脚本跑的 Windows shell。 */
const WindowsShells = new Set(['cmd', 'powershell', 'pwsh'])

/** 引号里再套引号的脚本最多拆这么多层；再深的写法不是 Agent 会写的命令。 */
const MaxNestedScriptDepth = 3

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

/** 以路径为目标的写操作；配合工作区外的写入目标构成「写到工作区外」的信号。 */
const PathMutatingCommands = new Set([
  'chmod', 'chown', 'clear-content', 'copy', 'copy-item', 'cp', 'del', 'erase', 'mkdir',
  'move', 'move-item', 'mv', 'new-item', 'out-file', 'remove-item', 'ren', 'rename',
  'rename-item', 'rm', 'rmdir', 'robocopy', 'set-content', 'touch', 'truncate', 'xcopy',
])

/** 复制类命令：源只读、只写目的地。移动类（mv / move）会删掉源，两头都算写。 */
const CopyCommands = new Set(['copy', 'copy-item', 'cp', 'robocopy', 'xcopy'])

/** cmd.exe 原生命令：`/` 开头的是开关（`xcopy /E`），不是 POSIX 绝对路径。 */
const CmdNativeCommands = new Set(['copy', 'del', 'erase', 'move', 'ren', 'robocopy', 'xcopy'])

/** 后面跟一个路径的重定向；它的目标不是命令的实参。 */
const RedirectionTokens = new Set(['<', '<<<', '>', '>>'])

/** 平台侧 `windowsDestructivePatterns` 未覆盖的 PowerShell 磁盘 cmdlet。 */
const UncoveredDiskCommands = new Set([
  'clear-disk', 'format-volume', 'initialize-disk', 'remove-partition',
])

/** 一段里处在命令位置的那次调用。 */
interface ShellInvocation {
  /** 小写、去掉目录与 `.exe` 的可执行文件名。 */
  readonly name: string
  readonly args: readonly string[]
}

/** 可执行文件名：`/usr/bin/git`、`C:\…\git.exe` 与 `git` 是同一条命令。 */
function executableName(token: string): string {
  return (token.split(/[\\/]/u).at(-1) ?? token).toLowerCase().replace(/\.exe$/u, '')
}

function isEnvironmentAssignment(token: string): boolean {
  return /^[A-Za-z_]\w*=/u.test(token)
}

/** 按分段边界切开；空段丢掉。 */
function splitSegments(tokens: readonly string[]): string[][] {
  const segments: string[][] = []
  let current: string[] = []
  for (const token of tokens) {
    if (!ShellSegmentBoundaryTokens.has(token)) {
      current.push(token)
      continue
    }
    if (!isEmpty(current)) segments.push(current)
    current = []
  }
  if (!isEmpty(current)) segments.push(current)
  return segments
}

/** 跳过包装命令自己的选项和位置实参，返回它要跑的命令所在的下标。 */
function skipWrapperArguments(segment: readonly string[], start: number, commandWrapper: CommandWrapper): number {
  let index = start
  let positionals = commandWrapper.positionals
  while (index < segment.length) {
    const token = segment[index]
    if (token === '--') return index + 1
    if (token.length > 1 && token.startsWith('-')) {
      index += commandWrapper.valueOptions.has(token) ? 2 : 1
      continue
    }
    if (positionals === 0) return index
    positionals -= 1
    index += 1
  }
  return index
}

/** 段内真正被执行的可执行文件下标；整段都是赋值、关键字或包装命令时为 -1。 */
function findCommandIndex(segment: readonly string[]): number {
  let index = 0
  while (index < segment.length) {
    const token = segment[index]
    if (isEnvironmentAssignment(token) || ShellKeywords.has(token)) {
      index += 1
      continue
    }
    const commandWrapper = CommandWrappers.get(executableName(token))
    if (!commandWrapper) return index
    index = skipWrapperArguments(segment, index + 1, commandWrapper)
  }
  return -1
}

function invocationOf(segment: readonly string[]): Nullable<ShellInvocation> {
  const index = findCommandIndex(segment)
  return index < 0 ? null : { name: executableName(segment[index]), args: segment.slice(index + 1) }
}

/** 解释器把实参当脚本跑时的那段脚本：`bash -lc "git reset --hard"` 真正要跑的命令在引号里。 */
function nestedScriptOf(invocation: ShellInvocation): Nullable<string> {
  const { name, args } = invocation
  if (PosixShells.has(name)) {
    // -c 可以与别的单字母选项合写（-lc、-ec）；脚本是紧跟的那一个实参。
    const flagIndex = args.findIndex((arg) => /^-[A-Za-z]*c[A-Za-z]*$/u.test(arg))
    return flagIndex < 0 ? null : args[flagIndex + 1] ?? null
  }
  if (WindowsShells.has(name)) {
    // PowerShell 的 -Command 可按前缀缩写到 -c；cmd 的 /c、/k 之后整行都是命令。
    const flagIndex = args.findIndex((arg) => /^(?:-c(?:o(?:m(?:m(?:a(?:n(?:d)?)?)?)?)?)?|\/[ck])$/iu.test(arg))
    return flagIndex < 0 ? null : args.slice(flagIndex + 1).join(' ') || null
  }
  return null
}

/** 把命令切成一条条独立执行的命令段；解释器里套着的脚本拆出来接在后面。 */
function parseCommandSegments(command: string, depth = 0): string[][] {
  return splitSegments(tokenizeShellCommand(command)).flatMap((segment) => {
    const invocation = invocationOf(segment)
    const script = invocation && depth < MaxNestedScriptDepth ? nestedScriptOf(invocation) : null
    return script ? [segment, ...parseCommandSegments(script, depth + 1)] : [segment]
  })
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

/** 跳过 Git 全局选项找到子命令的下标；`git -C sub reset --hard` 与 `git reset --hard` 是同一条。 */
function findGitSubcommandIndex(args: readonly string[]): number {
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]
    if (!token.startsWith('-')) return index
    if (GitGlobalOptionsWithValue.has(token)) index += 1
  }
  return -1
}

/** 段内每个 `git` token 后面那条子命令的下标（段内坐标）；`git` 出现在哪都算，理由见文件头注。 */
function gitSubcommandIndices(segment: readonly string[]): number[] {
  return segment.flatMap((token, index) => {
    if (executableName(token) !== 'git') return []
    const offset = findGitSubcommandIndex(segment.slice(index + 1))
    return offset < 0 ? [] : [index + 1 + offset]
  })
}

function resolveGitDangerReason(segments: ReadonlyArray<readonly string[]>): Nullable<string> {
  for (const segment of segments) {
    for (const subcommandIndex of gitSubcommandIndices(segment)) {
      const rule = GitInvocationRules.find((candidate) => candidate.subcommand === segment[subcommandIndex])
      if (rule && !rule.isHarmless?.(argsBeforePathspec(segment.slice(subcommandIndex + 1)))) return rule.reason
    }
  }
  return null
}

/** `chmod 777` / `a+w` 这类把文件放开成全局可写的授权（平台侧只覆盖 `chmod -R`）。 */
function hasWorldWritableChmod(invocations: readonly ShellInvocation[]): boolean {
  return invocations.some(({ name, args }) => {
    if (name !== 'chmod') return false
    const mode = args.find((candidate) => !candidate.startsWith('-'))?.toLowerCase()
    return mode === '777' || mode === '0777' || mode === 'a+w' || mode === 'ugo+w'
  })
}

/** 命令的路径实参：去掉选项（cmd.exe 原生命令的 `/x` 开关也是选项）和重定向（`2> err.log` 连同目标）。 */
function pathOperands({ name, args }: ShellInvocation): string[] {
  const operands: string[] = []
  let optionsEnded = false
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (RedirectionTokens.has(arg)) {
      index += 1
      continue
    }
    // `2>` 里的 2 是文件描述符。
    if (/^\d+$/u.test(arg) && RedirectionTokens.has(args[index + 1] ?? '')) continue
    if (!optionsEnded && arg === '--') {
      optionsEnded = true
      continue
    }
    const isOption = arg.startsWith('-') || (CmdNativeCommands.has(name) && arg.startsWith('/'))
    if (optionsEnded || !isOption) operands.push(arg)
  }
  return operands
}

/** 显式写出的复制目的地：`cp -t DIR`、`cp --target-directory=DIR`、`Copy-Item -Destination DIR`。 */
function explicitCopyDestination(args: readonly string[]): Nullable<string> {
  for (const [index, arg] of args.entries()) {
    if (arg === '-t' || arg === '--target-directory' || arg.toLowerCase() === '-destination') return args[index + 1] ?? null
    const inline = /^(?:--target-directory=|-destination:)(.+)$/iu.exec(arg)
    if (inline) return inline[1]
  }
  return null
}

/** 命令会写入的路径。复制类只写目的地：robocopy / Copy-Item 是第二个位置实参（robocopy 其后是文件过滤），其余是最后一个。 */
function writeTargets(invocation: ShellInvocation): string[] {
  const operands = pathOperands(invocation)
  if (!CopyCommands.has(invocation.name)) return operands

  const destination = explicitCopyDestination(invocation.args)
  if (destination) return [destination]
  if (invocation.name === 'robocopy' || invocation.name === 'copy-item') return operands.slice(1, 2)
  return operands.length > 1 ? operands.slice(-1) : []
}

function isOutsideWorkspace(candidate: string, projectRoot: string): boolean {
  const path = candidate === '~' || candidate.startsWith('~/') ? join(homedir(), candidate.slice(1)) : candidate
  return isAbsolute(path) && !isPathInsideRoot(projectRoot, path)
}

/** 写操作第一个落在工作区外的写入目标（绝对路径或 `~`）；工作区内的绝对路径照常放行。 */
function findOutsideWorkspaceTarget(invocations: readonly ShellInvocation[], projectRoot: string): Nullable<string> {
  for (const invocation of invocations) {
    if (!PathMutatingCommands.has(invocation.name)) continue
    const target = writeTargets(invocation).find((candidate) => isOutsideWorkspace(candidate, projectRoot))
    if (target) return target
  }
  return null
}

/** Workbench 特有的补充危险判定；返回 null 表示「按平台结论走」。 */
function resolveWorkspaceIntegrityDangerReason(command: string, projectRoot: string): Nullable<string> {
  const segments = parseCommandSegments(command)
  if (isEmpty(segments)) return null
  const invocations = segments.flatMap((segment) => invocationOf(segment) ?? [])
  const lowered = segments.flat().map((token) => token.toLowerCase())

  const gitReason = resolveGitDangerReason(segments)
  if (gitReason) return gitReason

  if (containsTokenSequence(lowered, ['gh', 'pr', 'checkout'])) return '命令会通过 GitHub CLI 切换分支或修改当前工作区。'

  if (hasWorldWritableChmod(invocations)) return '命令会把文件权限改成 777 或全局可写，可能扩大写入和执行权限。'

  const outsideTarget = findOutsideWorkspaceTarget(invocations, projectRoot)
  if (outsideTarget) return `命令会改动当前工作区之外的路径 ${outsideTarget}。`

  if (lowered.includes('halt') || lowered.includes('poweroff')) return '命令可能会关闭、重启或中断当前系统环境。'

  // `diskutil erase` 之外还要覆盖 eraseDisk / eraseVolume 这类拼接子命令。
  const erasesDisk =
    containsTokenSequence(lowered, ['diskutil', 'erase'])
    || invocations.some(({ name, args }) => name === 'diskutil' && !!args[0]?.toLowerCase().startsWith('erase'))
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
