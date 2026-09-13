import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, realpath, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

import { execa } from 'execa'

import { AppError } from '@velaros-ai/core/error'

import type {
  WorkbenchChatCheckpointCaptureRequest,
  WorkbenchChatCheckpointCaptureResult,
  WorkbenchChatCheckpointDeleteRequest,
  WorkbenchChatCheckpointRestoreRequest,
  WorkbenchChatCheckpointRestoreResult,
  WorkbenchChatRunFileChange,
  WorkbenchChatRunFileChangeStatus,
} from '../../../shared/workbenchGit'

/** 一个路径在某个快照里的样子：git 文件模式与对象 id。 */
export interface WorkbenchChatTreeEntry {
  readonly mode: string
  readonly oid: string
}

/** 一个文件的改动，连同它在两个快照里的样子（不存在为 null）：按路径回退时靠它认「还是不是 Agent 留下的样子」。 */
export interface WorkbenchChatRunTreeChange extends WorkbenchChatRunFileChange {
  readonly before: WorkbenchChatTreeEntry | null
  readonly after: WorkbenchChatTreeEntry | null
}

/** 按路径回退的一项：此刻应当是 `expected` 的样子，回退成 `target`（null = 删掉）。 */
export interface WorkbenchChatPathRestore {
  readonly path: string
  readonly expected: WorkbenchChatTreeEntry | null
  readonly target: WorkbenchChatTreeEntry | null
}

export interface WorkbenchChatPathRestoreResult {
  restored: boolean
  error: string | null
  /** 写回、重建或删掉了的路径。 */
  restoredPaths: string[]
  /** 此刻已经不是期望的样子（回退前被改过），没有动它的路径。 */
  changedSince: string[]
}

/** 两个快照条目是不是同一个样子（都不存在也算）。 */
export function isSameTreeEntry(
  left: WorkbenchChatTreeEntry | null,
  right: WorkbenchChatTreeEntry | null
): boolean {
  if (!left || !right) return left === right
  return left.mode === right.mode && left.oid === right.oid
}

/**
 * 私有 ref 命名空间，与 Desktop 的会话检查点同一处：每个检查点单独成一个 ref（指向一个无父提交），
 * 便于按 id 还原与清理；绝不触碰用户的分支、HEAD、index、stash。
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
/** git 文件模式（普通文件、可执行、符号链接、子模块）。 */
const FileModePattern = /^[0-7]{6}$/u
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
 * 聊天回溯的工作区检查点（Desktop `GitShadowSnapshotEngine` 的单根对位件）。
 *
 * - 捕获：用每个项目根一份的持久影子 index 增量暂存整棵工作树（`git add -A`，遵守 .gitignore），
 *   写出 tree 与无父提交，再挂到私有 ref 上。持久 index 只是 stat 缓存，让第二次起的捕获只重新
 *   hash 改过的文件；同一个根的操作串行执行，避免多个会话抢同一个 index.lock。
 * - 还原：临时 index 里先把当前工作树写成 cur-tree，再 `read-tree -m -u cur target`——精确写回
 *   修改 / 删除，并移除「检查点之后新增」的文件；忽略文件（node_modules 等）不进快照也不被动到。
 *   按路径撤回（{@link restorePaths}）用同一套两路合并，只是 target 只换掉要撤回的那几个路径。
 * - 项目不是 git 仓库或捕获失败时返回 null：这一轮只能回溯对话，不阻断发送。
 */
export class WorkbenchChatCheckpointService {
  private readonly rootQueues = new Map<string, Promise<unknown>>()

