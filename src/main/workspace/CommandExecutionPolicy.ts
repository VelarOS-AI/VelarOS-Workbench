import { isPresent, isString, isTrue } from '@velaros-ai/core'
import { isEmpty } from '@velaros-ai/core'

import {
  containsTokenSequence,
  hasStandaloneBackgroundOperator,
  parsePortMappingToken,
  parsePortValue,
  tokenizeShellCommand,
} from './CommandParsingHelper'

/** 命令执行前的策略分析结果。 */
interface CommandExecutionPlan {
  /** 是否是已知只读探查命令；用于权限、审批和 workspace mutation preflight 共享同一判断。 */
  isReadOnly: boolean
  /** 是否需要弹出确认；危险命令或长期驻留命令都需要。 */
  shouldRequestConfirmation: boolean
  /** 是否建议走后台任务管理，而不是阻塞当前工具调用。 */
  shouldStartInBackground: boolean
  /** 长期运行判断原因。 */
  reason: Nullable<string>
  /** 是否命中高风险命令规则。 */
  isDangerous: boolean
  /** 高风险判断原因。 */
  dangerousReason: Nullable<string>
  /** 从命令中提取到的端口，用于确认文案提示用户。 */
  ports: number[]
}

/** 从 shell 命令中尽量提取端口号，支持 --port、-p、冒号映射等常见写法。 */
function extractPorts(command: string): number[] {
  const tokens = tokenizeShellCommand(command)
  const ports = new Set<number>()

  tokens.forEach((token, index) => {
    const normalized = token.toLowerCase()

    // CLI 常见写法：--port 3000 或 -p 3000。
    if (normalized === '--port' || normalized === '-p') {
      const nextToken = tokens[index + 1]
      if (!nextToken) return

      const singlePort = parsePortValue(nextToken)
      if (isPresent(singlePort)) {
        ports.add(singlePort)
        return
      }

      parsePortMappingToken(nextToken).forEach((value) => ports.add(value))
      return
    }

    // CLI 常见写法：--port=3000。
    if (normalized.startsWith('--port=')) {
      const parsed = parsePortValue(token.slice('--port='.length))
      if (isPresent(parsed)) {
        ports.add(parsed)
      }
      return
    }

    // Docker/SSH 等常见映射写法：8080:80、127.0.0.1:5173:5173。
    parsePortMappingToken(token).forEach((value) => ports.add(value))

    // python -m http.server 8000 中端口在 http.server 后面。
    if (normalized === 'http.server') {
      const nextToken = tokens[index + 1]
      const parsed = nextToken ? parsePortValue(nextToken) : null
      if (isPresent(parsed)) {
        ports.add(parsed)
      }
      return
    }

    // kubectl port-forward 的参数形态较多，从后续 token 中找第一个端口或映射。
    if (normalized === 'port-forward') {
      for (let cursor = index + 1; cursor < tokens.length; cursor += 1) {
        const candidate = tokens[cursor]
        const singlePort = parsePortValue(candidate)
        if (isPresent(singlePort)) {
          ports.add(singlePort)
          break
        }

        const mappedPorts = parsePortMappingToken(candidate)
        if (mappedPorts.length) {
          mappedPorts.forEach((value) => ports.add(value))
          break
        }
      }
    }
  })

  return [...ports].sort((left, right) => left - right)
}

/**
 * 判断命令是否可能长期驻留。
 *
 * 这个函数只给“需要后台运行/确认”的理由，不负责真正执行；执行层会根据
 * CommandExecutionPlan 决定走前台命令还是 background task。
 */
function resolveLongRunningReason(command: string): Nullable<string> {
  const tokens = tokenizeShellCommand(command)
  const normalizedTokens = tokens.map((token) => token.toLowerCase())
  if (isEmpty(normalizedTokens)) return null

  const rawCommandTokens = normalizeShellCommandPositionSegment(tokens)
  const commandTokens = normalizeShellCommandPositionSegment(normalizedTokens)
  const firstToken = commandTokens[0]

  // npm/pnpm/yarn/bun dev/start/serve/preview 通常是开发服务器。
  if (
    firstToken === 'npm' ||
    firstToken === 'pnpm' ||
    firstToken === 'yarn' ||
    firstToken === 'bun'
  ) {
    const scriptIndex = commandTokens[1] === 'run' ? 2 : 1
    const scriptName = commandTokens[scriptIndex]
    if (
      scriptName === 'dev' ||
      scriptName === 'start' ||
      scriptName === 'serve' ||
      scriptName === 'preview'
    ) return '命令看起来会启动开发服务器或预览服务。'
  }

  if (hasDevelopmentTaskPrefix(commandTokens)) return '命令看起来会启动开发服务器或预览服务。'

  // 前端开发框架的直接命令，不一定经过 package manager。
  if (
    normalizedTokens.includes('vite') ||
    normalizedTokens.includes('webpack-dev-server') ||
    containsTokenSequence(normalizedTokens, ['next', 'dev']) ||
    containsTokenSequence(normalizedTokens, ['astro', 'dev']) ||
    containsTokenSequence(normalizedTokens, ['nuxt', 'dev'])
  ) return '命令看起来会启动前端开发服务。'

  // Python Web 服务和静态文件服务。
  if (
    normalizedTokens.includes('uvicorn') ||
    normalizedTokens.includes('gunicorn') ||
    containsTokenSequence(normalizedTokens, ['python', '-m', 'http.server']) ||
    containsTokenSequence(normalizedTokens, ['python3', '-m', 'http.server']) ||
    containsTokenSequence(normalizedTokens, ['flask', 'run']) ||
    containsTokenSequence(normalizedTokens, ['django-admin', 'runserver'])
  ) return '命令看起来会启动 Python 服务。'

  // 容器、端口转发和 SSH 隧道都会长期占用进程/端口。
  if (
    containsTokenSequence(commandTokens, ['docker', 'compose', 'up']) ||
    containsTokenSequence(commandTokens, ['docker-compose', 'up']) ||
    containsTokenSequence(commandTokens, ['kubectl', 'port-forward']) ||
    containsExactSequence(rawCommandTokens, ['ssh', '-L'])
  ) return '命令看起来会建立长期端口映射或容器服务。'

  // 日志跟随、watch、热重载这类命令通常不会自己结束。
  if (
    containsTokenSequence(normalizedTokens, ['tail', '-f']) ||
    normalizedTokens.includes('watch') ||
    normalizedTokens.includes('nodemon') ||
    normalizedTokens.includes('ts-node-dev') ||
    normalizedTokens.includes('--watch')
  ) return '命令看起来会持续监听文件或保持常驻。'

  // 用户显式要求脱离终端或后台执行。
  if (firstToken === 'nohup' || firstToken === 'setsid') return '命令显式请求以后台或脱离终端方式运行。'

  if (hasStandaloneBackgroundOperator(tokens)) return '命令显式包含后台执行操作符。'

  return null
}

