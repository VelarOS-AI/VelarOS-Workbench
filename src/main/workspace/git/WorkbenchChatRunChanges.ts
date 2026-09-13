import { createHash } from 'node:crypto'
import { mkdir, readFile, rm } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'

import { optionalWhenLazy } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'
import { writeJsonFileAtomically } from '@velaros-ai/core/utils/FilePersistence'

import {
  type WorkbenchChatCheckpointCaptureRequest,
  type WorkbenchChatCheckpointCaptureResult,
  type WorkbenchChatRunChangeBaseFileRequest,
  type WorkbenchChatRunChangeBaseFileResult,
  type WorkbenchChatRunChangesCaptureRequest,
  type WorkbenchChatRunChangesDeleteRequest,
  type WorkbenchChatRunChangesReadRequest,
  type WorkbenchChatRunChangesRecord,
  type WorkbenchChatRunChangesRewindRequest,
  type WorkbenchChatRunChangesRewindResult,
  type WorkbenchChatRunChangesSummary,
  WorkbenchChatRunChangesSummaryMaxPaths,
  type WorkbenchChatRunFileChange,
} from '../../../shared/workbenchGit'

import {
  isSameTreeEntry,
  type WorkbenchChatCheckpointService,
  type WorkbenchChatPathRestore,
  type WorkbenchChatRunTreeChange,
  type WorkbenchChatTreeEntry,
} from './WorkbenchChatCheckpoints'
import type {
  WorkbenchChatRunAttribution,
  WorkbenchChatRunAttributionResult,
} from './WorkbenchChatRunAttribution'

/** 加字段不升版本：旧版本读到新记录照样能显示（多出的字段它不认）。 */
const RecordFileVersion = 1
/** 会话 id 与记录 id 直接当路径段用，只收保守字符。 */
const RecordSegmentPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/u
const ObjectIdPattern = /^[0-9a-f]{40,64}$/u
const FileModePattern = /^[0-7]{6}$/u
/** 子模块（gitlink）：按路径撤回写不回它的内容，回溯不碰。 */
const GitlinkMode = '160000'
/** 查看器读改动前全文的上限；更大的文件只看补丁。 */
const BaseFileMaxBytes = 2 * 1024 * 1024

interface StoredRunFileChange extends WorkbenchChatRunFileChange {
  /** 这个文件在这一轮开跑前 / 采集那一刻的样子（不存在为 null）；回溯按路径撤回靠它。旧记录没有。 */
  before?: WorkbenchChatTreeEntry | null
  after?: WorkbenchChatTreeEntry | null
}

interface StoredRunChangesRecord {
  version: typeof RecordFileVersion
  recordId: string
  capturedAt: number
  baseCommitId?: string
  changes: StoredRunFileChange[]
  /**
   * 这一轮的改动归属：有它，`changes` 就只含 Agent 改过的文件（混改的标着 `mixed`）；`watcher` 为
   * `unavailable` 时这一轮只认得出写文件工具报的路径。早于改动归属的旧记录没有它——整个 diff 都算 Agent 的。
   */
  attribution?: { watcher: WorkbenchChatRunAttributionResult['watcher'] }
}

/**
 * 每轮「本轮改动」的记录区：`<数据根>/chat-run-changes/<项目根摘要>/<会话 id>/<记录 id>.json`。
 *
 * 补丁全文只落在这里，renderer 的会话状态（localStorage）里只有摘要。记录跟着运行标记走：回溯掉的
 * 消息、被移除的会话，由 renderer 按 id 删掉对应记录。
 *
 * 记录里只有这一轮 Agent 改过的文件：检查点 diff 按这一轮的改动归属（{@link WorkbenchChatRunAttribution}）
 * 筛过，运行期间用户自己、别的程序、别的会话改的文件不进来。没有接归属（探针、测试）时照旧记整个 diff。
 *
 * 一轮运行中会被反复采集（实时刷新），收尾时再采一次最终的：记录 id 是这一轮的，每次采集整份覆盖
 * 同一个文件（原子写入），改动清零时删掉文件——文件里永远是最近一次采集看到的改动。同一个会话的采集、
 * 删除与回溯排队执行，写盘顺序就是请求到达的顺序。
 */
export class WorkbenchChatRunChangeStore {
  private readonly sessionQueues = new Map<string, Promise<unknown>>()