  constructor(private readonly indexRootDir: () => string) {}

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
        // 捕获失败不阻断对话：退化为只能回溯对话。
        return { commitId: null }
      }
    })
  }

  public async restore(
    request: WorkbenchChatCheckpointRestoreRequest
  ): Promise<WorkbenchChatCheckpointRestoreResult> {
    if (!ObjectIdPattern.test(request.commitId))
      throw new AppError('VALIDATION', '无效的检查点提交。')
    const root = await this.resolveRoot(request.workspaceRoot)
    return this.serialize(root, async () => {
      const scratch = await mkdtemp(join(tmpdir(), 'velaros-snap-'))
      try {
        const env = { GIT_INDEX_FILE: join(scratch, 'index') }
        // 先把当前工作树写成 cur-tree、让临时 index 与之一致，作为两路合并的「源」。
        await this.runGit(root, ['add', '-A'], env)
        const currentTree = (await this.runGit(root, ['write-tree'], env)).trim()
        await this.runGit(
          root,
          ['read-tree', '-m', '-u', currentTree, `${request.commitId}^{tree}`],
          env
        )
        return { restored: true, error: null }
      } catch (error) {
        return { restored: false, error: error instanceof Error ? error.message : String(error) }
      } finally {
        await rm(scratch, { recursive: true, force: true })
      }
    })
  }

  /**
   * 按路径撤回：只把给定的这些路径写回目标内容（目标为 null 就删掉），工作树里别的文件一概不碰。
   *
   * 每一项带着「此刻应当是的样子」（Agent 最后留下的样子）：工作树里它已经不是这个样子——回退之前被 AI
   * 之外改过——就不动它，放进 `changedSince` 交回。临时 index 里把当前工作树写成 cur-tree，另一份临时
   * index 在它上面只换掉要撤回的路径得到 target-tree，再 `read-tree -m -u cur target`：只有这些路径被
   * 写回、重建或删掉（删空的目录一并删掉），用户的 index、HEAD 与其余文件原样。失败不抛错，如实交回。
   */
  public async restorePaths(request: {
    workspaceRoot: string
    paths: readonly WorkbenchChatPathRestore[]
  }): Promise<WorkbenchChatPathRestoreResult> {
    const root = await this.resolveRoot(request.workspaceRoot)
    for (const item of request.paths) {
      readRelativePath(item.path)
      for (const entry of [item.expected, item.target])
        if (entry && (!FileModePattern.test(entry.mode) || !ObjectIdPattern.test(entry.oid)))
          throw new AppError('VALIDATION', '无效的快照条目。')
    }
    return this.serialize(root, async () => {
      const scratch = await mkdtemp(join(tmpdir(), 'velaros-snap-'))
      try {
        const current = { GIT_INDEX_FILE: join(scratch, 'index') }
        await this.runGit(root, ['add', '-A'], current)
        const currentTree = (await this.runGit(root, ['write-tree'], current)).trim()
        // 从子目录跑的 ls-files 只列项目根之内的文件，路径相对项目根——与记录里的路径同一口径。
        const entries = parseIndexEntries(await this.runGit(root, ['ls-files', '-s', '-z'], current))
        const changedSince: string[] = []
        const updates: WorkbenchChatPathRestore[] = []
        for (const item of request.paths) {
          const now = entries.get(item.path) ?? null
          if (!isSameTreeEntry(now, item.expected)) changedSince.push(item.path)
          else if (!isSameTreeEntry(now, item.target)) updates.push(item)
        }
        if (updates.length === 0)
          return { restored: true, error: null, restoredPaths: [], changedSince }

        // index-info 里的路径相对仓库顶层：项目可能只是大仓的一个子目录。
        const prefix = (await this.runGit(root, ['rev-parse', '--show-prefix'])).trim()
        const target = { GIT_INDEX_FILE: join(scratch, 'target') }
        await this.runGit(root, ['read-tree', currentTree], target)
        const removed = `0 ${'0'.repeat(currentTree.length)}`
        const info = updates
          .map(({ path, target: entry }) =>
            `${entry ? `${entry.mode} ${entry.oid}` : removed}\t${prefix}${path}\0`)
          .join('')
        await this.runGit(root, ['update-index', '-z', '--index-info'], target, { input: info })
        const targetTree = (await this.runGit(root, ['write-tree'], target)).trim()
        await this.runGit(root, ['read-tree', '-m', '-u', currentTree, targetTree], current)
        return {
          restored: true,
          error: null,
          restoredPaths: updates.map(({ path }) => path),
          changedSince,
        }
      } catch (error) {
        return {
          restored: false,
          error: error instanceof Error ? error.message : String(error),
          restoredPaths: [],
          changedSince: [],
        }
      } finally {
        await rm(scratch, { recursive: true, force: true })
      }
    })
  }

  /** 删除检查点的影子 ref（回溯淘汰「未来」检查点时调用）；ref 已不在按幂等处理。 */
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
    if (!ObjectIdPattern.test(tree)) throw new AppError('PLATFORM', 'git write-tree 未返回 tree 对象。')
    return tree
  }

  /**
   * 工作树快照（{@link snapshotWorkingTree} 写出的 tree）相对某个检查点提交的逐文件改动，带着每个文件在
   * 两边快照里的样子。`select` 先筛出要留的文件（改动归属），补丁只给留下的取——别人的大改动不占补丁
   * 预算。只读对象库，放在根锁外，不挡下一轮开跑前的捕获。
   */
  public async diffWorkingTree(request: {
    workspaceRoot: string
    baseCommitId: string
    tree: string
    select?: (
      changes: WorkbenchChatRunTreeChange[]
    ) => WorkbenchChatRunTreeChange[] | Promise<WorkbenchChatRunTreeChange[]>
  }): Promise<WorkbenchChatRunTreeChange[]> {
    if (!ObjectIdPattern.test(request.baseCommitId) || !ObjectIdPattern.test(request.tree))
      throw new AppError('VALIDATION', '无效的检查点提交。')
    const root = await this.resolveRoot(request.workspaceRoot)

    const range = [request.baseCommitId, request.tree]
    const [rawText, numstatText] = await Promise.all([
      this.runGit(root, [...RunChangeDiffArgs, '-z', '--raw', '--no-abbrev', ...range]),
      this.runGit(root, [...RunChangeDiffArgs, '-z', '--numstat', ...range]),
    ])
    const listed = parseRunChangeFiles(rawText, numstatText)
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
      throw new AppError('VALIDATION', '无效的检查点提交。')
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

  /** 同一个根上的捕获 / 还原 / 删除排队执行：它们共用 index 与工作树，并发只会互相踩。 */
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
      throw new AppError('VALIDATION', '工作区根目录无效。')
    const root = await realpath(resolve(workspaceRoot))
    if (!(await stat(root)).isDirectory()) throw new AppError('VALIDATION', '工作区根目录不存在。')
    return root
  }

  private async runGit(
    root: string,
    args: string[],
    extraEnv: Record<string, string> = {},
    options: { keepFinalNewline?: boolean; input?: string } = {}
  ): Promise<string> {
    const result = await execa('git', args, {
      cwd: root,
      // 解析 git 输出必须钉死 C locale；也不允许任何交互式凭据提示把进程挂住。
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C', LANG: 'C', ...extraEnv },
      maxBuffer: GitOutputMaxBytes,
      reject: false,
      stripFinalNewline: !options.keepFinalNewline,
      input: options.input,
    })
    if (result.failed) {
      const detail = (result.stderr || result.stdout).trim()
      throw new AppError(
        'PLATFORM',
        detail ? `git ${args[0]} 执行失败：${detail.slice(0, 260)}` : `git ${args[0]} 执行失败`
      )
    }
    return result.stdout
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
    throw new AppError('VALIDATION', '无效的文件路径。')
  return path
}

