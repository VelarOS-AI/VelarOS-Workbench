import { createHash } from 'node:crypto'
import { mkdir, realpath, stat } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

import { execa } from 'execa'

import { AppError } from '@velaros-ai/core/error'

import type {
  WorkbenchChatCheckpointCaptureRequest,
  WorkbenchChatCheckpointCaptureResult,
  WorkbenchChatCheckpointDeleteRequest,
  WorkbenchChatRunFileChange,
  WorkbenchChatRunFileChangeStatus,
} from '../../../shared/workbenchGit'
import { workbenchMainText } from '../../i18n/workbenchMainMessages'

/**
 * 私有 ref 命名空间，与 Desktop 的会话检查点同一处：每个检查点单独成一个 ref（指向一个无父提交），
 * 便于按 id 比对与清理；绝不触碰用户的分支、HEAD、index、stash。
 */
const ShadowRefNamespace = 'refs/velaros/checkpoints'
const ShadowCommitIdentityEnv = {
  GIT_AUTHOR_NAME: 'VelarOS',
  GIT_AUTHOR_EMAIL: 'velaros@local',
  GIT_COMMITTER_NAME: 'VelarOS',
  GIT_COMMITTER_EMAIL: 'velaros@local',
}
/** git 对象 id（sha1 40 位 / sha256 64 位）。 */
const ObjectIdPattern = /^[0-9a-f]{40,64}$/u
const GitOutputMaxBytes = 16 * 1024 * 1024

/**
 * 本轮改动的比对参数：用户的 diff 配置（外部 diff 驱动、textconv、颜色、改名探测）一律压住，输出只由
 * 这里决定；`--relative` 只看项目根之内、路径相对项目根——项目可能只是某个大仓的子目录。
 */
const RunChangeDiffArgs = [
  'diff',
  '--no-color',
  '--no-ext-diff',
  '--no-textconv',
  '--no-renames',
  '--relative',
]
/**
 * 本轮改动的逐行补丁上限。文件清单与增删计数永远完整；超限的文件不存补丁，卡片里只给计数——
 * 一次格式化全仓之类的大改动也撑不爆记录文件。
 */
const RunChangePatchLimits = {
  files: 200,
  linesPerFile: 4_000,
  bytesPerFile: 512 * 1024,
  totalBytes: 6 * 1024 * 1024,
} as const
/** 逐文件取补丁时同时跑的 git 进程数。 */
const PatchReadConcurrency = 4

function shadowRef(sessionId: string, checkpointId: string): string {
  return `${ShadowRefNamespace}/${sanitizeRefSegment(sessionId)}/${sanitizeRefSegment(checkpointId)}`
}

/** git ref 段不允许空格、`~^:?*[\\` 等字符；保守清洗，避免拼出非法 ref。 */
function sanitizeRefSegment(value: string): string {
  const cleaned = value.replaceAll(/[^A-Za-z0-9._-]/gu, '-').replace(/^[.-]+/u, '')
  return cleaned || 'x'
}

/**
 * 「本轮改动」的工作区检查点（Desktop `GitShadowSnapshotEngine` 的单根对位件，只拍不还原）。
 *
 * - 捕获：用每个项目根一份的持久影子 index 增量暂存整棵工作树（`git add -A`，遵守 .gitignore），
 *   写出 tree 与无父提交，再挂到私有 ref 上。持久 index 只是 stat 缓存，让第二次起的捕获只重新
 *   hash 改过的文件；同一个根的操作串行执行，避免多个会话抢同一个 index.lock。
 * - 比对：采集时把当前工作树写成 tree，与这一轮开跑前的检查点逐文件比对；忽略文件（node_modules 等）
 *   不进快照。
 * - 项目不是 git 仓库或捕获失败时返回 null：这一轮没有改动卡，不阻断发送。
 */
export class WorkbenchChatCheckpointService {
  private readonly rootQueues = new Map<string, Promise<unknown>>()

  /**
   * `environment`：git 命令的基础环境。应用给的是登录 shell 的环境（与 Git 服务同一份）：`git add` 要跑
   * 仓库配置的 clean 过滤器（git-lfs 之类），从程序坞启动时应用自己的 PATH 里找不到它们，整次捕获就失败、
   * 这一轮没有改动卡。不给时用应用自己的环境。
   */
  constructor(
    private readonly indexRootDir: () => string,
    private readonly environment: () => Promise<NodeJS.ProcessEnv> = () =>
      Promise.resolve(process.env)
  ) {}

