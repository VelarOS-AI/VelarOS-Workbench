import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'

import { AppError } from '@velaros-ai/core/error'

import type {
  WorkbenchConversationEventEnvelope,
  WorkbenchConversationRecoveryPage,
  WorkbenchConversationRecoveryRun,
  WorkbenchConversationSessionRequest,
  WorkbenchConversationStreamEvent,
} from '../../shared/workbenchConversation'

type Lane = {
  run: WorkbenchConversationRecoveryRun
  sequence: number
  tail: Promise<void>
  closed: boolean
}

/** 与 Desktop 一致：先持久化有序事件再交付。每个会话保留最近一轮，历史正文由聊天快照持有。 */
export class WorkbenchConversationRecovery {
  private readonly lanes = new Map<string, Lane>()
  private readonly operations = new Map<string, Promise<void>>()
  public constructor(private readonly directory: string) {}

  /** 读、写、换代、删除共用一条队列，回读不能把正在追加的半行误当成崩溃尾部截断。 */
  private exclusive<T>(
    ref: WorkbenchConversationSessionRequest,
    action: () => Promise<T>,
  ): Promise<T> {
    const key = this.key(ref)
    const result = (this.operations.get(key) ?? Promise.resolve()).then(action)
    const settled = result.then(
      () => {},
      () => {},
    )
    this.operations.set(key, settled)
    void settled.then(() => {
      if (this.operations.get(key) === settled) this.operations.delete(key)
    })
    return result
  }

  public begin(
    ref: WorkbenchConversationSessionRequest,
    inputId: string,
    goalMode: boolean,
  ): Promise<WorkbenchConversationRecoveryRun> {
    return this.exclusive(ref, () => this.beginLocked(ref, inputId, goalMode))
  }
  public append(
    run: WorkbenchConversationRecoveryRun,
    event: WorkbenchConversationStreamEvent,
  ): Promise<WorkbenchConversationEventEnvelope> {
    return this.exclusive(run, () => this.appendLocked(run, event))
  }
  public read(
    ref: WorkbenchConversationSessionRequest,
    cursor: { streamId?: string; after?: number },
    active: boolean,
  ): Promise<WorkbenchConversationRecoveryPage | null> {
    return this.exclusive(ref, () => this.readLocked(ref, cursor, active))
  }
  public remove(ref: WorkbenchConversationSessionRequest): Promise<void> {
    return this.exclusive(ref, () => this.removeLocked(ref))
  }

  private key(ref: WorkbenchConversationSessionRequest): string {
    return createHash('sha256')
      .update(`${ref.projectRoot}\0${ref.sessionId}`)
      .digest('hex')
  }

  private async beginLocked(
    ref: WorkbenchConversationSessionRequest,
    inputId: string,
    goalMode: boolean,
  ): Promise<WorkbenchConversationRecoveryRun> {
    const key = this.key(ref)
    await this.lanes.get(key)?.tail
    const run = {
      ...ref,
      id: randomUUID(),
      inputId,
      goalMode,
      startedAt: Date.now(),
    }
    await mkdir(this.directory, { recursive: true })
    const file = await open(join(this.directory, `${key}.jsonl`), 'w')
    try {
      await file.writeFile(`${JSON.stringify({ run })}\n`)
      await file.sync()
    } finally {
      await file.close()
    }
    this.lanes.set(key, {
      run,
      sequence: 0,
      tail: Promise.resolve(),
      closed: false,
    })
    return run
  }

  private appendLocked(
    run: WorkbenchConversationRecoveryRun,
    event: WorkbenchConversationStreamEvent,
  ): Promise<WorkbenchConversationEventEnvelope> {
    const key = this.key(run)
    const lane = this.lanes.get(key)
    if (!lane || lane.closed || lane.run.id !== run.id)
      return Promise.reject(new AppError('UNAVAILABLE', '会话恢复记录已关闭'))
    const envelope = {
      projectRoot: run.projectRoot,
      sessionId: run.sessionId,
      event,
      streamId: run.id,
      emittedAt: Date.now(),
      sequence: ++lane.sequence,
    }
    const written = lane.tail.then(async () => {
      const file = await open(join(this.directory, `${key}.jsonl`), 'a')
      try {
        await file.writeFile(`${JSON.stringify({ envelope })}\n`)
        await file.sync()
      } finally {
        await file.close()
      }
    })
    lane.tail = written
    return written.then(() => envelope)
  }

  private async readLocked(
    ref: WorkbenchConversationSessionRequest,
    cursor: { streamId?: string; after?: number },
    active: boolean,
  ): Promise<WorkbenchConversationRecoveryPage | null> {
    const key = this.key(ref)
    await this.lanes.get(key)?.tail
    let source: string
    try {
      source = await readFile(join(this.directory, `${key}.jsonl`), 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
    // 崩溃留下的最后半行不构成已交付事件；已完整落盘的行必须可解析。
    const committedEnd = source.lastIndexOf('\n') + 1
    if (committedEnd < source.length) {
      const file = await open(join(this.directory, `${key}.jsonl`), 'r+')
      try {
        await file.truncate(Buffer.byteLength(source.slice(0, committedEnd)))
        await file.sync()
      } finally {
        await file.close()
      }
    }
    const lines = source.slice(0, committedEnd - 1).split('\n')
    const { run } = JSON.parse(lines.shift()!) as {
      run: WorkbenchConversationRecoveryRun
    }
    const all = lines
      .filter(Boolean)
      .map(
        (line) =>
          (JSON.parse(line) as { envelope: WorkbenchConversationEventEnvelope }).envelope,
      )
    const last = all.at(-1)?.event
    const terminal =
      last?.type === 'state' && ['done', 'error', 'aborted'].includes(last.payload.kind)
    if (!active && !terminal) {
      const lane = this.lanes.get(key)
      if (!lane)
        this.lanes.set(key, {
          run,
          sequence: all.at(-1)?.sequence ?? 0,
          tail: Promise.resolve(),
          closed: false,
        })
      all.push(
        await this.appendLocked(run, {
          type: 'state',
          payload: {
            kind: 'aborted',
            message: '应用重启前的执行已中断；已恢复记录，可继续发送消息。',
          },
        }),
      )
    }
    const after = cursor.streamId === run.id ? (cursor.after ?? 0) : 0
    const events = all.filter((event) => (event.sequence ?? 0) > after).slice(0, 128)
    const nextAfter = events.at(-1)?.sequence ?? after
    return {
      run,
      events,
      active,
      nextAfter,
      hasMore: (all.at(-1)?.sequence ?? 0) > nextAfter,
    }
  }

  private async removeLocked(ref: WorkbenchConversationSessionRequest): Promise<void> {
    const key = this.key(ref)
    const lane = this.lanes.get(key)
    if (lane) {
      lane.closed = true
      await lane.tail
    }
    this.lanes.delete(key)
    await rm(join(this.directory, `${key}.jsonl`), { force: true })
  }
}
