import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import type { WorkbenchAgentEngineId } from '../identity'

interface StoredSession {
  engineId: WorkbenchAgentEngineId
  workbenchSessionId: string
  projectRoot: string
  nativeSessionId: string
  updatedAt: number
}

interface StoredSessionDocument {
  version: 1
  sessions: StoredSession[]
}

/** 外部引擎会话 id 的宿主持久层；Workbench 重启后仍能恢复 Claude/Codex 上下文。 */
export class WorkbenchAgentEngineSessionStore {
  private readonly path: string
  private loaded: Promise<Map<string, StoredSession>> | null = null
  private writeQueue = Promise.resolve()

  public constructor(dataRootDir: string) {
    this.path = join(dataRootDir, 'agent-engines', 'sessions.json')
  }

  public async get(
    engineId: WorkbenchAgentEngineId,
    workbenchSessionId: string,
    projectRoot: string
  ): Promise<string | null> {
    const stored = (await this.load()).get(sessionKey(engineId, workbenchSessionId))
    return stored?.projectRoot === projectRoot ? stored.nativeSessionId : null
  }

  public async set(
    engineId: WorkbenchAgentEngineId,
    workbenchSessionId: string,
    projectRoot: string,
    nativeSessionId: string
  ): Promise<void> {
    const sessions = await this.load()
    sessions.set(sessionKey(engineId, workbenchSessionId), {
      engineId,
      workbenchSessionId,
      projectRoot,
      nativeSessionId,
      updatedAt: Date.now(),
    })
    this.writeQueue = this.writeQueue
      .catch(() => undefined)
      .then(() => this.write(sessions))
    await this.writeQueue
  }

  public async delete(
    engineId: WorkbenchAgentEngineId,
    workbenchSessionId: string
  ): Promise<void> {
    const sessions = await this.load()
    sessions.delete(sessionKey(engineId, workbenchSessionId))
    this.writeQueue = this.writeQueue
      .catch(() => undefined)
      .then(() => this.write(sessions))
    await this.writeQueue
  }

  private load(): Promise<Map<string, StoredSession>> {
    this.loaded ??= this.read()
    return this.loaded
  }

  private async read(): Promise<Map<string, StoredSession>> {
    try {
      const document = JSON.parse(await readFile(this.path, 'utf8')) as Partial<StoredSessionDocument>
      const sessions = Array.isArray(document.sessions) ? document.sessions : []
      return new Map(sessions.flatMap((item) =>
        isStoredSession(item) ? [[sessionKey(item.engineId, item.workbenchSessionId), item]] : []
      ))
    } catch {
      return new Map()
    }
  }

  private async write(sessions: Map<string, StoredSession>): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true })
    const temporaryPath = `${this.path}.tmp`
    const document: StoredSessionDocument = {
      version: 1,
      sessions: [...sessions.values()].sort((left, right) => left.updatedAt - right.updatedAt),
    }
    await writeFile(temporaryPath, `${JSON.stringify(document, null, 2)}\n`, 'utf8')
    await rename(temporaryPath, this.path)
  }
}

function sessionKey(engineId: WorkbenchAgentEngineId, workbenchSessionId: string): string {
  return `${engineId}\0${workbenchSessionId}`
}

function isStoredSession(value: unknown): value is StoredSession {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return (record.engineId === 'claude-code' || record.engineId === 'codex')
    && typeof record.workbenchSessionId === 'string'
    && typeof record.projectRoot === 'string'
    && typeof record.nativeSessionId === 'string'
    && typeof record.updatedAt === 'number'
}