  public async capture(
    request: WorkbenchChatCheckpointCaptureRequest
  ): Promise<WorkbenchChatCheckpointCaptureResult> {
    const root = await this.resolveRoot(request.workspaceRoot)
    return this.serialize(root, async () => {
      if (!(await this.isInsideWorkTree(root))) return { commitId: null }
      try {
        const env = { GIT_INDEX_FILE: await this.persistentIndexFile(root) }
        await this.runGit(root, ['add', '-A'], env)
        const tree = (await this.runGit(root, ['write-tree'], env)).trim()
        if (!tree) return { commitId: null }
        const message = request.label?.trim() || `velaros-checkpoint ${request.checkpointId}`
        const commitId = (
          await this.runGit(root, ['commit-tree', tree, '-m', message], {
            ...env,
            ...ShadowCommitIdentityEnv,
          })
        ).trim()
        if (!ObjectIdPattern.test(commitId)) return { commitId: null }
        // 单独成 ref，保证对象可达不被 GC；不挂到任何用户分支上。
        await this.runGit(root, [
          'update-ref',
          shadowRef(request.sessionId, request.checkpointId),
          commitId,
        ])
        return { commitId }
      } catch {
        // 捕获失败不阻断对话：这一轮没有改动卡。
        return { commitId: null }
      }
    })
  }

  /** 删除检查点的影子 ref（检查点被淘汰、会话被移除时调用）；ref 已不在按幂等处理。 */
  public async delete(request: WorkbenchChatCheckpointDeleteRequest): Promise<void> {
    const root = await this.resolveRoot(request.workspaceRoot)
    await this.serialize(root, async () => {
      for (const checkpointId of request.checkpointIds) {
        await this.runGit(root, ['update-ref', '-d', shadowRef(request.sessionId, checkpointId)])
          .catch(() => undefined)
      }
    })
  }

  /**
   * 把当前工作树写成 tree 对象：「本轮改动」采集的那一刻的工作区。
   *
   * 用同一份持久影子 index——不建提交、不挂 ref，比完就不再需要——与捕获共用根锁，所以它与下一轮开跑前
   * 的捕获按到达顺序排队：先到的采集拍到的一定是下一轮动手之前的工作树。`settleMs`（最终采集）：排到之后
   * 再等到请求时刻之后这么久才拍，最后一条 Agent 命令的子进程晚落盘的几笔也算这一轮的；等的时候下一轮的
   * 捕获仍排在它后面。
   */
  public async snapshotWorkingTree(workspaceRoot: string, settleMs = 0): Promise<string> {
    const settleUntil = Date.now() + settleMs
    const root = await this.resolveRoot(workspaceRoot)
    const tree = await this.serialize(root, async () => {
      const wait = settleUntil - Date.now()
      if (wait > 0) await delay(wait)
      const env = { GIT_INDEX_FILE: await this.persistentIndexFile(root) }
      await this.runGit(root, ['add', '-A'], env)
      return (await this.runGit(root, ['write-tree'], env)).trim()
    })
    if (!ObjectIdPattern.test(tree)) throw new AppError('PLATFORM', workbenchMainText('git.checkpointTreeMissing'))
    return tree
  }

  /**
   * 工作树快照（{@link snapshotWorkingTree} 写出的 tree）相对某个检查点提交的逐文件改动。`select` 先筛出
   * 要留的文件（改动归属），补丁只给留下的取——别人的大改动不占补丁预算。只读对象库，放在根锁外，
   * 不挡下一轮开跑前的捕获。
   */
  public async diffWorkingTree(request: {
    workspaceRoot: string
    baseCommitId: string
    tree: string
    select?: (
      changes: WorkbenchChatRunFileChange[]
    ) => WorkbenchChatRunFileChange[] | Promise<WorkbenchChatRunFileChange[]>
  }): Promise<WorkbenchChatRunFileChange[]> {
    if (!ObjectIdPattern.test(request.baseCommitId) || !ObjectIdPattern.test(request.tree))
      throw new AppError('VALIDATION', workbenchMainText('git.checkpointInvalid'))
    const root = await this.resolveRoot(request.workspaceRoot)

    const range = [request.baseCommitId, request.tree]
    // 一个 git 失败时，也等另一个退出后再交回错误，避免遗留进程占着工作区目录。
    const [raw, numstat] = await Promise.allSettled([
      this.runGit(root, [...RunChangeDiffArgs, '-z', '--raw', '--no-abbrev', ...range]),
      this.runGit(root, [...RunChangeDiffArgs, '-z', '--numstat', ...range]),
    ])
    if (raw.status === 'rejected') throw raw.reason
    if (numstat.status === 'rejected') throw numstat.reason
    const listed = parseRunChangeFiles(raw.value, numstat.value)
    return attachRunChangePatches(request.select ? await request.select(listed) : listed, (path) =>
      this.runGit(root, [...RunChangeDiffArgs, ...range, '--', `:(literal)${path}`])
    )
  }