/** 判断命令是否命中明显危险模式，需要用户显式确认。 */
function resolveDangerousReason(command: string): Nullable<string> {
  const normalizedTokens = tokenizeShellCommand(command).map((token) => token.toLowerCase())
  if (isEmpty(normalizedTokens)) return null

  if (normalizedTokens.includes('sudo')) return '命令包含 sudo，可能触发提权或修改系统级资源。'

  if (
    normalizedTokens.includes('shutdown') ||
    normalizedTokens.includes('reboot') ||
    normalizedTokens.includes('halt') ||
    normalizedTokens.includes('poweroff')
  ) return '命令可能会关闭、重启或中断当前系统环境。'

  if (normalizedTokens.includes('mkfs')) return '命令可能会格式化磁盘或破坏现有文件系统。'

  if (hasRecursiveForceRemove(normalizedTokens)) return '命令包含高风险的递归删除模式。'

  if (hasWorldWritableChmod(normalizedTokens)) return '命令会把文件权限改成 777 或全局可写，可能扩大写入和执行权限。'

  if (hasAbsolutePathMutation(normalizedTokens)) return '命令会修改绝对路径；如果目标不在当前工作区内，可能影响项目外文件。'

  if (containsTokenSequence(normalizedTokens, ['git', 'reset'])) return '命令会重置 Git 状态，可能丢弃或覆盖当前工作区变更。'

  if (containsTokenSequence(normalizedTokens, ['git', 'switch'])) return '命令会切换 Git 分支，可能打断其他智能体或工作台正在进行的工作。'

  if (containsTokenSequence(normalizedTokens, ['git', 'checkout'])) return '命令会切换 Git 分支或恢复文件，可能覆盖当前工作区变更。'

  if (containsTokenSequence(normalizedTokens, ['git', 'pull'])) return '命令会更新当前 Git HEAD，可能与正在进行的文件修改冲突。'

  if (containsTokenSequence(normalizedTokens, ['git', 'merge'])) return '命令会合并 Git 历史，可能改写当前工作区内容。'

  if (containsTokenSequence(normalizedTokens, ['git', 'rebase'])) return '命令会变基 Git 历史，可能改写提交或工作区内容。'

  if (containsTokenSequence(normalizedTokens, ['git', 'revert'])) return '命令会创建回退提交，可能与当前工作区变更冲突。'

  if (containsTokenSequence(normalizedTokens, ['git', 'clean'])) return '命令会清理未跟踪文件，可能删除尚未提交的工作内容。'

  if (containsTokenSequence(normalizedTokens, ['git', 'restore'])) return '命令会恢复文件内容，可能覆盖当前工作区变更。'

  if (containsTokenSequence(normalizedTokens, ['git', 'checkout', '--'])) return '命令会从 Git 恢复文件，可能覆盖当前工作区变更。'

  if (
    containsTokenSequence(normalizedTokens, ['git', 'push']) &&
    normalizedTokens.some((token) => token === '-f' || token.startsWith('--force'))
  ) return '命令会强制推送 Git 分支，可能覆盖远端历史。'

  if (hasShellCommandPrefix(normalizedTokens, ['gh', 'pr', 'checkout'])) return '命令会通过 GitHub CLI 切换分支或修改当前工作区。'

  if (normalizedTokens[0] === 'dd' && normalizedTokens.some((token) => token.startsWith('if='))) return '命令看起来会执行底层磁盘或块设备复制。'

  if (containsTokenSequence(normalizedTokens, ['diskutil', 'erase'])) return '命令看起来会抹除磁盘或卷。'

  if (normalizedTokens[0] === 'diskutil' && !!normalizedTokens[1]?.startsWith('erase')) return '命令看起来会抹除磁盘或卷。'

  if (
    normalizedTokens.some((token) =>
      [
        'clear-disk',
        'diskpart',
        'format',
        'format.com',
        'format-volume',
        'initialize-disk',
        'remove-partition',
      ].includes(token)
    )
  ) return '命令可能会格式化、初始化或修改 Windows 磁盘分区。'

  if (
    normalizedTokens.includes('stop-computer') ||
    normalizedTokens.includes('restart-computer')
  ) return '命令可能会关闭或重启当前 Windows 系统。'

  if (
    containsTokenSequence(normalizedTokens, ['reg', 'delete']) ||
    containsTokenSequence(normalizedTokens, ['reg.exe', 'delete']) ||
    normalizedTokens.includes('bcdedit') ||
    normalizedTokens.includes('bcdedit.exe')
  ) return '命令可能会删除 Windows 注册表项或修改启动配置。'

  if (hasWindowsRecursiveForceRemove(normalizedTokens)) return '命令包含 Windows 高风险递归删除模式。'

  return null
}