interface RawChange {
  status: WorkbenchChatRunFileChangeStatus
  before: WorkbenchChatTreeEntry | null
  after: WorkbenchChatTreeEntry | null
}

/**
 * `-z` 输出下路径原样给出（不转义、不加引号），NUL 分隔。`--raw` 的每一项是
 * `:旧模式 新模式 旧对象 新对象 状态` 加路径；全零的模式表示那一边没有这个文件。
 */
function parseRunChangeFiles(rawText: string, numstatText: string): WorkbenchChatRunTreeChange[] {
  const rawByPath = new Map<string, RawChange>()
  const rawFields = rawText.split('\0')
  for (let index = 0; index + 1 < rawFields.length; index += 2) {
    const meta = rawFields[index]
    const path = rawFields[index + 1]
    if (!meta?.startsWith(':') || !path) continue
    const [oldMode = '', newMode = '', oldOid = '', newOid = '', code = ''] = meta.slice(1).split(' ')
    rawByPath.set(path, {
      status: readRunChangeStatus(code),
      before: readTreeEntry(oldMode, oldOid),
      after: readTreeEntry(newMode, newOid),
    })
  }

  const files: WorkbenchChatRunTreeChange[] = []
  for (const record of numstatText.split('\0')) {
    // `增加\t删除\t路径`；路径本身可以含制表符，所以只切前两刀。
    const firstTab = record.indexOf('\t')
    const secondTab = firstTab < 0 ? -1 : record.indexOf('\t', firstTab + 1)
    const path = secondTab < 0 ? '' : record.slice(secondTab + 1)
    if (!path) continue
    const additions = record.slice(0, firstTab)
    const deletions = record.slice(firstTab + 1, secondTab)
    const binary = additions === '-' && deletions === '-'
    const raw = rawByPath.get(path)
    files.push({
      path,
      status: raw?.status ?? 'modified',
      additions: binary ? 0 : readLineCount(additions),
      deletions: binary ? 0 : readLineCount(deletions),
      binary,
      patch: '',
      patchOmitted: false,
      before: raw?.before ?? null,
      after: raw?.after ?? null,
    })
  }
  return files
}

function readRunChangeStatus(code: string): WorkbenchChatRunFileChangeStatus {
  if (code.startsWith('A')) return 'added'
  if (code.startsWith('D')) return 'deleted'
  return 'modified'
}

function readTreeEntry(mode: string, oid: string): WorkbenchChatTreeEntry | null {
  if (!FileModePattern.test(mode) || /^0+$/u.test(mode) || !ObjectIdPattern.test(oid)) return null
  return { mode, oid }
}

/** `ls-files -s -z`：`模式 对象 暂存号\t路径`，NUL 分隔。 */
function parseIndexEntries(text: string): Map<string, WorkbenchChatTreeEntry> {
  const entries = new Map<string, WorkbenchChatTreeEntry>()
  for (const record of text.split('\0')) {
    const tab = record.indexOf('\t')
    if (tab < 0) continue
    const [mode = '', oid = ''] = record.slice(0, tab).split(' ')
    const entry = readTreeEntry(mode, oid)
    if (entry) entries.set(record.slice(tab + 1), entry)
  }
  return entries
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
