import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { mkdir, open, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const CredentialFileName = 'model-credentials.local-v1.bin'
const CredentialKeyFileName = 'model-credentials.local-v1.key'
const CredentialPayloadPrefix = Buffer.from('VELAROS-WORKBENCH-MODEL-CREDENTIAL-V1\0', 'utf8')
const CredentialKeyBytes = 32
const CredentialIvBytes = 12
const CredentialTagBytes = 16

interface StoredModelCredentials {
  readonly version: 1
  readonly apiKeys: Record<string, string>
}

/**
 * Workbench 自管的本地凭据存储。密钥和密文都位于应用数据目录，避免在应用启动时请求
 * 操作系统凭据授权；文件权限与 AES-GCM 仍可避免凭据以明文形式落盘。
 */
export class WorkbenchModelCredentialStore {
  readonly #credentialPath: string
  readonly #keyPath: string
  #credentials: StoredModelCredentials | null = null
  #key: Promise<Buffer> | null = null
  #writeQueue: Promise<void> = Promise.resolve()

  public constructor(private readonly rootDir: string) {
    this.#credentialPath = join(rootDir, CredentialFileName)
    this.#keyPath = join(rootDir, CredentialKeyFileName)
  }

  public async getApiKey(provider: string): Promise<string> {
    return (await this.#read()).apiKeys[provider] ?? ''
  }

  public async setApiKey(provider: string, apiKey: string): Promise<void> {
    this.#writeQueue = this.#writeQueue.catch(() => undefined).then(async () => {
      const credentials = await this.#read()
      const apiKeys = { ...credentials.apiKeys }
      if (apiKey) apiKeys[provider] = apiKey
      else delete apiKeys[provider]

      this.#credentials = { version: 1, apiKeys }
      await mkdir(this.rootDir, { recursive: true, mode: 0o700 })
      const temporaryPath = `${this.#credentialPath}.tmp-${process.pid}-${Date.now()}`
      await writeFile(
        temporaryPath,
        this.#encrypt(JSON.stringify(this.#credentials), await this.#loadOrCreateKey()),
        { mode: 0o600 }
      )
      await rename(temporaryPath, this.#credentialPath)
    })
    return this.#writeQueue
  }

  async #read(): Promise<StoredModelCredentials> {
    if (this.#credentials) return this.#credentials
    try {
      const encrypted = await readFile(this.#credentialPath)
      const parsed = JSON.parse(
        this.#decrypt(encrypted, await this.#loadOrCreateKey())
      ) as Partial<StoredModelCredentials>
      this.#credentials = {
        version: 1,
        apiKeys: readApiKeys(parsed.apiKeys),
      }
    } catch {
      this.#credentials = { version: 1, apiKeys: {} }
    }
    return this.#credentials
  }

  #encrypt(value: string, key: Buffer): Buffer {
    const iv = randomBytes(CredentialIvBytes)
    const cipher = createCipheriv('aes-256-gcm', key, iv)
    cipher.setAAD(CredentialPayloadPrefix)
    const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
    return Buffer.concat([CredentialPayloadPrefix, iv, cipher.getAuthTag(), encrypted])
  }

  #decrypt(value: Buffer, key: Buffer): string {
    const prefixLength = CredentialPayloadPrefix.length
    if (
      key.length !== CredentialKeyBytes
      || value.length < prefixLength + CredentialIvBytes + CredentialTagBytes
      || !value.subarray(0, prefixLength).equals(CredentialPayloadPrefix)
    ) {
      throw new Error('模型凭据存储格式无效。')
    }
    const ivStart = prefixLength
    const tagStart = ivStart + CredentialIvBytes
    const encryptedStart = tagStart + CredentialTagBytes
    const decipher = createDecipheriv(
      'aes-256-gcm',
      key,
      value.subarray(ivStart, tagStart)
    )
    decipher.setAAD(CredentialPayloadPrefix)
    decipher.setAuthTag(value.subarray(tagStart, encryptedStart))
    return Buffer.concat([
      decipher.update(value.subarray(encryptedStart)),
      decipher.final(),
    ]).toString('utf8')
  }

  #loadOrCreateKey(): Promise<Buffer> {
    this.#key ??= this.#readOrCreateKey()
    return this.#key
  }

  async #readOrCreateKey(): Promise<Buffer> {
    try {
      return validateKey(await readFile(this.#keyPath))
    } catch (error) {
      if (!(error instanceof Error) || (error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error
      }
    }

    await mkdir(this.rootDir, { recursive: true, mode: 0o700 })
    const key = randomBytes(CredentialKeyBytes)
    try {
      const handle = await open(this.#keyPath, 'wx', 0o600)
      try {
        await handle.writeFile(key)
      } finally {
        await handle.close()
      }
      return key
    } catch (error) {
      if (error instanceof Error && (error as NodeJS.ErrnoException).code === 'EEXIST')
        return validateKey(await readFile(this.#keyPath))
      throw error
    }
  }
}

function readApiKeys(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
  )
}

function validateKey(key: Buffer): Buffer {
  if (key.length !== CredentialKeyBytes) throw new Error('模型凭据密钥格式无效。')
  return key
}
