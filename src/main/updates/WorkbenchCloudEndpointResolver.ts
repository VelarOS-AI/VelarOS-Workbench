import { createPublicKey, verify } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { isPlainObject, Log } from '@velaros-ai/velaros/core'
import { writeJsonFileAtomically } from '@velaros-ai/velaros/core/utils/FilePersistence'

import type { VelarOSOfficialWebsiteMarket } from '../VelarOSOfficialWebsite'

export type WorkbenchCloudMarket = VelarOSOfficialWebsiteMarket

interface WorkbenchCloudOrigin {
  readonly id: string
  readonly baseUrl: string
  readonly priority: number
  readonly enabled: boolean
  readonly dataSourceId: string
}

export interface WorkbenchCloudRoutingManifestPayload {
  readonly schemaVersion: 1
  readonly revision: number
  readonly market: WorkbenchCloudMarket
  readonly issuedAt: string
  readonly expiresAt: string
  readonly cloudOrigins: readonly WorkbenchCloudOrigin[]
  readonly websiteBaseUrl?: string
}

export interface SignedWorkbenchCloudRoutingManifest extends WorkbenchCloudRoutingManifestPayload {
  readonly attestation: {
    readonly algorithm: 'ed25519'
    readonly keyId: string
    readonly signature: string
  }
}

export interface WorkbenchCloudEndpointProvider {
  currentBaseUrl(): string
  candidates(): Promise<readonly string[]>
  markHealthy(baseUrl: string): void
}

export interface WorkbenchCloudRoutingManifestStore {
  load(): Promise<unknown>
  save(manifest: unknown): Promise<void>
}

interface WorkbenchCloudEndpointResolverOptions {
  readonly market: WorkbenchCloudMarket
  readonly embeddedBaseUrl: string
  readonly overrideBaseUrl?: string
  readonly manifestUrls: readonly string[]
  readonly routingPublicKeySpki: string
  readonly minimumRevision: number
  readonly manifestStore: WorkbenchCloudRoutingManifestStore
  readonly fetchImpl?: typeof fetch
  readonly now?: () => Date
  readonly refreshIntervalMs?: number
}

export const WorkbenchEmbeddedCloudBaseUrl = 'https://8.152.209.233/api'
export const WorkbenchCloudRoutingPublicKeySpki =
  'MCowBQYDK2VwAyEAvv9nJ//GTP8YW+E5A35KZ9RMN1fJigmja7wcCc3gUks='
export const WorkbenchCloudRoutingMinimumRevision = 2

const ManifestRequestTimeoutMs = 3_000
const log = Log.tag('WorkbenchCloudRouting')

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function sortCanonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortCanonicalValue)
  if (!isPlainObject(value)) return value
  return Object.fromEntries(
    Object.keys(value)
      .filter((key) => key !== 'attestation' && value[key] !== undefined)
      .sort()
      .map((key) => [key, sortCanonicalValue(value[key])])
  )
}

export function canonicalizeWorkbenchCloudRoutingManifest(
  manifest: WorkbenchCloudRoutingManifestPayload
): string {
  return JSON.stringify(sortCanonicalValue(manifest))
}

export function workbenchCloudRoutingManifestUrls(market: WorkbenchCloudMarket): readonly string[] {
  return market === 'cn'
    ? [
        'https://8.152.209.233/velaros-desktop-routing.cn.json',
        'https://global.velaros.cn/velaros-desktop-routing.cn.json',
      ]
    : [
        'https://global.velaros.cn/velaros-desktop-routing.global.json',
        'https://8.152.209.233/velaros-desktop-routing.global.json',
      ]
}