const MutatingCommandNames = new Set([
  'chmod',
  'chown',
  'clear-content',
  'copy',
  'copy-item',
  'cp',
  'del',
  'erase',
  'install',
  'md',
  'mkdir',
  'move',
  'move-item',
  'mv',
  'new-item',
  'out-file',
  'rd',
  'remove-item',
  'ren',
  'rename',
  'rename-item',
  'rm',
  'rmdir',
  'robocopy',
  'set-content',
  'touch',
  'truncate',
  'xcopy',
])

const MutatingPackageManagers = new Set(['bun', 'npm', 'pnpm', 'yarn'])
const MutatingPackageManagerSubcommands = new Set([
  'add',
  'dedupe',
  'i',
  'install',
  'link',
  'prune',
  'remove',
  'rm',
  'uninstall',
  'unlink',
  'update',
  'upgrade',
])

const ShellCommandBoundaryTokens = new Set(['&&', '||', ';', '|', '('])

const MutatingCommandPrefixes: ReadonlyArray<readonly string[]> = [
  ['cargo', 'add'],
  ['cargo', 'install'],
  ['cargo', 'remove'],
  ['composer', 'install'],
  ['composer', 'remove'],
  ['composer', 'require'],
  ['docker', 'builder', 'prune'],
  ['docker', 'container', 'prune'],
  ['docker', 'container', 'rm'],
  ['docker', 'container', 'restart'],
  ['docker', 'container', 'stop'],
  ['docker', 'image', 'prune'],
  ['docker', 'network', 'prune'],
  ['docker', 'volume', 'prune'],
  ['docker', 'volume', 'rm'],
  ['gh', 'pr', 'checkout'],
  ['helm', 'delete'],
  ['helm', 'install'],
  ['helm', 'rollback'],
  ['helm', 'uninstall'],
  ['helm', 'upgrade'],
  ['kubectl', 'apply'],
  ['kubectl', 'delete'],
  ['kubectl', 'patch'],
  ['kubectl', 'rollout', 'restart'],
  ['kubectl', 'scale'],
  ['kubectl', 'set'],
  ['pip', 'install'],
  ['pip', 'uninstall'],
  ['pip3', 'install'],
  ['pip3', 'uninstall'],
  ['poetry', 'add'],
  ['poetry', 'install'],
  ['poetry', 'lock'],
  ['poetry', 'remove'],
  ['poetry', 'update'],
  ['terraform', 'apply'],
  ['terraform', 'destroy'],
  ['terraform', 'import'],
  ['terraform', 'state', 'mv'],
  ['terraform', 'state', 'rm'],
  ['terraform', 'taint'],
  ['terraform', 'untaint'],
  ['uv', 'add'],
  ['uv', 'pip', 'install'],
  ['uv', 'pip', 'uninstall'],
  ['uv', 'remove'],
  ['uv', 'sync'],
]

const PythonInlineWritePattern =
  /\bopen\s*\([^)]*,\s*['"](?:a|ab|a\+|ab\+|w|wb|w\+|wb\+|x|xb|x\+|xb\+)['"]/iu

const AwkInlineSystemPattern = /\bawk\b[\s\S]*\bsystem\s*\(/iu
const AwkInlineOutputRedirectPattern = /\bawk\b[\s\S]*\b(?:print|printf)\b[\s\S]*>\s*["'][^"']+["']/iu

const ReadOnlyShellCommands = new Set([
  '[',
  'basename',
  'cat',
  'cd',
  'cmp',
  'comm',
  'cut',
  'date',
  'df',
  'diff',
  'dirname',
  'du',
  'echo',
  'egrep',
  'env',
  'false',
  'fgrep',
  'file',
  'find',
  'grep',
  'head',
  'help',
  'hostname',
  'htop',
  'id',
  'info',
  'less',
  'locate',
  'ls',
  'man',
  'more',
  'printenv',
  'printf',
  'ps',
  'pwd',
  'readlink',
  'realpath',
  'rg',
  'sort',
  'stat',
  'tail',
  'test',
  'top',
  'tr',
  'tree',
  'true',
  'type',
  'uname',
  'uniq',
  'wc',
  'whereis',
  'which',
  'xargs',
])

const ReadOnlyPrefixSubcommands: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ['cargo', new Set(['check', 'doc', 'search'])],
  ['docker', new Set(['images', 'info', 'inspect', 'logs', 'ps', 'stats', 'version'])],
  [
    'git',
    new Set([
      'blame',
      'cat-file',
      'cherry',
      'describe',
      'diff',
      'for-each-ref',
      'grep',
      'log',
      'ls-files',
      'ls-tree',
      'name-rev',
      'rev-list',
      'rev-parse',
      'reflog',
      'shortlog',
      'show',
      'status',
      'tag',
      'whatchanged',
    ]),
  ],
  ['go', new Set(['doc', 'env', 'list', 'version', 'vet'])],
  ['kubectl', new Set(['api-resources', 'api-versions', 'describe', 'explain', 'get', 'logs'])],
  ['npm', new Set(['audit', 'info', 'list', 'ls', 'outdated', 'view'])],
])