  /**
   * 某个检查点提交里一个文件的全文（「本轮改动」查看器拿它和补丁拼出改动前后两份全文）。
   *
   * 路径相对项目根，用 `./` 前缀按工作目录解析——项目可能只是某个大仓的子目录。读原始 blob，不走
   * textconv；超过 `maxBytes` 或提交里没有这个文件时为 null。只读对象库，不进根锁。
   */
  public async readFileAtCommit(request: {
    workspaceRoot: string
    commitId: string
    path: string
    maxBytes: number
  }): Promise<string | null> {
    if (!ObjectIdPattern.test(request.commitId))
      throw new AppError('VALIDATION', workbenchMainText('git.checkpointInvalid'))
    const path = readRelativePath(request.path)
    const root = await this.resolveRoot(request.workspaceRoot)
    const object = `${request.commitId}:./${path}`
    try {
      const size = Number.parseInt((await this.runGit(root, ['cat-file', '-s', object])).trim(), 10)
      if (!Number.isFinite(size) || size > request.maxBytes) return null
      // 文件全文要逐字节原样：结尾换行也算内容，不能像读命令输出那样剥掉。
      return await this.runGit(root, ['cat-file', 'blob', object], {}, { keepFinalNewline: true })
    } catch {
      return null
    }
  }

  private async isInsideWorkTree(root: string): Promise<boolean> {
    try {
      return (await this.runGit(root, ['rev-parse', '--is-inside-work-tree'])).trim() === 'true'
    } catch {
      return false
    }
  }

  private async persistentIndexFile(root: string): Promise<string> {
    const digest = createHash('sha1').update(root).digest('hex').slice(0, 16)
    const directory = join(this.indexRootDir(), `repo-${digest}`)
    await mkdir(directory, { recursive: true })
    return join(directory, 'index')
  }

  /** 同一个根上的捕获 / 拍照 / 删除排队执行：它们共用 index 与工作树，并发只会互相踩。 */
  private serialize<T>(root: string, task: () => Promise<T>): Promise<T> {
    const previous = this.rootQueues.get(root) ?? Promise.resolve()
    const next = previous.catch(() => undefined).then(task)
    const settled = next.catch(() => undefined)
    this.rootQueues.set(root, settled)
    void settled.then(() => {
      if (this.rootQueues.get(root) === settled) this.rootQueues.delete(root)
    })
    return next
  }

  private async resolveRoot(workspaceRoot: string): Promise<string> {
    if (!workspaceRoot.trim() || !isAbsolute(workspaceRoot))
      throw new AppError('VALIDATION', workbenchMainText('git.rootInvalid'))
    const root = await realpath(resolve(workspaceRoot))
    if (!(await stat(root)).isDirectory()) throw new AppError('VALIDATION', workbenchMainText('git.rootMissing'))
    return root
  }

  private async runGit(
    root: string,
    args: string[],
    extraEnv: Record<string, string> = {},
    options: { keepFinalNewline?: boolean } = {}
  ): Promise<string> {
    const result = await execa('git', args, {
      cwd: root,
      // 解析 git 输出必须钉死 C locale；也不允许任何交互式凭据提示把进程挂住。
      env: {
        ...(await this.readBaseEnvironment()),
        GIT_TERMINAL_PROMPT: '0',
        LC_ALL: 'C',
        LANG: 'C',
        ...extraEnv,
      },
      maxBuffer: GitOutputMaxBytes,
      reject: false,
      stripFinalNewline: !options.keepFinalNewline,
    })
    if (result.failed) {
      const detail = (result.stderr || result.stdout).trim()
      throw new AppError(
        'PLATFORM',
        detail
          ? workbenchMainText('git.checkpointCommandFailedDetail', {
              command: args[0] ?? '',
              detail: detail.slice(0, 260),
            })
          : workbenchMainText('git.checkpointCommandFailed', { command: args[0] ?? '' })
      )
    }
    return result.stdout
  }

