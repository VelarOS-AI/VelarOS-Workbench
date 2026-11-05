import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

import { isFiniteNumber, isNonBlankString, isPlainObject, Log } from '@velaros-ai/velaros/core'
import { AppError } from '@velaros-ai/velaros/core/error'

import {
  type WorkbenchAgentEngineId,
  WorkbenchAgentEngineIds,
} from '../../shared/workbenchConversation'
import type { WorkbenchConversationRef } from '../conversation/WorkbenchConversationRuntime'

const log = Log.tag('WorkbenchEngineSessionStore')

interface StoredEngineSession {
  engine: WorkbenchAgentEngineId
  projectRoot: string
  sessionId: string
  /** 引擎自己的会话身份：Claude Code 的 session id、Codex 的 thread id。 */
  nativeId: string
  updatedAt: number
}

/** 同时记着的引擎会话上限：超出时丢掉最久没用的（丢了只是下一轮在引擎那边另开会话）。 */
const MaxStoredSessions = 2_000

/**
 * Workbench 会话 → 引擎会话的对照（Claude Code 的 session id、Codex 的 thread id）：下一轮接着同一段引擎
 * 上下文，重启 Workbench 也接得上。上下文本身在引擎自己的目录里，这里只记身份。
 */
export class WorkbenchEngineSessionStore {
  private readonly path: string
  private loaded?: Promise<Map<string, StoredEngineSession>>
  private writing: Promise<void> = Promise.resolve()

  public constructor(dataRootDir: string) {
    this.path = join(dataRootDir, 'agent-engines', 'sessions.json')
  }

  public async get(
    engine: WorkbenchAgentEngineId,
    ref: WorkbenchConversationRef
  ): Promise<Nullable<string>> {
    return (await this.load()).get(sessionKey(engine, ref))?.nativeId ?? null
  }

  public async set(
    engine: WorkbenchAgentEngineId,
    ref: WorkbenchConversationRef,
    nativeId: string
  ): Promise<void> {
    const sessions = await this.load()
    const key = sessionKey(engine, ref)
    if (sessions.get(key)?.nativeId === nativeId) return
    sessions.set(key, {
      engine,
      projectRoot: resolve(ref.projectRoot),
      sessionId: ref.sessionId,
      nativeId,
      updatedAt: Date.now(),
    })
    await this.persist(sessions)
  }

  /** 忘掉这个会话在各个引擎里的身份（会话删了，或引擎那边的会话已经接不上了）。 */
  public async delete(
    ref: WorkbenchConversationRef,
    engine?: WorkbenchAgentEngineId
  ): Promise<void> {
    const sessions = await this.load()
    const keys = (engine ? [engine] : WorkbenchAgentEngineIds).map((id) => sessionKey(id, ref))
    if (!keys.some((key) => sessions.delete(key))) return
    await this.persist(sessions)
  }

  private load(): Promise<Map<string, StoredEngineSession>> {
    this.loaded ??= this.read()
    return this.loaded
  }

  private async read(): Promise<Map<string, StoredEngineSession>> {
    try {
      const document: unknown = JSON.parse(await readFile(this.path, 'utf8'))
      const entries =
        isPlainObject(document) && Array.isArray(document.sessions) ? document.sessions : []
      return new Map(
        entries
          .filter(isStoredEngineSession)
          .map((entry) => [sessionKey(entry.engine, entry), entry])
      )
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        log.warn('引擎会话对照读不出来，从空的开始', { error: AppError.getMessage(error) })
      return new Map()
    }
  }

  /** 写盘排队：先写临时文件再改名，写到一半崩溃不会留下半截 JSON。 */
  private persist(sessions: Map<string, StoredEngineSession>): Promise<void> {
    const entries = [...sessions.values()]
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .slice(0, MaxStoredSessions)
    const next = this.writing
      .catch(() => undefined)
      .then(async () => {
        await mkdir(dirname(this.path), { recursive: true })
        const temporary = `${this.path}.tmp`
        await writeFile(temporary, `${JSON.stringify({ sessions: entries }, null, 2)}\n`, 'utf8')
        await rename(temporary, this.path)
      })
    this.writing = next
    return next
  }
}

function sessionKey(engine: WorkbenchAgentEngineId, ref: WorkbenchConversationRef): string {
  return `${engine}\0${resolve(ref.projectRoot)}\0${ref.sessionId}`
}

function isStoredEngineSession(value: unknown): value is StoredEngineSession {
  return (
    isPlainObject(value) &&
    WorkbenchAgentEngineIds.includes(value.engine as WorkbenchAgentEngineId) &&
    isNonBlankString(value.projectRoot) &&
    isNonBlankString(value.sessionId) &&
    isNonBlankString(value.nativeId) &&
    isFiniteNumber(value.updatedAt)
  )
}