const ReadOnlyCommandPrefixes: ReadonlyArray<readonly string[]> = [
  ['docker', 'container', 'inspect'],
  ['docker', 'container', 'ls'],
  ['docker', 'image', 'inspect'],
  ['docker', 'image', 'ls'],
  ['docker', 'network', 'inspect'],
  ['docker', 'network', 'ls'],
  ['docker', 'volume', 'inspect'],
  ['docker', 'volume', 'ls'],
  ['gh', 'issue', 'list'],
  ['gh', 'issue', 'status'],
  ['gh', 'issue', 'view'],
  ['gh', 'pr', 'checks'],
  ['gh', 'pr', 'diff'],
  ['gh', 'pr', 'list'],
  ['gh', 'pr', 'status'],
  ['gh', 'pr', 'view'],
  ['gh', 'repo', 'list'],
  ['gh', 'repo', 'view'],
  ['gh', 'run', 'list'],
  ['gh', 'run', 'view'],
  ['gh', 'workflow', 'list'],
  ['gh', 'workflow', 'view'],
  ['kubectl', 'rollout', 'history'],
  ['kubectl', 'rollout', 'status'],
]

const ReadOnlySegmentSeparators = new Set(['&&', '||', ';', '|'])
const ReadOnlyUnsafeSyntaxTokens = new Set(['&', '<', '>', '>>', '>|', '<<', '(', ')'])

function isShellCommandLikelyMutating(command: string): boolean {
  const trimmed = command.trim()
  if (!trimmed) return false

  const tokens = tokenizeShellCommand(trimmed)
  const normalizedTokens = stripReadOnlyStderrRedirections(
    tokens.map((token) => token.toLowerCase())
  )
  if (
    normalizedTokens.includes('>') ||
    normalizedTokens.includes('>>') ||
    normalizedTokens.includes('>|')
  ) return true

  if (PythonInlineWritePattern.test(trimmed)) return true
  if (AwkInlineSystemPattern.test(trimmed) || AwkInlineOutputRedirectPattern.test(trimmed)) return true

  return normalizedTokens.some((token, index) => {
    if (!isShellCommandPosition(normalizedTokens, index)) return false

    if (MutatingCommandNames.has(token)) return true
    if (hasMutatingCommandPrefix(normalizedTokens, index)) return true
    if (isPackageManagerMutation(normalizedTokens, index)) return true
    if (isCommandOptionMutation(normalizedTokens, index)) return true
    if (token === 'tee' && hasCommandArgument(normalizedTokens, index)) return true
    if ((token === 'sed' || token === 'perl') && hasCommandOption(normalizedTokens, index, '-i')) return true
    if (token === 'find' && hasAnyCommandToken(normalizedTokens, index, ['-delete', '-exec'])) return true
    if (token === 'xargs' && isXargsMutation(normalizedTokens, index)) return true
    return false
  })
}

function isShellCommandReadOnly(command: string): boolean {
  const trimmed = command.trim()
  if (!trimmed) return false
  if (/[\r\n]/.test(trimmed)) return false
  if (trimmed.includes('$(') || trimmed.includes('`')) return false
  if (isShellCommandLikelyMutating(trimmed)) return false

  const tokens = stripReadOnlyStderrRedirections(tokenizeShellCommand(trimmed))
  if (isEmpty(tokens)) return false
  if (tokens.some((token) => ReadOnlyUnsafeSyntaxTokens.has(token))) return false

  const segments = splitReadOnlyShellSegments(tokens)
  return !isEmpty(segments) && segments.every(isReadOnlyShellSegment)
}

function splitReadOnlyShellSegments(tokens: readonly string[]): string[][] {
  const segments: string[][] = []
  let current: string[] = []

  for (const token of tokens) {
    if (!ReadOnlySegmentSeparators.has(token)) {
      current.push(token)
      continue
    }

    if (isEmpty(current)) return []
    segments.push(current)
    current = []
  }

  if (isEmpty(current)) return []
  segments.push(current)
  return segments
}

