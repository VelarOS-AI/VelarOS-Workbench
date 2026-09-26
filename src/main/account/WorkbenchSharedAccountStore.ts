import { execFile } from 'node:child_process'
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
} from 'node:crypto'
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { mkdir, readFile, rename, rmdir, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'

import { velarosSharedResources } from '@velaros-ai/core/platform/shared-resources'

import type { WorkbenchAccountIdentity } from '../../shared/workbenchAccount'

const WorkbenchProductId = 'velaros.workbench'
const RegistryFileName = 'account-sessions.local-v1.bin'
const CredentialKeyFileName = 'credential-storage.key'
const MutationLockDirectoryName = '.account-sessions.lock'
const CredentialPayloadPrefix = Buffer.from('VELAROS-LOCAL-CREDENTIAL-V1\0', 'utf8')
const CredentialKeyBytes = 32
const CredentialIvBytes = 12
const CredentialTagBytes = 16
const execFileAsync = promisify(execFile)

export interface WorkbenchCloudSession {
  readonly account: WorkbenchAccountIdentity
  readonly sessionFamilyId: string
  readonly accessToken: string
  readonly accessExpiresAt: string
  readonly refreshToken: string
  readonly refreshExpiresAt: string
}

interface SharedAccountRegistry {
  readonly schemaVersion: 1
  readonly deviceId: string
  readonly sessions: Readonly<Record<string, WorkbenchCloudSession>>
  readonly productBindings: Readonly<Record<string, string | null>>
  readonly lastUsedAccountId: string | null
  readonly updatedAt: string
}

interface LegacyDesktopAccountState {
  readonly deviceId: string
  readonly session: WorkbenchCloudSession | null
}

interface WorkbenchSharedAccountStoreOptions {
  readonly productId?: string
  readonly rootDir?: string
}

/** 文件密钥与密文都在 VelarOS 共享目录，不调用操作系统凭据服务。 */
export class WorkbenchSharedAccountStore {
  readonly #productId: string
  readonly #rootDir: string
  readonly #registryPath: string
  readonly #keyPath: string
  readonly #lockPath: string

  public constructor(options: WorkbenchSharedAccountStoreOptions = {}) {
    this.#productId = options.productId?.trim() || WorkbenchProductId
    // 与 Desktop 同一个账号目录（磁盘布局归 Core），登录一次两边都认。
    this.#rootDir = options.rootDir ?? velarosSharedResources.accountRoot()
    this.#registryPath = join(this.#rootDir, RegistryFileName)
    this.#keyPath = join(this.#rootDir, CredentialKeyFileName)
    this.#lockPath = join(this.#rootDir, MutationLockDirectoryName)
  }

  public async getDeviceId(): Promise<string> {
    return (await this.#loadOrCreate()).deviceId
  }

  public async load(): Promise<WorkbenchCloudSession | null> {
    return this.#mutate((registry) => {
      const boundAccountId = registry.productBindings[this.#productId]
      if (boundAccountId === null) return { registry, value: null }
      if (boundAccountId && registry.sessions[boundAccountId])
        return { registry, value: registry.sessions[boundAccountId] ?? null }
      const fallbackId =
        (registry.lastUsedAccountId && registry.sessions[registry.lastUsedAccountId]
          ? registry.lastUsedAccountId
          : Object.keys(registry.sessions)[0]) ?? null
      if (!fallbackId) return { registry, value: null }
      return {
        registry: {
          ...registry,
          productBindings: { ...registry.productBindings, [this.#productId]: fallbackId },
          lastUsedAccountId: fallbackId,
          updatedAt: new Date().toISOString(),
        },
        value: registry.sessions[fallbackId] ?? null,
      }
    })
  }

  public async save(session: WorkbenchCloudSession): Promise<void> {
    await this.#mutate((registry) => ({
      registry: {
        ...registry,
        sessions: { ...registry.sessions, [session.account.id]: session },
        productBindings: {
          ...registry.productBindings,
          [this.#productId]: session.account.id,
        },
        lastUsedAccountId: session.account.id,
        updatedAt: new Date().toISOString(),
      },
      value: undefined,
    }))
  }

  /** true 表示同机已没有其他产品绑定该会话。 */
  public async disconnect(): Promise<boolean> {
    return this.#mutate((registry) => {
      const accountId = registry.productBindings[this.#productId]
      const productBindings = { ...registry.productBindings, [this.#productId]: null }
      if (!accountId)
        return {
          registry: { ...registry, productBindings, updatedAt: new Date().toISOString() },
          value: false,
        }
      const sharedElsewhere = Object.entries(productBindings).some(
        ([productId, binding]) => productId !== this.#productId && binding === accountId
      )
      const sessions = { ...registry.sessions }
      if (!sharedElsewhere) delete sessions[accountId]
      return {
        registry: {
          ...registry,
          sessions,
          productBindings,
          lastUsedAccountId:
            registry.lastUsedAccountId === accountId && !sharedElsewhere
              ? Object.keys(sessions)[0] ?? null
              : registry.lastUsedAccountId,
          updatedAt: new Date().toISOString(),
        },
        value: !sharedElsewhere,
      }
    })
  }

  async #loadOrCreate(): Promise<SharedAccountRegistry> {
    const existing = await this.#readRegistry()
    if (existing) return existing
    return this.#withLock(async () => {
      const raced = await this.#readRegistry()
      if (raced) return raced
      const legacy = this.#readLegacyDesktopState()
      const session = legacy?.session ?? null
      const registry: SharedAccountRegistry = {
        schemaVersion: 1,
        deviceId: legacy?.deviceId ?? await deriveDeviceId(),
        sessions: session ? { [session.account.id]: session } : {},
        productBindings: {},
        lastUsedAccountId: session?.account.id ?? null,
        updatedAt: new Date().toISOString(),
      }
      await this.#writeRegistry(registry)
      return registry
    })
  }

  async #mutate<T>(operation: (registry: SharedAccountRegistry) => {
    readonly registry: SharedAccountRegistry
    readonly value: T
  }): Promise<T> {
    return this.#withLock(async () => {
      const registry = (await this.#readRegistry()) ?? await this.#createRegistry()
      const result = operation(registry)
      if (result.registry !== registry) await this.#writeRegistry(result.registry)
      return result.value
    })
  }

  async #createRegistry(): Promise<SharedAccountRegistry> {
    const legacy = this.#readLegacyDesktopState()
    const session = legacy?.session ?? null
    return {
      schemaVersion: 1,
      deviceId: legacy?.deviceId ?? await deriveDeviceId(),
      sessions: session ? { [session.account.id]: session } : {},
      productBindings: {},
      lastUsedAccountId: session?.account.id ?? null,
      updatedAt: new Date().toISOString(),
    }
  }

  async #readRegistry(): Promise<SharedAccountRegistry | null> {
    try {
      const encrypted = await readFile(this.#registryPath)
      return parseRegistry(JSON.parse(this.#decrypt(encrypted)))
    } catch (error) {
      if (error instanceof Error && (error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw new Error('无法读取 VelarOS 共享账号状态。', { cause: error })
    }
  }

  async #writeRegistry(registry: SharedAccountRegistry): Promise<void> {
    await mkdir(this.#rootDir, { recursive: true, mode: 0o700 })
    const temporaryPath = `${this.#registryPath}.tmp-${process.pid}-${Date.now()}`
    await writeFile(temporaryPath, this.#encrypt(JSON.stringify(registry)), { mode: 0o600 })
    await rename(temporaryPath, this.#registryPath)
  }

  #readLegacyDesktopState(): LegacyDesktopAccountState | null {
    try {
      const sharedBase = dirname(dirname(dirname(this.#rootDir)))
      const legacyRoot = join(sharedBase, 'storage')
      const encrypted = readFileSync(join(legacyRoot, 'cloud-account-state.local-v1.bin'))
      const key = readFileSync(join(legacyRoot, 'credential-storage.key'))
      const parsed = JSON.parse(decryptCredential(encrypted, key)) as Record<string, unknown>
      const session = isSession(parsed.session) ? parsed.session : null
      return typeof parsed.deviceId === 'string' ? { deviceId: parsed.deviceId, session } : null
    } catch {
      return null
    }
  }

  #encrypt(value: string): Buffer {
    const key = this.#loadOrCreateKey()
    const iv = randomBytes(CredentialIvBytes)
    const cipher = createCipheriv('aes-256-gcm', key, iv)
    cipher.setAAD(CredentialPayloadPrefix)
    const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
    return Buffer.concat([CredentialPayloadPrefix, iv, cipher.getAuthTag(), encrypted])
  }

  #decrypt(value: Buffer): string {
    return decryptCredential(value, this.#loadOrCreateKey())
  }

  #loadOrCreateKey(): Buffer {
    try {
      const key = readFileSync(this.#keyPath)
      if (key.length !== CredentialKeyBytes) throw new Error('共享账号密钥格式无效。')
      return key
    } catch (error) {
      if (!(error instanceof Error) || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    mkdirSync(dirname(this.#keyPath), { recursive: true, mode: 0o700 })
    const key = randomBytes(CredentialKeyBytes)
    let descriptor: number | null = null
    try {
      descriptor = openSync(this.#keyPath, 'wx', 0o600)
      writeFileSync(descriptor, key)
      return key
    } catch (error) {
      if (error instanceof Error && (error as NodeJS.ErrnoException).code === 'EEXIST')
        return readFileSync(this.#keyPath)
      throw error
    } finally {
      if (descriptor !== null) closeSync(descriptor)
    }
  }

  async #withLock<T>(operation: () => Promise<T>): Promise<T> {
    await mkdir(this.#rootDir, { recursive: true, mode: 0o700 })
    const deadline = Date.now() + 10_000
    while (true) {
      try {
        await mkdir(this.#lockPath)
        break
      } catch (error) {
        if (!(error instanceof Error) || (error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        try {
          const lockStat = await stat(this.#lockPath)
          if (Date.now() - lockStat.mtimeMs > 2 * 60_000) {
            await rmdir(this.#lockPath)
            continue
          }
        } catch {
          continue
        }
        if (Date.now() >= deadline) throw new Error('共享账号状态正由另一个 VelarOS 产品更新。')
        await new Promise((resolve) => setTimeout(resolve, 40))
      }
    }
    try {
      return await operation()
    } finally {
      await rmdir(this.#lockPath).catch(() => undefined)
    }
  }
}

function decryptCredential(encrypted: Buffer, key: Buffer): string {
  const prefixLength = CredentialPayloadPrefix.length
  if (
    key.length !== CredentialKeyBytes
    || encrypted.length < prefixLength + CredentialIvBytes + CredentialTagBytes
    || !encrypted.subarray(0, prefixLength).equals(CredentialPayloadPrefix)
  ) throw new Error('共享账号密文格式无效。')
  const iv = encrypted.subarray(prefixLength, prefixLength + CredentialIvBytes)
  const tagOffset = prefixLength + CredentialIvBytes
  const tag = encrypted.subarray(tagOffset, tagOffset + CredentialTagBytes)
  const decipher = createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAAD(CredentialPayloadPrefix)
  decipher.setAuthTag(tag)
  return Buffer.concat([
    decipher.update(encrypted.subarray(tagOffset + CredentialTagBytes)),
    decipher.final(),
  ]).toString('utf8')
}

function parseRegistry(value: unknown): SharedAccountRegistry {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('共享账号格式无效。')
  const record = value as Record<string, unknown>
  if (record.schemaVersion !== 1 || typeof record.deviceId !== 'string') throw new Error('共享账号版本无效。')
  const sessions: Record<string, WorkbenchCloudSession> = {}
  if (record.sessions && typeof record.sessions === 'object' && !Array.isArray(record.sessions)) {
    for (const [accountId, session] of Object.entries(record.sessions)) {
      if (isSession(session) && session.account.id === accountId) sessions[accountId] = session
    }
  }
  const productBindings: Record<string, string | null> = {}
  if (record.productBindings && typeof record.productBindings === 'object' && !Array.isArray(record.productBindings)) {
    for (const [productId, accountId] of Object.entries(record.productBindings)) {
      if (accountId === null || typeof accountId === 'string') productBindings[productId] = accountId
    }
  }
  return {
    schemaVersion: 1,
    deviceId: record.deviceId,
    sessions,
    productBindings,
    lastUsedAccountId:
      typeof record.lastUsedAccountId === 'string' && sessions[record.lastUsedAccountId]
        ? record.lastUsedAccountId
        : null,
    updatedAt: typeof record.updatedAt === 'string' ? record.updatedAt : new Date(0).toISOString(),
  }
}

function isSession(value: unknown): value is WorkbenchCloudSession {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const session = value as Record<string, unknown>
  const account = session.account
  return !!account && typeof account === 'object' && !Array.isArray(account)
    && typeof (account as Record<string, unknown>).id === 'string'
    && typeof (account as Record<string, unknown>).displayName === 'string'
    && typeof (account as Record<string, unknown>).email === 'string'
    && typeof session.sessionFamilyId === 'string'
    && typeof session.accessToken === 'string'
    && typeof session.accessExpiresAt === 'string'
    && typeof session.refreshToken === 'string'
    && typeof session.refreshExpiresAt === 'string'
}

async function deriveDeviceId(): Promise<string> {
  const machineId = await readMachineIdentifier()
  if (!machineId) return randomUUID()
  const bytes = createHash('sha256')
    .update(`velaros-device-identity:${machineId.toLowerCase()}`)
    .digest()
    .subarray(0, 16)
  bytes[6] = (bytes[6]! & 0x0f) | 0x40
  bytes[8] = (bytes[8]! & 0x3f) | 0x80
  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

async function readMachineIdentifier(): Promise<string | null> {
  try {
    if (process.platform === 'darwin') {
      const { stdout } = await execFileAsync(
        '/usr/sbin/ioreg',
        ['-rd1', '-c', 'IOPlatformExpertDevice'],
        { timeout: 5_000 }
      )
      return /"IOPlatformUUID"\s*=\s*"([^"]+)"/u.exec(stdout)?.[1]?.trim() || null
    }
    if (process.platform === 'win32') {
      const { stdout } = await execFileAsync(
        'reg',
        ['query', String.raw`HKLM\SOFTWARE\Microsoft\Cryptography`, '/v', 'MachineGuid'],
        { timeout: 5_000 }
      )
      return /MachineGuid\s+REG_SZ\s+(\S+)/u.exec(stdout)?.[1]?.trim() || null
    }
    for (const path of ['/etc/machine-id', '/var/lib/dbus/machine-id']) {
      try {
        const value = (await readFile(path, 'utf8')).trim()
        if (value) return value
      } catch {
        // Candidate absence is expected; continue to the next system path.
      }
    }
  } catch {
    // Device identity falls back to a persisted random UUID below.
  }
  return null
}
