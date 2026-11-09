import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { mkdir, open, readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { isPlainObject } from '@velaros-ai/velaros/core'
import { writeFileAtomically } from '@velaros-ai/velaros/core/utils/FilePersistence'

import { workbenchMainText } from '../i18n/workbenchMainMessages'

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
  #credentials: Promise<StoredModelCredentials> | null = null
  #key: Promise<Buffer> | null = null
  #writeQueue: Promise<void> = Promise.resolve()

  public constructor(private readonly rootDir: string) {
    this.#credentialPath = join(rootDir, CredentialFileName)
    this.#keyPath = join(rootDir, CredentialKeyFileName)
  }

  public async getApiKey(provider: string): Promise<string> {
    const { apiKeys } = await this.#read()
    return Object.hasOwn(apiKeys, provider) ? apiKeys[provider]! : ''
  }

  public async setApiKey(provider: string, apiKey: string): Promise<void> {
    this.#writeQueue = this.#writeQueue
      .catch(() => undefined)
      .then(async () => {
        const credentials = await this.#read()
        const apiKeys = { ...credentials.apiKeys }
        if (apiKey) apiKeys[provider] = apiKey
        else delete apiKeys[provider]

        const next: StoredModelCredentials = { version: 1, apiKeys }
        await mkdir(this.rootDir, { recursive: true, mode: 0o700 })
        await writeFileAtomically(
          this.#credentialPath,
          this.#encrypt(JSON.stringify(next), await this.#loadOrCreateKey()),
          { mode: 0o600 }
        )
        this.#credentials = Promise.resolve(next)
      })
    return this.#writeQueue
  }

  #read(): Promise<StoredModelCredentials> {
    this.#credentials ??= this.#readFile().catch((error: unknown) => {
      this.#credentials = null
      throw error
    })
    return this.#credentials
  }

  async #readFile(): Promise<StoredModelCredentials> {
    let encrypted: Buffer
    try {
      encrypted = await readFile(this.#credentialPath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, apiKeys: {} }
      throw error
    }
    const parsed: unknown = JSON.parse(
      this.#decrypt(encrypted, validateKey(await readFile(this.#keyPath)))
    )
    if (!isPlainObject(parsed) || parsed.version !== 1)
      throw new Error(workbenchMainText('account.modelCredentialStoreInvalid'))
    return { version: 1, apiKeys: readApiKeys(parsed.apiKeys) }
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
      value.length < prefixLength + CredentialIvBytes + CredentialTagBytes ||
      !value.subarray(0, prefixLength).equals(CredentialPayloadPrefix)
    ) {
      throw new Error(workbenchMainText('account.modelCredentialStoreInvalid'))
    }
    const ivStart = prefixLength
    const tagStart = ivStart + CredentialIvBytes
    const encryptedStart = tagStart + CredentialTagBytes
    const decipher = createDecipheriv('aes-256-gcm', key, value.subarray(ivStart, tagStart))
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
  if (!isPlainObject(value))
    throw new Error(workbenchMainText('account.modelCredentialStoreInvalid'))
  return Object.fromEntries(
    Object.entries(value).map(([provider, apiKey]) => {
      if (typeof apiKey !== 'string')
        throw new Error(workbenchMainText('account.modelCredentialStoreInvalid'))
      return [provider, apiKey]
    })
  )
}

function validateKey(key: Buffer): Buffer {
  if (key.length !== CredentialKeyBytes)
    throw new Error(workbenchMainText('account.modelCredentialKeyInvalid'))
  return key
}