function stripReadOnlyStderrRedirections(tokens: readonly string[]): string[] {
  const stripped: string[] = []

  for (let cursor = 0; cursor < tokens.length; cursor += 1) {
    const token = tokens[cursor]
    if (token !== '2') {
      stripped.push(token)
      continue
    }

    const operator = tokens[cursor + 1]
    const target = tokens[cursor + 2]
    if ((operator === '>' || operator === '>>') && target === '/dev/null') {
      cursor += 2
      continue
    }

    if (operator === '>' && target === '&' && tokens[cursor + 3] === '1') {
      cursor += 3
      continue
    }

    stripped.push(token)
  }

  return stripped
}

function isReadOnlyShellSegment(rawTokens: readonly string[]): boolean {
  const tokens = normalizeReadOnlyShellSegment(rawTokens)
  if (isEmpty(tokens)) return false

  if (tokens[0] === 'command' && tokens[1] === '-v') return isString(tokens[2])

  const command = tokens[0]
  if (ReadOnlyShellCommands.has(command)) return !hasUnsafeReadOnlyArgs(command, tokens.slice(1))
  if (matchesAnyCommandPrefix(tokens, ReadOnlyCommandPrefixes)) return true

  const subcommands = ReadOnlyPrefixSubcommands.get(command)
  const subcommand = tokens[1]
  return isString(subcommand) &&
    !!subcommands?.has(subcommand) &&
    !hasUnsafeReadOnlyPrefixArgs(command, subcommand, tokens.slice(2))
}

function normalizeReadOnlyShellSegment(rawTokens: readonly string[]): string[] {
  const tokens = rawTokens.map((token) => token.toLowerCase())
  return normalizeExecutableShellSegment(tokens, {
    preserveCommandLookup: true,
    stripSudo: false,
  })
}

function normalizeShellCommandPositionSegment(tokens: readonly string[]): string[] {
  return normalizeExecutableShellSegment(tokens, {
    preserveCommandLookup: false,
    stripSudo: true,
  })
}

function normalizeExecutableShellSegment(
  tokens: readonly string[],
  options: {
    preserveCommandLookup: boolean
    stripSudo: boolean
  }
): string[] {
  let cursor = 0

  while (cursor < tokens.length) {
    const before = cursor

    while (isShellAssignmentToken(tokens[cursor] ?? '')) cursor += 1
    while (tokens[cursor] === 'builtin') cursor += 1

    if (tokens[cursor] === 'command') {
      if (options.preserveCommandLookup && tokens[cursor + 1] === '-v') return tokens.slice(cursor)
      cursor += 1
    }

    if (options.stripSudo && tokens[cursor] === 'sudo') {
      cursor = skipSudoPrefix(tokens, cursor)
    }

    if (tokens[cursor] === 'env') {
      cursor = skipEnvPrefix(tokens, cursor)
    }

    cursor = skipNeutralShellWrappers(tokens, cursor)

    if (cursor === before) break
  }

  return tokens.slice(cursor)
}

function skipEnvPrefix(tokens: readonly string[], cursor: number): number {
  let next = cursor + 1

  while (
    next < tokens.length &&
    (tokens[next]!.startsWith('-') || isShellAssignmentToken(tokens[next]!))
  ) next += 1

  return next
}

function skipSudoPrefix(tokens: readonly string[], cursor: number): number {
  let next = cursor + 1

  while (next < tokens.length) {
    const token = tokens[next]!
    if (!token.startsWith('-')) break
    if (token === '--') {
      next += 1
      break
    }

    next += getSudoOptionTokenCount(token)
  }

  return next
}

function getSudoOptionTokenCount(token: string): number {
  if (token.includes('=')) return 1
  if (/^-[A-Za-z0-9].+/u.test(token) && !['-u', '-g', '-h', '-p', '-C', '-T', '-t'].includes(token)) return 1
  if (
    token === '-u' ||
    token === '-g' ||
    token === '-h' ||
    token === '-p' ||
    token === '-C' ||
    token === '-T' ||
    token === '-t' ||
    token === '--user' ||
    token === '--group' ||
    token === '--host' ||
    token === '--prompt' ||
    token === '--chdir' ||
    token === '--login-class' ||
    token === '--role' ||
    token === '--type' ||
    token === '--command-timeout' ||
    token === '--close-from'
  ) return 2

  return 1
}

function skipNeutralShellWrappers(tokens: readonly string[], cursor: number): number {
  switch (tokens[cursor]) {
    case 'time':
      return skipTimePrefix(tokens, cursor)
    case 'timeout':
      return skipTimeoutPrefix(tokens, cursor)
    case 'nice':
      return skipNicePrefix(tokens, cursor)
    default:
      return cursor
  }
}

function skipTimePrefix(tokens: readonly string[], cursor: number): number {
  let next = cursor + 1
  while (next < tokens.length && tokens[next]!.startsWith('-')) next += 1
  return next
}

function skipTimeoutPrefix(tokens: readonly string[], cursor: number): number {
  let next = cursor + 1

  while (next < tokens.length) {
    const token = tokens[next]!
    if (!token.startsWith('-')) break
    if (token === '--') {
      next += 1
      break
    }

    next += getTimeoutOptionTokenCount(token)
  }

  if (next < tokens.length) next += 1
  return next
}

function getTimeoutOptionTokenCount(token: string): number {
  if (token.includes('=')) return 1
  if (
    token === '-k' ||
    token === '-s' ||
    token === '--kill-after' ||
    token === '--signal'
  ) return 2

  return 1
}

