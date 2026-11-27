import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rm } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'

import { isPlainObject } from '@velaros-ai/velaros/core'
import { AppError } from '@velaros-ai/velaros/core/error'
import { writeJsonFileAtomically } from '@velaros-ai/velaros/core/utils/FilePersistence'

import type {
  WorkbenchChatRunChangesDeleteRequest,
  WorkbenchChatRunChangesReadRequest,
  WorkbenchChatRunChangesRecord,
  WorkbenchChatRunChangesSummary,
  WorkbenchChatRunFileChange,
} from '../../../shared/workbenchGit'
import { workbenchMainText } from '../../i18n/workbenchMainMessages'

const RecordFileVersion = 2
const RecordSegmentPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/u

interface StoredRunChangesRecord extends WorkbenchChatRunChangesRecord {
  version: typeof RecordFileVersion
}

/** 将已确认的项目提交补丁保存在应用数据目录，聊天历史只保存摘要。 */
export class WorkbenchChatRunChangeStore {
  private readonly sessionQueues = new Map<string, Promise<unknown>>()

  public constructor(
    private readonly recordsRootDir: () => string,
    private readonly now: () => number = Date.now
  ) {}

  public async write(
    ref: { workspaceRoot: string; sessionId: string },
    changes: WorkbenchChatRunFileChange[],
    omittedFiles: number
  ): Promise<WorkbenchChatRunChangesSummary> {
    const recordId = randomUUID()
    const capturedAt = this.now()
    const file = this.recordFile({ ...ref, recordId })
    await this.serialize(dirname(file), async () => {
      await mkdir(dirname(file), { recursive: true })
      await writeJsonFileAtomically<StoredRunChangesRecord>(file, {
        version: RecordFileVersion,
        recordId,
        capturedAt,
        changes,
      })
    })
    return {
      recordId,
      capturedAt,
      fileCount: changes.length + omittedFiles,
      additions: changes.reduce((total, change) => total + change.additions, 0),
      deletions: changes.reduce((total, change) => total + change.deletions, 0),
      statsOmitted: omittedFiles > 0 || changes.some((change) => change.statsOmitted),
      error: null,
    }
  }

  public async read(
    request: WorkbenchChatRunChangesReadRequest
  ): Promise<WorkbenchChatRunChangesRecord | null> {
    const record = await this.readStored(request)
    return (
      record && {
        recordId: record.recordId,
        capturedAt: record.capturedAt,
        changes: record.changes,
      }
    )
  }

  public async delete(request: WorkbenchChatRunChangesDeleteRequest): Promise<void> {
    const sessionDir = this.sessionDir(request)
    const files = request.recordIds?.map((recordId) => this.recordFile({ ...request, recordId }))
    await this.serialize(sessionDir, async () => {
      if (!files) await rm(sessionDir, { recursive: true, force: true })
      else await Promise.all(files.map((file) => rm(file, { force: true })))
    })
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
      throw new AppError('VALIDATION', workbenchMainText('git.rootInvalid'))
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
  if (!RecordSegmentPattern.test(value))
    throw new AppError('VALIDATION', workbenchMainText('git.invalidRecordId'))
  return value
}

function parseStoredRecord(text: string, recordId: string): StoredRunChangesRecord | null {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return null
  }
  if (!isPlainObject(value)) return null
  const { version, capturedAt, changes } = value
  if (
    version !== RecordFileVersion ||
    value.recordId !== recordId ||
    typeof capturedAt !== 'number' ||
    !Number.isFinite(capturedAt) ||
    !Array.isArray(changes) ||
    !changes.every(isStoredFileChange)
  )
    return null
  return { version, recordId, capturedAt, changes }
}

function isStoredFileChange(value: unknown): value is WorkbenchChatRunFileChange {
  return (
    isPlainObject(value) &&
    typeof value.path === 'string' &&
    Boolean(value.path) &&
    !isAbsolute(value.path) &&
    !value.path.includes('\\') &&
    !value.path.includes('\0') &&
    !value.path.split('/').includes('..') &&
    (value.status === 'added' || value.status === 'deleted' || value.status === 'modified') &&
    typeof value.additions === 'number' &&
    Number.isSafeInteger(value.additions) &&
    value.additions >= 0 &&
    typeof value.deletions === 'number' &&
    Number.isSafeInteger(value.deletions) &&
    value.deletions >= 0 &&
    typeof value.binary === 'boolean' &&
    Array.isArray(value.patches) &&
    value.patches.every((patch) => typeof patch === 'string') &&
    typeof value.patchOmitted === 'boolean' &&
    typeof value.statsOmitted === 'boolean'
  )
}
