import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, realpath, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'

import { execa } from 'execa'

import { AppError } from '@velaros-ai/core/error'

import type {
  WorkbenchChatCheckpointCaptureRequest,
  WorkbenchChatCheckpointCaptureResult,
  WorkbenchChatCheckpointDeleteRequest,
  WorkbenchChatCheckpointRestoreRequest,
  WorkbenchChatCheckpointRestoreResult,
} from '../../../shared/workbenchGit'

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
const CommitIdPattern = /^[0-9a-f]{40,64}$/u
const GitOutputMaxBytes = 16 * 1024 * 1024

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
        if (!CommitIdPattern.test(commitId)) return { commitId: null }
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
    if (!CommitIdPattern.test(request.commitId))
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
    extraEnv: Record<string, string> = {}
  ): Promise<string> {
    const result = await execa('git', args, {
      cwd: root,
      // 解析 git 输出必须钉死 C locale；也不允许任何交互式凭据提示把进程挂住。
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C', LANG: 'C', ...extraEnv },
      maxBuffer: GitOutputMaxBytes,
      reject: false,
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