function skipNicePrefix(tokens: readonly string[], cursor: number): number {
  let next = cursor + 1

  while (next < tokens.length) {
    const token = tokens[next]!
    if (!token.startsWith('-')) break
    if (token === '--') {
      next += 1
      break
    }

    next += getNiceOptionTokenCount(token)
  }

  return next
}

function getNiceOptionTokenCount(token: string): number {
  if (token.includes('=')) return 1
  if (token === '-n' || token === '--adjustment') return 2
  return 1
}

function hasDevelopmentTaskPrefix(tokens: readonly string[]): boolean {
  return (
    matchesAnyCommandPrefix(tokens, [
      ['deno', 'task', 'dev'],
      ['deno', 'task', 'serve'],
      ['deno', 'task', 'start'],
      ['deno', 'task', 'preview'],
      ['turbo', 'run', 'dev'],
      ['turbo', 'run', 'serve'],
      ['turbo', 'run', 'start'],
      ['turbo', 'run', 'preview'],
    ])
  )
}

function hasMutatingCommandPrefix(tokens: readonly string[], index: number): boolean {
  return matchesAnyCommandPrefix(commandTokensAt(tokens, index), MutatingCommandPrefixes)
}

function hasShellCommandPrefix(tokens: readonly string[], prefix: readonly string[]): boolean {
  return tokens.some(
    (token, index) =>
      token === prefix[0] &&
      isShellCommandPosition(tokens, index) &&
      matchesCommandPrefix(commandTokensAt(tokens, index), prefix)
  )
}

function commandTokensAt(tokens: readonly string[], index: number): string[] {
  return [tokens[index]!, ...commandTail(tokens, index)]
}

function matchesAnyCommandPrefix(
  tokens: readonly string[],
  prefixes: ReadonlyArray<readonly string[]>
): boolean {
  return prefixes.some((prefix) => matchesCommandPrefix(tokens, prefix))
}

function matchesCommandPrefix(tokens: readonly string[], prefix: readonly string[]): boolean {
  if (prefix.length > tokens.length) return false

  for (let index = 0; index < prefix.length; index += 1) {
    if (tokens[index] !== prefix[index]) return false
  }

  return true
}

function hasUnsafeReadOnlyArgs(command: string, args: readonly string[]): boolean {
  switch (command) {
    case 'find':
      return args.some((arg) => arg === '-delete' || arg === '-exec' || arg === '-execdir')
    case 'xargs':
      return !isReadOnlyXargsArgs(args)
    case 'sort':
      return args.some((arg) =>
        arg === '-o' || arg.startsWith('-o') || arg === '--output' || arg.startsWith('--output=')
      )
    default:
      return false
  }
}

function hasUnsafeReadOnlyPrefixArgs(
  command: string,
  subcommand: string,
  args: readonly string[]
): boolean {
  if (command === 'git' && ['diff', 'show', 'log'].includes(subcommand)) return args.some((arg) => arg === '--output' || arg.startsWith('--output='))

  if (command === 'go' && subcommand === 'env') return args.some((arg) => arg === '-w' || arg === '-u')

  return false
}

function isReadOnlyXargsArgs(args: readonly string[]): boolean {
  const commandIndex = findXargsCommandIndex(args)
  if (commandIndex < 0) return false

  return isReadOnlyShellSegment(args.slice(commandIndex))
}

function isShellCommandPosition(tokens: readonly string[], index: number): boolean {
  const token = tokens[index]
  if (!token) return false

  let segmentStart = 0
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    if (!ShellCommandBoundaryTokens.has(tokens[cursor])) continue

    segmentStart = cursor + 1
    break
  }

  const normalized = normalizeShellCommandPositionSegment(tokens.slice(segmentStart, index + 1))
  return normalized.length === 1 && normalized[0] === token
}

function isShellAssignmentToken(token: string): boolean {
  const equalIndex = token.indexOf('=')
  if (equalIndex <= 0) return false

  const name = token.slice(0, equalIndex)
  return /^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)
}

function isPackageManagerMutation(tokens: readonly string[], index: number): boolean {
  if (!MutatingPackageManagers.has(tokens[index])) return false

  const subcommand = nextCommandToken(tokens, index)
  return isString(subcommand) && MutatingPackageManagerSubcommands.has(subcommand)
}

function isCommandOptionMutation(tokens: readonly string[], index: number): boolean {
  const command = tokens[index]
  const subcommand = nextCommandToken(tokens, index)

  if (command === 'git' && isString(subcommand)) {
    if (
      ['diff', 'show', 'log'].includes(subcommand) &&
      hasAnyCommandOption(tokens, index, ['--output'])
    ) return true
    if (subcommand === 'archive' && hasAnyCommandOption(tokens, index, ['--output', '-o'])) return true
    if (subcommand === 'bundle' && hasAnyCommandToken(tokens, index, ['create'])) return true
  }

  if (command === 'gofmt' && hasAnyCommandToken(tokens, index, ['-w'])) return true

  if (command === 'go' && subcommand === 'env') {
    if (hasAnyCommandToken(tokens, index, ['-w', '-u'])) return true
  }

  if (command === 'sort') {
    if (hasCommandOption(tokens, index, '-o') || hasAnyCommandOption(tokens, index, ['--output'])) return true
  }

  return false
}

