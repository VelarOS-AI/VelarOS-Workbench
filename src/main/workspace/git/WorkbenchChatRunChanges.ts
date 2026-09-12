import { createHash } from 'node:crypto'
import { mkdir, readFile, rm } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'

import { AppError } from '@velaros-ai/core/error'
import { writeJsonFileAtomically } from '@velaros-ai/core/utils/FilePersistence'

import type {
  WorkbenchChatRunChangeBaseFileRequest,
  WorkbenchChatRunChangeBaseFileResult,
  WorkbenchChatRunChangesCaptureRequest,
  WorkbenchChatRunChangesDeleteRequest,
  WorkbenchChatRunChangesReadRequest,
  WorkbenchChatRunChangesRecord,
  WorkbenchChatRunChangesSummary,
  WorkbenchChatRunFileChange,
} from '../../../shared/workbenchGit'

import type { WorkbenchChatCheckpointService } from './WorkbenchChatCheckpoints'

const RecordFileVersion = 1
/** 会话 id 与记录 id 直接当路径段用，只收保守字符。 */
const RecordSegmentPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/u
const ObjectIdPattern = /^[0-9a-f]{40,64}$/u
/** 查看器读改动前全文的上限；更大的文件只看补丁。 */
const BaseFileMaxBytes = 2 * 1024 * 1024

interface StoredRunChangesRecord extends WorkbenchChatRunChangesRecord {
  version: typeof RecordFileVersion
}

/**
 * 每轮「本轮改动」的记录区：`<数据根>/chat-run-changes/<项目根摘要>/<会话 id>/<记录 id>.json`。
 *
 * 补丁全文只落在这里，renderer 的会话状态（localStorage）里只有摘要。记录跟着运行标记走：回溯掉的
 * 消息、被移除的会话，由 renderer 按 id 删掉对应记录。
 *
 * 一轮运行中会被反复采集（实时刷新），收尾时再采一次最终的：记录 id 是这一轮的，每次采集整份覆盖
 * 同一个文件（原子写入），改动清零时删掉文件——文件里永远是最近一次采集看到的改动。同一个会话的采集
 * 与删除排队执行，写盘顺序就是请求到达的顺序。
 */
export class WorkbenchChatRunChangeStore {
  private readonly sessionQueues = new Map<string, Promise<unknown>>()

  constructor(
    private readonly checkpoints: WorkbenchChatCheckpointService,
    private readonly recordsRootDir: () => string,
    private readonly now: () => number = Date.now
  ) {}

  public async capture(
    request: WorkbenchChatRunChangesCaptureRequest
  ): Promise<WorkbenchChatRunChangesSummary> {
    const file = this.recordFile(request)
    // 工作树在请求到达的这一刻就排进项目根的锁里拍下：收尾的最终采集哪怕还要在会话队列里等上一次
    // 实时采集写完，拍到的也是下一轮开跑之前的工作区。等候期间的失败轮到它时照常读出来。
    const tree = this.checkpoints.snapshotWorkingTree(request.workspaceRoot)
    tree.catch(() => undefined)
    return this.serialize(dirname(file), async () => {
      let changes: WorkbenchChatRunFileChange[]
      try {
        changes = await this.checkpoints.diffWorkingTree({ ...request, tree: await tree })
      } catch (error) {
        // 采集失败不影响这一轮本身：摘要带上原因，卡片据此说明改动读不出来。
        return {
          recordId: request.recordId,
          capturedAt: this.now(),
          fileCount: 0,
          additions: 0,
          deletions: 0,
          error: error instanceof Error ? error.message : String(error),
        }
      }

      const capturedAt = this.now()
      if (changes.length > 0) {
        await mkdir(dirname(file), { recursive: true })
        await writeJsonFileAtomically<StoredRunChangesRecord>(file, {
          version: RecordFileVersion,
          recordId: request.recordId,
          capturedAt,
          baseCommitId: request.baseCommitId,
          changes,
        })
      } else {
        // 上一次采集时有改动、这一次全被撤回了：旧记录不能留着冒充现在。
        await rm(file, { force: true })
      }
      return {
        recordId: request.recordId,
        capturedAt,
        fileCount: changes.length,
        additions: changes.reduce((total, change) => total + change.additions, 0),
        deletions: changes.reduce((total, change) => total + change.deletions, 0),
        error: null,
      }
    })
  }

