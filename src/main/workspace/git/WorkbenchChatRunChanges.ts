import { createHash } from 'node:crypto'
import { mkdir, readFile, rm } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'

import { AppError } from '@velaros-ai/core/error'
import { writeJsonFileAtomically } from '@velaros-ai/core/utils/FilePersistence'

import type {
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

interface StoredRunChangesRecord extends WorkbenchChatRunChangesRecord {
  version: typeof RecordFileVersion
}

/**
 * 每轮「本轮改动」的记录区：`<数据根>/chat-run-changes/<项目根摘要>/<会话 id>/<记录 id>.json`。
 *
 * 补丁全文只落在这里，renderer 的会话状态（localStorage）里只有摘要。记录跟着运行标记走：回溯掉的
 * 消息、被移除的会话，由 renderer 按 id 删掉对应记录。这一轮没改文件时不写记录。
 */
export class WorkbenchChatRunChangeStore {
  constructor(
    private readonly checkpoints: WorkbenchChatCheckpointService,
    private readonly recordsRootDir: () => string,
    private readonly now: () => number = Date.now
  ) {}

  public async capture(
    request: WorkbenchChatRunChangesCaptureRequest
  ): Promise<WorkbenchChatRunChangesSummary> {
    const file = this.recordFile(request)
    let changes: WorkbenchChatRunFileChange[]
    try {
      changes = await this.checkpoints.diffWorkingTree(request)
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
        changes,
      })
    }
    return {
      recordId: request.recordId,
      capturedAt,
      fileCount: changes.length,
      additions: changes.reduce((total, change) => total + change.additions, 0),
      deletions: changes.reduce((total, change) => total + change.deletions, 0),
      error: null,
    }
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

  public async delete(request: WorkbenchChatRunChangesDeleteRequest): Promise<void> {
    if (!request.recordIds) {
      await rm(this.sessionDir(request), { recursive: true, force: true })
      return
    }
    await Promise.all(
      request.recordIds.map((recordId) =>
        rm(this.recordFile({ ...request, recordId }), { force: true })
      )
    )
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
  const { version, capturedAt, changes } = value
  if (
    version !== RecordFileVersion ||
    value.recordId !== recordId ||
    typeof capturedAt !== 'number' ||
    !Array.isArray(changes)
  )
    return null
  return { recordId, capturedAt, changes: changes.filter(isStoredFileChange) }
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