  private async readBaseEnvironment(): Promise<NodeJS.ProcessEnv> {
    try {
      return await this.environment()
    } catch {
      // arch-guard:silent-catch-ok 登录环境读不出来（比如应用正在退出）时退回应用自己的环境：git 照样能跑，只是过滤器可能缺 PATH。
      return process.env
    }
  }
}

/** 相对项目根的路径，拒绝越出项目根与空段；分隔符统一成 `/`。 */
function readRelativePath(value: string): string {
  const path = value.replaceAll('\\', '/')
  if (
    !path ||
    path.includes('\0') ||
    path.startsWith('/') ||
    path.split('/').some((segment) => segment === '..' || segment === '')
  )
    throw new AppError('VALIDATION', workbenchMainText('git.invalidFilePath'))
  return path
}

/**
 * `-z` 输出下路径原样给出（不转义、不加引号），NUL 分隔。`--raw` 的每一项是
 * `:旧模式 新模式 旧对象 新对象 状态` 加路径；这里只取状态。
 */
function parseRunChangeFiles(rawText: string, numstatText: string): WorkbenchChatRunFileChange[] {
  const statusByPath = new Map<string, WorkbenchChatRunFileChangeStatus>()
  const rawFields = rawText.split('\0')
  for (let index = 0; index + 1 < rawFields.length; index += 2) {
    const meta = rawFields[index]
    const path = rawFields[index + 1]
    if (!meta?.startsWith(':') || !path) continue
    const code = meta.slice(1).split(' ')[4] ?? ''
    statusByPath.set(path, readRunChangeStatus(code))
  }

  const files: WorkbenchChatRunFileChange[] = []
  for (const record of numstatText.split('\0')) {
    // `增加\t删除\t路径`；路径本身可以含制表符，所以只切前两刀。
    const firstTab = record.indexOf('\t')
    const secondTab = firstTab < 0 ? -1 : record.indexOf('\t', firstTab + 1)
    const path = secondTab < 0 ? '' : record.slice(secondTab + 1)
    if (!path) continue
    const additions = record.slice(0, firstTab)
    const deletions = record.slice(firstTab + 1, secondTab)
    const binary = additions === '-' && deletions === '-'
    files.push({
      path,
      status: statusByPath.get(path) ?? 'modified',
      additions: binary ? 0 : readLineCount(additions),
      deletions: binary ? 0 : readLineCount(deletions),
      binary,
      patch: '',
      patchOmitted: false,
    })
  }
  return files
}

function readRunChangeStatus(code: string): WorkbenchChatRunFileChangeStatus {
  if (code.startsWith('A')) return 'added'
  if (code.startsWith('D')) return 'deleted'
  return 'modified'
}

function readLineCount(value: string): number {
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0
}

/**
 * 按上限逐文件取补丁（见 {@link RunChangePatchLimits}），按清单顺序计入总字节预算。
 * 单个文件取失败只让它退化成「只有计数」，不拖垮整轮采集。
 */
async function attachRunChangePatches<T extends WorkbenchChatRunFileChange>(
  files: readonly T[],
  readPatch: (path: string) => Promise<string>
): Promise<T[]> {
  const hasLineChanges = (file: WorkbenchChatRunFileChange): boolean =>
    !file.binary && file.additions + file.deletions > 0
  const candidates = files
    .filter(
      (file) =>
        hasLineChanges(file) &&
        file.additions + file.deletions <= RunChangePatchLimits.linesPerFile
    )
    .slice(0, RunChangePatchLimits.files)
  const patches = new Map<string, string>()
  let totalBytes = 0
  for (let index = 0; index < candidates.length; index += PatchReadConcurrency) {
    if (totalBytes >= RunChangePatchLimits.totalBytes) break
    const batch = candidates.slice(index, index + PatchReadConcurrency)
    const results = await Promise.all(
      batch.map((file) => readPatch(file.path).catch(() => null))
    )
    batch.forEach((file, batchIndex) => {
      const patch = results[batchIndex]
      if (!patch) return
      const bytes = Buffer.byteLength(patch)
      if (
        bytes > RunChangePatchLimits.bytesPerFile ||
        totalBytes + bytes > RunChangePatchLimits.totalBytes
      )
        return
      totalBytes += bytes
      patches.set(file.path, patch)
    })
  }

  return files.map((file) => {
    const patch = patches.get(file.path)
    if (patch) return { ...file, patch }
    return hasLineChanges(file) ? { ...file, patchOmitted: true } : file
  })
}