  constructor(
    private readonly checkpoints: WorkbenchChatCheckpointService,
    private readonly recordsRootDir: () => string,
    private readonly now: () => number = Date.now,
    private readonly attribution?: WorkbenchChatRunAttribution
  ) {}

  /**
   * 这一轮开跑前的检查点，同时为这一轮开一本改动归属账本（检查点 id 就是记录 id）。先开账再拍：快照之后
   * 的每一笔写入都有人记。检查点没拍成（不是 git 仓库、捕获失败）就没有改动可比，账本随即作废。
   */
  public async captureCheckpoint(
    request: WorkbenchChatCheckpointCaptureRequest
  ): Promise<WorkbenchChatCheckpointCaptureResult> {
    const ledger = {
      workspaceRoot: request.workspaceRoot,
      sessionId: request.sessionId,
      recordId: request.checkpointId,
    }
    await this.attribution?.begin(ledger)
    try {
      const captured = await this.checkpoints.capture(request)
      if (!captured.commitId) this.attribution?.discard({ ...ledger, recordIds: [ledger.recordId] })
      return captured
    } catch (error) {
      this.attribution?.discard({ ...ledger, recordIds: [ledger.recordId] })
      throw error
    }
  }

  public async capture(
    request: WorkbenchChatRunChangesCaptureRequest
  ): Promise<WorkbenchChatRunChangesSummary> {
    const file = this.recordFile(request)
    const final = request.final === true
    // 工作树在请求到达的这一刻就排进项目根的锁里拍下：收尾的最终采集哪怕还要在会话队列里等上一次
    // 实时采集写完，拍到的也是下一轮开跑之前的工作区。最终采集排到之后还要等最后一条 Agent 命令的余量
    // 走完再拍。等候期间的失败轮到它时照常读出来。
    const tree = this.checkpoints.snapshotWorkingTree(
      request.workspaceRoot,
      final ? this.attribution?.settleDelayMs(request) ?? 0 : 0
    )
    tree.catch(() => undefined)
    return this.serialize(dirname(file), async () => {
      try {
        return await this.writeCapture(file, request, tree)
      } finally {
        // 最终采集之后这一轮不会再有采集（失败了也一样）：关账。
        if (final) this.attribution?.finish(request)
      }
    })
  }