function hasCommandOption(tokens: readonly string[], index: number, option: string): boolean {
  return commandTail(tokens, index).some((candidate) => candidate === option || candidate.startsWith(option))
}

function hasAnyCommandOption(
  tokens: readonly string[],
  index: number,
  candidates: readonly string[]
): boolean {
  return commandTail(tokens, index).some((candidate) =>
    candidates.some((option) => candidate === option || candidate.startsWith(`${option}=`))
  )
}

function hasAnyCommandToken(
  tokens: readonly string[],
  index: number,
  candidates: readonly string[]
): boolean {
  return commandTail(tokens, index).some((candidate) => candidates.includes(candidate))
}

function hasCommandArgument(tokens: readonly string[], index: number): boolean {
  return commandTail(tokens, index).some((candidate) => !candidate.startsWith('-'))
}

function nextCommandToken(tokens: readonly string[], index: number): Nullable<string> {
  const token = commandTail(tokens, index).find((candidate) => !candidate.startsWith('-'))
  return isString(token) ? token : null
}

function isXargsMutation(tokens: readonly string[], index: number): boolean {
  const tail = commandTail(tokens, index)
  const commandIndex = findXargsCommandIndex(tail)
  if (commandIndex < 0) return false

  const commandTokens = tail.slice(commandIndex)
  const command = commandTokens[0]
  if (!command) return false

  if (MutatingCommandNames.has(command)) return true
  if (matchesAnyCommandPrefix(commandTokens, MutatingCommandPrefixes)) return true
  if (isPackageManagerMutation(commandTokens, 0)) return true
  if (isCommandOptionMutation(commandTokens, 0)) return true
  if ((command === 'sed' || command === 'perl') && hasCommandOption(commandTokens, 0, '-i')) return true
  if (command === 'find' && hasAnyCommandToken(commandTokens, 0, ['-delete', '-exec'])) return true

  return false
}

function findXargsCommandIndex(tokens: readonly string[]): number {
  let cursor = 0

  while (cursor < tokens.length) {
    const token = tokens[cursor]
    if (token === '--') return cursor + 1 < tokens.length ? cursor + 1 : -1
    if (!token.startsWith('-') || token === '-') return cursor

    cursor += getXargsOptionTokenCount(token)
  }

  return -1
}

function getXargsOptionTokenCount(token: string): number {
  if (token.includes('=')) return 1
  if (/^-[EILnPs]$/u.test(token)) return 2
  if (/^-[EILnPs].+/u.test(token)) return 1
  if (
    token === '--arg-file' ||
    token === '--eof' ||
    token === '--max-args' ||
    token === '--max-chars' ||
    token === '--max-lines' ||
    token === '--max-procs' ||
    token === '--replace'
  ) return 2

  return 1
}

function commandTail(tokens: readonly string[], index: number): string[] {
  const tail: string[] = []
  for (let cursor = index + 1; cursor < tokens.length; cursor += 1) {
    const token = tokens[cursor]
    if (ShellCommandBoundaryTokens.has(token) || token === ')') break
    tail.push(token)
  }
  return tail
}

function hasRecursiveForceRemove(normalizedTokens: string[]): boolean {
  const rmIndex = normalizedTokens.indexOf('rm')
  if (rmIndex < 0) return false

  const rmArgs = normalizedTokens.slice(rmIndex + 1)
  let hasRecursiveFlag = false
  let hasForceFlag = false

  for (const token of rmArgs) {
    if (!token.startsWith('-') || token === '--') {
      continue
    }

    hasRecursiveFlag = hasRecursiveFlag || token.includes('r')
    hasForceFlag = hasForceFlag || token.includes('f')
  }

  return hasRecursiveFlag && hasForceFlag
}

function hasWindowsRecursiveForceRemove(normalizedTokens: string[]): boolean {
  return normalizedTokens.some((token, index) => {
    if (['rd', 'rmdir', 'del', 'erase'].includes(token)) {
      const args = commandTail(normalizedTokens, index)
      return args.includes('/s') && (args.includes('/q') || args.includes('/f'))
    }

    if (token !== 'remove-item') return false
    const args = commandTail(normalizedTokens, index)
    const hasRecursive = args.includes('-recurse') || args.includes('-r')
    const hasForce = args.includes('-force')
    return hasRecursive && hasForce
  })
}

function hasWorldWritableChmod(normalizedTokens: string[]): boolean {
  return normalizedTokens.some((token, index) => {
    if (token !== 'chmod' || !isShellCommandPosition(normalizedTokens, index)) return false

    const mode = commandTail(normalizedTokens, index).find((candidate) => !candidate.startsWith('-'))
    return mode === '777' || mode === '0777' || mode === 'a+w' || mode === 'ugo+w'
  })
}

function hasAbsolutePathMutation(normalizedTokens: string[]): boolean {
  const mutatingCommands = new Set([
    'rm',
    'mv',
    'cp',
    'chmod',
    'chown',
    'truncate',
    'touch',
    'mkdir',
    'rmdir',
    'copy',
    'xcopy',
    'robocopy',
    'move',
    'del',
    'erase',
    'rd',
    'ren',
    'rename',
    'copy-item',
    'move-item',
    'remove-item',
    'rename-item',
    'new-item',
    'set-content',
    'clear-content',
    'out-file',
  ])

  return normalizedTokens.some((token, index) => {
    if (!mutatingCommands.has(token)) return false

    return normalizedTokens.slice(index + 1).some((candidate) => {
      if (!candidate || candidate.startsWith('-')) return false

      return candidate.startsWith('/') || /^[a-z]:[\\/]/iu.test(candidate) || candidate.startsWith('\\\\')
    })
  })
}