function normalizeBaseUrl(value: string): string {
  const normalized = value.trim().replace(/\/$/u, '')
  let url: URL
  try {
    url = new URL(normalized)
  } catch (error) {
    throw new Error('Workbench Cloud route contains an invalid URL.', { cause: error })
  }
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1'
  if (
    (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname.replace(/\/$/u, '') !== '/api'
  ) {
    throw new Error('Workbench Cloud routes require a trusted API base URL.')
  }
  return normalized
}

function normalizeWebsiteOrigin(value: string): string {
  let url: URL
  try {
    url = new URL(value)
  } catch (error) {
    throw new Error('Workbench Cloud route contains an invalid website origin.', {
      cause: error,
    })
  }
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1'
  if (
    (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname !== '' && url.pathname !== '/')
  ) {
    throw new Error('Workbench Cloud route contains an invalid website origin.')
  }
  return url.origin
}

function isCloudOrigin(value: unknown): value is WorkbenchCloudOrigin {
  return (
    isPlainObject(value) &&
    typeof value['id'] === 'string' &&
    typeof value['baseUrl'] === 'string' &&
    Number.isSafeInteger(value['priority']) &&
    typeof value['enabled'] === 'boolean' &&
    typeof value['dataSourceId'] === 'string'
  )
}

function parseManifest(value: unknown): SignedWorkbenchCloudRoutingManifest {
  if (
    !isPlainObject(value) ||
    value['schemaVersion'] !== 1 ||
    !Number.isSafeInteger(value['revision']) ||
    (value['market'] !== 'cn' && value['market'] !== 'global') ||
    typeof value['issuedAt'] !== 'string' ||
    typeof value['expiresAt'] !== 'string' ||
    !Array.isArray(value['cloudOrigins']) ||
    !value['cloudOrigins'].every(isCloudOrigin) ||
    (value['websiteBaseUrl'] !== undefined && typeof value['websiteBaseUrl'] !== 'string') ||
    !isPlainObject(value['attestation']) ||
    value['attestation']['algorithm'] !== 'ed25519' ||
    typeof value['attestation']['keyId'] !== 'string' ||
    typeof value['attestation']['signature'] !== 'string'
  ) {
    throw new Error('Workbench Cloud routing manifest is invalid.')
  }
  return value as unknown as SignedWorkbenchCloudRoutingManifest
}

export class StaticWorkbenchCloudEndpointProvider implements WorkbenchCloudEndpointProvider {
  readonly #baseUrl: string

  public constructor(baseUrl: string) {
    this.#baseUrl = normalizeBaseUrl(baseUrl)
  }

  public currentBaseUrl(): string {
    return this.#baseUrl
  }

  public async candidates(): Promise<readonly string[]> {
    return [this.#baseUrl]
  }

  public markHealthy(): void {}
}

export class WorkbenchCloudRoutingManifestFileStore implements WorkbenchCloudRoutingManifestStore {
  readonly #filePath: string

  public constructor(dataRootDir: string, market: WorkbenchCloudMarket) {
    this.#filePath = join(dataRootDir, 'storage', `cloud-routing-${market}.json`)
  }

  public async load(): Promise<unknown> {
    return JSON.parse(await readFile(this.#filePath, 'utf8')) as unknown
  }

  public async save(manifest: unknown): Promise<void> {
    await writeJsonFileAtomically(this.#filePath, manifest, {
      mode: 0o600,
      space: 2,
      trailingNewline: true,
    })
  }
}

export class WorkbenchCloudEndpointResolver implements WorkbenchCloudEndpointProvider {
  readonly #options: WorkbenchCloudEndpointResolverOptions
  readonly #publicKey: ReturnType<typeof createPublicKey>
  readonly #embeddedBaseUrl: string
  readonly #overrideBaseUrl?: string
  #manifest: Nullable<SignedWorkbenchCloudRoutingManifest> = null
  #loadedCache = false
  #loadingCache: Nullable<Promise<void>> = null
  #lastRefreshAt = 0
  #refreshing: Nullable<Promise<void>> = null
  #healthyBaseUrl: Nullable<string> = null

  public constructor(options: WorkbenchCloudEndpointResolverOptions) {
    this.#options = options
    this.#embeddedBaseUrl = normalizeBaseUrl(options.embeddedBaseUrl)
    this.#overrideBaseUrl = options.overrideBaseUrl?.trim()
      ? normalizeBaseUrl(options.overrideBaseUrl)
      : undefined
    this.#publicKey = createPublicKey({
      key: Buffer.from(options.routingPublicKeySpki, 'base64'),
      format: 'der',
      type: 'spki',
    })
  }

  public currentBaseUrl(): string {
    if (this.#overrideBaseUrl) return this.#overrideBaseUrl
    const candidates = [...new Set([...this.#orderedOrigins(), this.#embeddedBaseUrl])]
    return this.#healthyBaseUrl && candidates.includes(this.#healthyBaseUrl)
      ? this.#healthyBaseUrl
      : (candidates[0] ?? this.#embeddedBaseUrl)
  }

  public async candidates(): Promise<readonly string[]> {
    if (this.#overrideBaseUrl) return [this.#overrideBaseUrl]
    await this.#loadCacheOnce()
    await this.#refreshIfNeeded()
    const candidates = [...new Set([...this.#orderedOrigins(), this.#embeddedBaseUrl])]
    const healthyBaseUrl =
      this.#healthyBaseUrl && candidates.includes(this.#healthyBaseUrl)
        ? this.#healthyBaseUrl
        : null
    const ordered = healthyBaseUrl
      ? [healthyBaseUrl, ...candidates.filter((candidate) => candidate !== healthyBaseUrl)]
      : candidates
    return ordered
  }

  public markHealthy(baseUrl: string): void {
    const normalized = normalizeBaseUrl(baseUrl)
    if (
      normalized === this.#overrideBaseUrl ||
      normalized === this.#embeddedBaseUrl ||
      this.#orderedOrigins().includes(normalized)
    ) {
      this.#healthyBaseUrl = normalized
    }
  }

  async #loadCacheOnce(): Promise<void> {
    if (this.#loadedCache) return
    if (this.#loadingCache) return this.#loadingCache
    const operation = (async () => {
      try {
        this.#acceptManifest(parseManifest(await this.#options.manifestStore.load()))
      } catch (error) {
        if (!isRecord(error) || error['code'] !== 'ENOENT') {
          log.warn('Ignoring an invalid Workbench Cloud routing cache.', { error })
        }
      }
    })().finally(() => {
      this.#loadedCache = true
      if (this.#loadingCache === operation) this.#loadingCache = null
    })
    this.#loadingCache = operation
    return operation
  }

  async #refreshIfNeeded(): Promise<void> {
    if (this.#refreshing) return this.#refreshing
    const now = (this.#options.now ?? (() => new Date()))().getTime()
    if (now - this.#lastRefreshAt < (this.#options.refreshIntervalMs ?? 15 * 60_000)) return
    this.#lastRefreshAt = now
    const operation = this.#refresh().finally(() => {
      if (this.#refreshing === operation) this.#refreshing = null
    })
    this.#refreshing = operation
    return operation
  }

  async #refresh(): Promise<void> {
    const fetchImpl = this.#options.fetchImpl ?? fetch
    for (const url of this.#options.manifestUrls) {
      try {
        const response = await fetchImpl(url, {
          headers: { Accept: 'application/json' },
          signal: AbortSignal.timeout(ManifestRequestTimeoutMs),
        })
        if (!response.ok) continue
        const manifest = parseManifest(await response.json())
        this.#acceptManifest(manifest)
        await this.#options.manifestStore.save(manifest)
        return
      } catch (error) {
        log.warn('Workbench Cloud routing endpoint is temporarily unavailable.', { url, error })
      }
    }
  }

  #acceptManifest(manifest: SignedWorkbenchCloudRoutingManifest): void {
    const now = (this.#options.now ?? (() => new Date()))().getTime()
    const issuedAt = Date.parse(manifest.issuedAt)
    const expiresAt = Date.parse(manifest.expiresAt)
    if (
      manifest.market !== this.#options.market ||
      manifest.revision < this.#options.minimumRevision ||
      !Number.isFinite(issuedAt) ||
      !Number.isFinite(expiresAt) ||
      issuedAt > now + 5 * 60_000 ||
      expiresAt <= now ||
      (this.#manifest && manifest.revision < this.#manifest.revision)
    ) {
      throw new Error('Workbench Cloud routing manifest identity is invalid.')
    }
    const { attestation: _attestation, ...payload } = manifest
    const signature = Buffer.from(manifest.attestation.signature, 'base64url')
    if (
      signature.byteLength !== 64 ||
      !verify(
        null,
        Buffer.from(canonicalizeWorkbenchCloudRoutingManifest(payload), 'utf8'),
        this.#publicKey,
        signature
      )
    ) {
      throw new Error('Workbench Cloud routing manifest signature is invalid.')
    }
    const enabledOrigins = manifest.cloudOrigins.filter((origin) => origin.enabled)
    if (
      enabledOrigins.length === 0 ||
      new Set(manifest.cloudOrigins.map((origin) => origin.id)).size !==
        manifest.cloudOrigins.length ||
      new Set(enabledOrigins.map((origin) => origin.dataSourceId)).size !== 1
    ) {
      throw new Error('Workbench Cloud routing manifest origins are invalid.')
    }
    for (const origin of manifest.cloudOrigins) normalizeBaseUrl(origin.baseUrl)
    if (manifest.websiteBaseUrl !== undefined) {
      normalizeWebsiteOrigin(manifest.websiteBaseUrl)
    }
    this.#manifest = manifest
    if (
      this.#healthyBaseUrl &&
      !enabledOrigins.some((origin) => normalizeBaseUrl(origin.baseUrl) === this.#healthyBaseUrl)
    ) {
      this.#healthyBaseUrl = null
    }
  }

  #orderedOrigins(): string[] {
    const now = (this.#options.now ?? (() => new Date()))().getTime()
    if (!this.#manifest || Date.parse(this.#manifest.expiresAt) <= now) return []
    return this.#manifest.cloudOrigins
      .filter((origin) => origin.enabled)
      .sort((left, right) => right.priority - left.priority || left.id.localeCompare(right.id))
      .map((origin) => normalizeBaseUrl(origin.baseUrl))
  }
}
