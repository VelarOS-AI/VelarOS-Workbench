import { createHash } from 'node:crypto'
import { readdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'

import type { ContextPayloadRecord } from '@velaros-ai/agent'
import { writeJsonFileAtomically } from '@velaros-ai/core/utils/FilePersistence'

interface PayloadAddress {
  sessionId: string
  hash: string
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === 'ENOENT'
}

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as unknown
  } catch (error) {
    if (missing(error)) return undefined
    throw error
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseAddress(value: unknown): PayloadAddress {
  if (
    !isRecord(value) ||
    typeof value['sessionId'] !== 'string' ||
    typeof value['hash'] !== 'string'
  )
    throw new Error('Context payload address is invalid.')
  return { sessionId: value['sessionId'], hash: value['hash'] }
}

/** Immutable blobs precede their lookup references; an acknowledged write is fully addressable. */
export class WorkbenchContextPayloadDiskStore {
  constructor(private readonly directory: () => string) {}

  public async read(sessionId: string, hash: string): Promise<ContextPayloadRecord | null> {
    const envelope = await readJson(this.blobPath(sessionId, hash))
    if (envelope === undefined) return null
    return this.validate(envelope, sessionId, hash)
  }

  private validate(envelope: unknown, sessionId: string, hash: string): ContextPayloadRecord {
    if (!isRecord(envelope) || envelope['version'] !== 1 || !isRecord(envelope['record']))
      throw new Error('Stored context payload has an invalid format.')
    const record = envelope['record']
    const strings = [
      'sessionId',
      'hash',
      'payloadRef',
      'toolCallId',
      'toolName',
      'serializedResult',
    ]
    if (
      strings.some((key) => typeof record[key] !== 'string') ||
      record['sessionId'] !== sessionId ||
      record['hash'] !== hash ||
      typeof record['createdAt'] !== 'number' ||
      !Number.isFinite(record['createdAt']) ||
      record['chars'] !== (record['serializedResult'] as string).length ||
      envelope['checksum'] !== digest(JSON.stringify(record))
    )
      throw new Error('Stored context payload failed its integrity check.')
    return record as unknown as ContextPayloadRecord
  }

  public async lookup(key: string, sessionId: string): Promise<ContextPayloadRecord | null> {
    const scoped = await readJson(this.aliasPath(key, sessionId))
    const value = scoped === undefined ? await readJson(this.aliasPath(key)) : scoped
    if (value === undefined) return null
    const address = parseAddress(value)
    const crossSessionPayloadRef = key.startsWith('ctx-payload:')
    if (address.sessionId !== sessionId && (!crossSessionPayloadRef || scoped !== undefined)) {
      if (scoped === undefined) return null
      throw new Error('Stored context payload reference belongs to another session.')
    }
    const record = await this.read(address.sessionId, address.hash)
    if (record && record.payloadRef !== key && record.toolCallId !== key)
      throw new Error('Stored context payload reference does not match its content.')
    return record
  }

  public async write(record: ContextPayloadRecord): Promise<ContextPayloadRecord> {
    const existing = await this.read(record.sessionId, record.hash)
    if (
      existing &&
      (existing.serializedResult !== record.serializedResult ||
        existing.payloadRef !== record.payloadRef ||
        existing.toolName !== record.toolName)
    )
      throw new Error('Context payload identity cannot be overwritten with different content.')
    const canonical = existing ?? record
    if (!existing)
      await writeJsonFileAtomically(
        this.blobPath(canonical.sessionId, canonical.hash),
        {
          version: 1,
          checksum: digest(JSON.stringify(canonical)),
          record: canonical,
        },
        { mode: 0o600 },
      )
    // Repeating a write repairs references left incomplete by a process interruption.
    for (const key of new Set([canonical.payloadRef, canonical.toolCallId]))
      for (const scope of [canonical.sessionId, undefined])
        await writeJsonFileAtomically(
          this.aliasPath(key, scope),
          {
            sessionId: canonical.sessionId,
            hash: canonical.hash,
          },
          { mode: 0o600 },
        )
    return canonical
  }

  public async list(sessionId: string): Promise<ContextPayloadRecord[]> {
    let names: string[]
    try {
      names = await readdir(this.sessionPath(sessionId))
    } catch (error) {
      if (missing(error)) return []
      throw error
    }
    const records: ContextPayloadRecord[] = []
    for (const name of names.sort()) {
      if (!/^[a-f0-9]{64}\.json$/u.test(name)) continue
      const envelope = await readJson(join(this.sessionPath(sessionId), name))
      if (envelope === undefined) continue
      if (!isRecord(envelope) || !isRecord(envelope['record']))
        throw new Error('Stored context payload has an invalid format.')
      const address = parseAddress(envelope['record'])
      if (address.sessionId !== sessionId || `${digest(address.hash)}.json` !== name)
        throw new Error('Stored context payload has an invalid identity.')
      records.push(this.validate(envelope, sessionId, address.hash))
    }
    return records.sort((a, b) => a.createdAt - b.createdAt)
  }

  public async deleteSession(sessionId: string): Promise<void> {
    const references = join(this.directory(), 'references')
    const scopedReferences = join(references, digest(sessionId))
    let scopedNames: string[] = []
    try {
      scopedNames = await readdir(scopedReferences)
    } catch (error) {
      if (!missing(error)) throw error
    }
    const sessionReferenceNames = new Set(
      scopedNames.filter((name) => /^[a-f0-9]{64}\.json$/u.test(name)),
    )

    // Remove the authoritative blobs first. Keep scoped references until global cleanup succeeds:
    // they are the only ownership evidence available when a global reference is malformed.
    await rm(this.sessionPath(sessionId), { recursive: true, force: true })
    let names: string[] = []
    try {
      names = await readdir(references)
    } catch (error) {
      if (!missing(error)) throw error
    }
    for (const name of names) {
      if (!/^[a-f0-9]{64}\.json$/u.test(name)) continue
      const path = join(references, name)
      let value: unknown
      try {
        value = await readJson(path)
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error
        // A corrupt global reference can only be attributed by its scoped counterpart. Never
        // remove an unrelated corrupt reference, and never infer ownership for a valid address.
        if (sessionReferenceNames.has(name)) await rm(path, { force: true })
        continue
      }
      if (
        !isRecord(value) ||
        typeof value['sessionId'] !== 'string' ||
        typeof value['hash'] !== 'string'
      ) {
        if (sessionReferenceNames.has(name)) await rm(path, { force: true })
        continue
      }
      if (value['sessionId'] === sessionId) await rm(path, { force: true })
    }
    await rm(scopedReferences, { recursive: true, force: true })
  }

  private sessionPath(sessionId: string): string {
    return join(this.directory(), 'sessions', digest(sessionId))
  }

  private blobPath(sessionId: string, hash: string): string {
    return join(this.sessionPath(sessionId), `${digest(hash)}.json`)
  }

  private aliasPath(key: string, sessionId?: string): string {
    const directory = join(this.directory(), 'references')
    return join(
      sessionId === undefined ? directory : join(directory, digest(sessionId)),
      `${digest(key)}.json`,
    )
  }
}