/** 精确匹配 token 序列；用于 ssh -L 这类大小写不能随意归一化的判断。 */
function containsExactSequence(tokens: string[], sequence: string[]): boolean {
  if (isEmpty(sequence) || sequence.length > tokens.length) return false

  for (let index = 0; index <= tokens.length - sequence.length; index += 1) {
    let matched = true

    for (let offset = 0; offset < sequence.length; offset += 1) {
      if (tokens[index + offset] !== sequence[offset]) {
        matched = false
        break
      }
    }

    if (matched) return true
  }

  return false
}

/**
 * 汇总命令执行策略。
 *
 * 空命令直接返回安全计划；危险命令只要求确认，长期驻留命令会同时建议后台运行。
 */
function analyzeCommandExecution(command: string): CommandExecutionPlan {
  const trimmed = command.trim()
  if (!trimmed) return {
      isReadOnly: false,
      shouldRequestConfirmation: false,
      shouldStartInBackground: false,
      reason: null,
      isDangerous: false,
      dangerousReason: null,
      ports: [],
    }

  const isReadOnly = isShellCommandReadOnly(trimmed)
  const reason = resolveLongRunningReason(trimmed)
  const dangerousReason = resolveDangerousReason(trimmed)
  // 没有长期驻留特征时，只有危险命令需要确认，仍然保持前台执行。
  if (!reason) return {
      isReadOnly,
      shouldRequestConfirmation: !!dangerousReason,
      shouldStartInBackground: false,
      reason: null,
      isDangerous: !!dangerousReason,
      dangerousReason,
      ports: extractPorts(trimmed),
    }

  // 长期驻留命令默认建议放到后台，并把端口信息带给确认文案。
  return {
    isReadOnly,
    shouldRequestConfirmation: true,
    shouldStartInBackground: true,
    reason,
    isDangerous: !!dangerousReason,
    dangerousReason,
    ports: extractPorts(trimmed),
  }
}

/**
 * 判断命令工具是否可被 ToolExecutor 并行调度。
 *
 * 命令默认仍按有副作用处理；只有调用方显式声明 parallel=true，且命令不危险、
 * 不需要确认、不会自动转后台时，才允许与其他同类命令并发。
 */
function isParallelCommandSafe(input: {
  command?: unknown
  background?: unknown
  parallel?: unknown
}): boolean {
  if (!isTrue(input.parallel) || !isString(input.command) || !input.command.trim()) return false

  if (isTrue(input.background)) return false

  const plan = analyzeCommandExecution(input.command)
  return !isShellCommandLikelyMutating(input.command) &&
    !plan.shouldRequestConfirmation &&
    !plan.shouldStartInBackground &&
    !plan.isDangerous
}

function shouldReapForegroundProcessGroupAfterExit(command: string): boolean {
  const tokens = tokenizeShellCommand(command)
  if (!hasStandaloneBackgroundOperator(tokens)) return false

  const normalizedTokens = tokens.map((token) => token.toLowerCase())
  return !normalizedTokens.some((token) =>
    token === 'nohup' ||
    token === 'setsid' ||
    token === 'disown'
  )
}

/** 生成用户确认文案，区分危险命令和普通后台命令。 */
function buildBackgroundCommandNotice(
  command: string,
  plan: CommandExecutionPlan,
  scopeLabel: string,
  willRunInBackground: boolean
): string {
  // 端口只在能解析出来时提示，避免给用户噪声。
  const portSuffix = !isEmpty(plan.ports) ? ` 可能涉及端口：${plan.ports.join(', ')}。` : ''

  // 危险命令优先解释风险；如果同时长期运行，再补充后台任务说明。
  if (plan.isDangerous) return [
      `准备在${scopeLabel}执行高风险命令：${command}`,
      plan.dangerousReason ?? '该命令可能修改系统级资源或造成不可逆结果。',
      willRunInBackground
        ? `该命令还可能会长期驻留；执行后会返回可手动终止的命令。${portSuffix}`
        : '这是一次需要显式确认的危险操作。',
      '是否继续？',
    ].join('\n')

  return [
    `准备在${scopeLabel}启动一个可能长期驻留的命令：${command}`,
    plan.reason ?? '该命令可能会持续占用端口或保持后台运行。',
    `执行后会返回可手动终止的命令，便于你后续释放资源。${portSuffix}`,
    '是否继续？',
  ].join('\n')
}

export type { CommandExecutionPlan }
export {
  analyzeCommandExecution,
  buildBackgroundCommandNotice as buildBackgroundCommandConfirmationMessage,
  buildBackgroundCommandNotice,
  isParallelCommandSafe as isParallelCommandExecutionSafe,
  isParallelCommandSafe,
  isShellCommandLikelyMutating,
  isShellCommandReadOnly,
  shouldReapForegroundProcessGroupAfterExit,
}