  /** 记录不在（已被清理或这一轮没改文件）或已损坏时为 null。 */
  public async read(
    request: WorkbenchChatRunChangesReadRequest
  ): Promise<WorkbenchChatRunChangesRecord | null> {
    let text: string
    try {
      text = await readFile(this.recordFile(request), 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
    return parseStoredRecord(text, request.recordId)
  }

  /**
   * 记录里一个文件改动前的全文。只读记录里列着的文件，起点是记录自己写下的提交，renderer 指定不了
   * 任意提交或任意路径；这一轮新建的文件没有改动前。
   */
  public async readBaseFile(
    request: WorkbenchChatRunChangeBaseFileRequest
  ): Promise<WorkbenchChatRunChangeBaseFileResult> {
    const record = await this.read(request)
    const change = record?.changes.find((candidate) => candidate.path === request.path)
    if (!record?.baseCommitId || !change || change.status === 'added' || change.binary)
      return { content: null }
    return {
      content: await this.checkpoints.readFileAtCommit({
        workspaceRoot: request.workspaceRoot,
        commitId: record.baseCommitId,
        path: change.path,
        maxBytes: BaseFileMaxBytes,
      }),
    }
  }

  /** 与采集同一条会话队列：刚收尾的采集还没写完时回溯掉这一轮，删除排在写入之后。 */
  public async delete(request: WorkbenchChatRunChangesDeleteRequest): Promise<void> {
    const sessionDir = this.sessionDir(request)
    const files = request.recordIds?.map((recordId) => this.recordFile({ ...request, recordId }))
    await this.serialize(sessionDir, async () => {
      if (!files) await rm(sessionDir, { recursive: true, force: true })
      else await Promise.all(files.map((file) => rm(file, { force: true })))
    })
  }

  private recordFile(request: {
    workspaceRoot: string
    sessionId: string
    recordId: string
  }): string {
    return join(this.sessionDir(request), `${readSegment(request.recordId)}.json`)
  }

  private sessionDir(request: { workspaceRoot: string; sessionId: string }): string {
    if (!request.workspaceRoot.trim() || !isAbsolute(request.workspaceRoot))
      throw new AppError('VALIDATION', '工作区根目录无效。')
    // 按规范化后的路径字符串分目录，不解析符号链接：项目挪走、删掉之后照样能清理。
    const rootDigest = createHash('sha1')
      .update(resolve(request.workspaceRoot))
      .digest('hex')
      .slice(0, 16)
    return join(this.recordsRootDir(), rootDigest, readSegment(request.sessionId))
  }

  /** 同一个会话目录上的写入与删除按到达顺序执行。 */
  private serialize<T>(sessionDir: string, task: () => Promise<T>): Promise<T> {
    const previous = this.sessionQueues.get(sessionDir) ?? Promise.resolve()
    const next = previous.catch(() => undefined).then(task)
    const settled = next.catch(() => undefined)
    this.sessionQueues.set(sessionDir, settled)
    void settled.then(() => {
      if (this.sessionQueues.get(sessionDir) === settled) this.sessionQueues.delete(sessionDir)
    })
    return next
  }
}

function readSegment(value: string): string {
  if (!RecordSegmentPattern.test(value)) throw new AppError('VALIDATION', '无效的会话或记录 id。')
  return value
}

/** 记录文件是外来数据（可能被截断或来自别的版本）：形状不对当作没有。 */
function parseStoredRecord(text: string, recordId: string): WorkbenchChatRunChangesRecord | null {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return null
  }
  if (!isPlainRecord(value)) return null
  const { version, capturedAt, changes, baseCommitId } = value
  if (
    version !== RecordFileVersion ||
    value.recordId !== recordId ||
    typeof capturedAt !== 'number' ||
    !Array.isArray(changes)
  )
    return null
  return {
    recordId,
    capturedAt,
    ...(typeof baseCommitId === 'string' && ObjectIdPattern.test(baseCommitId)
      ? { baseCommitId }
      : {}),
    changes: changes.filter(isStoredFileChange),
  }
}

function isStoredFileChange(value: unknown): value is WorkbenchChatRunFileChange {
  return (
    isPlainRecord(value) &&
    typeof value.path === 'string' &&
    (value.status === 'added' || value.status === 'deleted' || value.status === 'modified') &&
    typeof value.additions === 'number' &&
    typeof value.deletions === 'number' &&
    typeof value.binary === 'boolean' &&
    typeof value.patch === 'string' &&
    typeof value.patchOmitted === 'boolean'
  )
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