  /** 记录不在（已被清理或这一轮没改文件）或已损坏时为 null。 */
  public async read(
    request: WorkbenchChatRunChangesReadRequest
  ): Promise<WorkbenchChatRunChangesRecord | null> {
    const record = await this.readStored(request)
    if (!record) return null
    return {
      recordId: record.recordId,
      capturedAt: record.capturedAt,
      baseCommitId: record.baseCommitId,
      changes: record.changes.map(toPublicChange),
    }
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

  /**
   * 回溯时撤回被移除各轮（最早的在前）里 Agent 的文件改动。
   *
   * 一个文件只在这几轮里都只被 Agent 改过、此后也没被别人动过时才撤回：逐轮核对它这一轮开跑前的样子正是
   * 上一次 Agent 留下的样子，再由按路径撤回核对它此刻仍是 Agent 最后留下的样子，然后写回 Agent 第一次动它
   * 之前的样子。混改的、轮次之间或事后被 AI 之外改过的文件保留当前内容，交回给回溯说明；Agent 没碰过的
   * 文件一概不碰。与采集同一条会话队列：刚收尾那一轮的最终采集写完之后才读记录。
   */
  public async rewind(
    request: WorkbenchChatRunChangesRewindRequest
  ): Promise<WorkbenchChatRunChangesRewindResult> {
    if (!ObjectIdPattern.test(request.commitId))
      throw new AppError('VALIDATION', '无效的检查点提交。')
    const requests = request.recordIds.map((recordId) => ({ ...request, recordId }))
    for (const recordRequest of requests) this.recordFile(recordRequest)
    return this.serialize(this.sessionDir(request), async () => {
      const records = await Promise.all(requests.map((recordRequest) => this.readStored(recordRequest)))
      if (records.some((record) => record && !record.attribution)) {
        // 旧记录（早于改动归属）分不出这几轮里谁改了什么：照旧把整个项目还原到回溯那一轮开跑前的检查点。
        const restored = await this.checkpoints.restore({
          workspaceRoot: request.workspaceRoot,
          commitId: request.commitId,
        })
        return { ...restored, scope: 'checkpoint', restoredPaths: [], keptPaths: [] }
      }
      const plan = planAgentRewind(records.filter((record) => record !== null))
      const result = await this.checkpoints.restorePaths({
        workspaceRoot: request.workspaceRoot,
        paths: plan.restores,
      })
      return {
        restored: result.restored,
        error: result.error,
        scope: 'agent-changes',
        restoredPaths: result.restoredPaths,
        keptPaths: result.restored ? [...new Set([...plan.kept, ...result.changedSince])].sort() : [],
      }
    })
  }

  /** 与采集同一条会话队列：刚收尾的采集还没写完时回溯掉这一轮，删除排在写入之后。 */
  public async delete(request: WorkbenchChatRunChangesDeleteRequest): Promise<void> {
    const sessionDir = this.sessionDir(request)
    const files = request.recordIds?.map((recordId) => this.recordFile({ ...request, recordId }))
    // 记录没了，这几轮不会再有采集：还开着的归属账本一并作废。
    this.attribution?.discard(request)
    await this.serialize(sessionDir, async () => {
      if (!files) await rm(sessionDir, { recursive: true, force: true })
      else await Promise.all(files.map((file) => rm(file, { force: true })))
    })
  }

  private async writeCapture(
    file: string,
    request: WorkbenchChatRunChangesCaptureRequest,
    tree: Promise<string>
  ): Promise<WorkbenchChatRunChangesSummary> {
    // 这一轮的归属结论：没接归属（探针、测试）时不填，整个 diff 照旧；null 是没有账本，认不出谁改的。
    const selection: { attribution?: WorkbenchChatRunAttributionResult | null } = {}
    let changes: WorkbenchChatRunTreeChange[]
    try {
      changes = await this.checkpoints.diffWorkingTree({
        ...request,
        tree: await tree,
        select: async (listed) => {
          if (!this.attribution) return listed
          selection.attribution = await this.attribution.resolve(
            request,
            listed.map((change) => change.path),
            { final: request.final === true }
          )
          return selection.attribution ? selectAttributedChanges(listed, selection.attribution) : []
        },
      })
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

    // 没有账本（这一轮没开账、已关账或已作废）：认不出哪些是 Agent 的，不写也不删，交回记录里现有的那份。
    if (selection.attribution === null)
      return summarize(request.recordId, await this.readStored(request), this.now())

    const capturedAt = this.now()
    if (changes.length > 0) {
      await mkdir(dirname(file), { recursive: true })
      await writeJsonFileAtomically<StoredRunChangesRecord>(file, {
        version: RecordFileVersion,
        recordId: request.recordId,
        capturedAt,
        baseCommitId: request.baseCommitId,
        changes,
        attribution: optionalWhenLazy(selection.attribution, () => ({ watcher: selection.attribution!.watcher })),
      })
    } else {
      // 上一次采集时有改动、这一次全被撤回了：旧记录不能留着冒充现在。
      await rm(file, { force: true })
    }
    return summarize(request.recordId, { capturedAt, changes }, capturedAt)
  }

  private async readStored(request: {
    workspaceRoot: string
    sessionId: string
    recordId: string
  }): Promise<StoredRunChangesRecord | null> {
    let text: string
    try {
      text = await readFile(this.recordFile(request), 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
    return parseStoredRecord(text, request.recordId)
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

  /** 同一个会话目录上的写入、删除与回溯按到达顺序执行。 */
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

/**
 * 被移除各轮（最早的在前）里 Agent 改过的文件，逐个定下撤回成什么样、此刻应当是什么样。混改的、两轮之间
 * 被别人改过的（后一轮开跑前的样子不是前一轮 Agent 留下的样子）直接保留；子模块不碰。
 */
function planAgentRewind(records: readonly StoredRunChangesRecord[]): {
  restores: WorkbenchChatPathRestore[]
  kept: string[]
} {
  const chains = new Map<string, StoredRunFileChange[]>()
  for (const record of records) {
    for (const change of record.changes) {
      const chain = chains.get(change.path)
      if (chain) chain.push(change)
      else chains.set(change.path, [change])
    }
  }

  const restores: WorkbenchChatPathRestore[] = []
  const kept: string[] = []
  for (const [path, chain] of chains) {
    if (chain.some((change) => change.before?.mode === GitlinkMode || change.after?.mode === GitlinkMode))
      continue
    const agentOnly = chain.every(
      (change, index) =>
        change.attribution === 'agent'
        && change.before !== undefined
        && change.after !== undefined
        && (index === 0 || isSameTreeEntry(chain[index - 1]!.after ?? null, change.before))
    )
    if (!agentOnly) {
      kept.push(path)
      continue
    }
    restores.push({
      path,
      expected: chain.at(-1)!.after ?? null,
      target: chain[0]!.before ?? null,
    })
  }
  return { restores, kept }
}

/** 只留 Agent 改过的文件，每个带上归属（两边都改过的是 `mixed`）。 */
function selectAttributedChanges(
  changes: readonly WorkbenchChatRunTreeChange[],
  attribution: WorkbenchChatRunAttributionResult
): WorkbenchChatRunTreeChange[] {
  return changes.flatMap((change) => {
    const origin = attribution.origins.get(change.path)
    return origin ? [{ ...change, attribution: origin }] : []
  })
}

/** 定长摘要；没有记录（这一轮没改文件）时计数为零、采集时刻取 `fallbackCapturedAt`。 */
function summarize(
  recordId: string,
  record: Pick<StoredRunChangesRecord, 'capturedAt' | 'changes'> | null,
  fallbackCapturedAt: number
): WorkbenchChatRunChangesSummary {
  const changes = record?.changes ?? []
  return {
    recordId,
    capturedAt: record?.capturedAt ?? fallbackCapturedAt,
    fileCount: changes.length,
    additions: changes.reduce((total, change) => total + change.additions, 0),
    deletions: changes.reduce((total, change) => total + change.deletions, 0),
    error: null,
    paths: optionalWhenLazy(changes.length <= WorkbenchChatRunChangesSummaryMaxPaths, () =>
      changes.map((change) => change.path)
    ),
  }
}

function toPublicChange(change: StoredRunFileChange): WorkbenchChatRunFileChange {
  return {
    path: change.path,
    status: change.status,
    additions: change.additions,
    deletions: change.deletions,
    binary: change.binary,
    patch: change.patch,
    patchOmitted: change.patchOmitted,
    attribution: change.attribution,
  }
}

function readSegment(value: string): string {
  if (!RecordSegmentPattern.test(value)) throw new AppError('VALIDATION', '无效的会话或记录 id。')
  return value
}

/** 记录文件是外来数据（可能被截断或来自别的版本）：形状不对当作没有。 */
function parseStoredRecord(text: string, recordId: string): StoredRunChangesRecord | null {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return null
  }
  if (!isPlainRecord(value)) return null
  const { version, capturedAt, changes, baseCommitId, attribution } = value
  if (
    version !== RecordFileVersion ||
    value.recordId !== recordId ||
    typeof capturedAt !== 'number' ||
    !Array.isArray(changes)
  )
    return null
  const watcher = isPlainRecord(attribution) ? attribution.watcher : undefined
  const record: StoredRunChangesRecord = {
    version,
    recordId,
    capturedAt,
    changes: changes.filter(isStoredFileChange),
  }
  // 两个可选字段都要先认形状再收：在 if 里收窄，不必把外来值强转成字段类型。
  if (typeof baseCommitId === 'string' && ObjectIdPattern.test(baseCommitId)) record.baseCommitId = baseCommitId
  if (watcher === 'observed' || watcher === 'unavailable') record.attribution = { watcher }
  return record
}

function isStoredFileChange(value: unknown): value is StoredRunFileChange {
  return (
    isPlainRecord(value) &&
    typeof value.path === 'string' &&
    (value.status === 'added' || value.status === 'deleted' || value.status === 'modified') &&
    typeof value.additions === 'number' &&
    typeof value.deletions === 'number' &&
    typeof value.binary === 'boolean' &&
    typeof value.patch === 'string' &&
    typeof value.patchOmitted === 'boolean' &&
    (value.attribution === undefined || value.attribution === 'agent' || value.attribution === 'mixed') &&
    isStoredTreeEntry(value.before) &&
    isStoredTreeEntry(value.after)
  )
}

function isStoredTreeEntry(value: unknown): boolean {
  return (
    value === undefined ||
    value === null ||
    (isPlainRecord(value) &&
      typeof value.mode === 'string' &&
      FileModePattern.test(value.mode) &&
      typeof value.oid === 'string' &&
      ObjectIdPattern.test(value.oid))
  )
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
