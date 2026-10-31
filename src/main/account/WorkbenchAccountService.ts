import { randomUUID } from 'node:crypto'
import os from 'node:os'

import { optionalWhen } from '@velaros-ai/core'
import type {
  ModelPricingCatalog,
  ModelPricingEntry,
  ProviderModelCatalog,
  ProviderModelCatalogEntry,
} from '@velaros-ai/model/contracts'

import type { WorkbenchAccountState } from '../../shared/workbenchAccount'
import type {
  WorkbenchManagedModelAccessSnapshot,
  WorkbenchManagedModelOption,
  WorkbenchManagedModelProvider,
  WorkbenchManagedModelProviderId,
} from '../../shared/workbenchModel'
import { getWorkbenchManagedModelProviderLabel } from '../../shared/workbenchModel'
import { workbenchMainText } from '../i18n/workbenchMainMessages'

import type { WorkbenchCloudSession } from './WorkbenchSharedAccountStore'
import { type WorkbenchSharedAccountStore } from './WorkbenchSharedAccountStore'

const DefaultCloudBaseUrl = 'https://8.152.209.233/api'
const DeviceIdHeader = 'X-VelarOS-Device-Id'
const GoogleSignInTimeoutMs = 3 * 60_000
const CloudRequestTimeoutMs = 20_000
/** 公开价格目录在进程里留多久（与 Desktop 相同）；服务端给的过期时间更早时以它为准。 */
const PublicModelPricingCacheMs = 15 * 60_000
const ManagedProviderIds = new Set<WorkbenchManagedModelProviderId>(['velaros', 'velar-dev'])

interface GoogleDesktopStart {
  readonly authorizationUrl: string
  readonly attemptId: string
  readonly exchangeToken: string
  readonly expiresAt: string
  readonly pollAfterMs: number
}

type GoogleDesktopResult =
  | { readonly status: 'pending'; readonly retryAfterMs: number; readonly expiresAt: string }
  | { readonly status: 'complete'; readonly session: WorkbenchCloudSession }

export class WorkbenchAccountService {
  readonly #baseUrl: string
  #refreshOperation: { token: string; promise: Promise<WorkbenchCloudSession> } | null = null
  #signInOperation: Promise<WorkbenchAccountState> | null = null
  #publicModelPricing: { readonly catalog: ModelPricingCatalog; readonly expiresAt: number } | null =
    null

  public constructor(
    private readonly store: WorkbenchSharedAccountStore,
    private readonly openExternal: (url: string) => Promise<void>,
    cloudBaseUrl = process.env['VELAROS_CLOUD_URL']?.trim() || DefaultCloudBaseUrl,
    private readonly fetchImpl: typeof fetch = fetch
  ) {
    this.#baseUrl = cloudBaseUrl.replace(/\/$/u, '')
  }

  public async getState(): Promise<WorkbenchAccountState> {
    const session = await this.store.load()
    if (!session) return { status: 'signed-out' }
    if (Date.parse(session.refreshExpiresAt) <= Date.now()) {
      await this.store.disconnect()
      return { status: 'signed-out' }
    }
    return { status: 'signed-in', account: session.account }
  }

  public async ensureSignedIn(): Promise<WorkbenchAccountState> {
    const state = await this.getState()
    return state.status === 'signed-in' ? state : this.signIn()
  }

  public signIn(): Promise<WorkbenchAccountState> {
    if (this.#signInOperation) return this.#signInOperation
    const operation = this.#performGoogleSignIn().finally(() => {
      if (this.#signInOperation === operation) this.#signInOperation = null
    })
    this.#signInOperation = operation
    return operation
  }

  public async signOut(): Promise<WorkbenchAccountState> {
    const session = await this.store.load()
    const releaseRemote = await this.store.disconnect()
    if (session && releaseRemote) {
      const deviceId = await this.store.getDeviceId()
      await this.#request('/v1/auth/session/logout', {
        headers: {
          Authorization: `Bearer ${session.accessToken}`,
          [DeviceIdHeader]: deviceId,
        },
        body: { refreshToken: session.refreshToken },
      }).catch(() => undefined)
    }
    return { status: 'signed-out' }
  }

  public getPluginArtifactBaseUrl(): string {
    return `${this.#baseUrl}/v1/plugins/`
  }

  public getManagedModelBaseUrl(providerId: WorkbenchManagedModelProviderId): string {
    return `${this.#baseUrl}${managedModelEndpointPath(providerId)}`
  }

  /**
   * 每次只读取在线账号快照，不落盘、不使用离线租约。管理后台撤权后，下一次刷新或发送
   * 就会得到空授权，Workbench 不会根据账号角色自行补出托管 provider。
   */
  public async getManagedModelAccess(): Promise<WorkbenchManagedModelAccessSnapshot> {
    return parseWorkbenchManagedModelAccessSnapshot(
      await this.#authorizedJson('/v1/account/usage')
    )
  }

  public async listManagedProviderModels(
    providerId: WorkbenchManagedModelProviderId
  ): Promise<ProviderModelCatalog> {
    const access = await this.#requireManagedProvider(providerId)
    const response = await this.#authorizedFetch(
      `${managedModelEndpointPath(providerId)}/models`,
      { method: 'GET', headers: { Accept: 'application/json' } }
    )
    if (!response.ok) {
      throw new Error(
        workbenchMainText('account.modelCatalogRequestFailed', {
          provider: access.displayName,
          status: response.status,
        })
      )
    }
    const allowedModels = new Set(
      access.models
        .filter((model) => model.status === 'available')
        .map((model) => model.id)
    )
    const models = parseManagedProviderModelList(await response.json())
      .filter((model) => allowedModels.has(model.id))
    return {
      provider: providerId,
      source: 'remote',
      models,
      fetchedAt: Date.now(),
    }
  }

  /**
   * Platform 的 Velar transport 只能命中当前 provider 的固定 chat 路径。这里覆盖它传来的
   * dummy Authorization，并注入 Workbench 当前账号 token；两个 provider 没有跨路由回退。
   */
  public async fetchManagedModel(
    providerId: WorkbenchManagedModelProviderId,
    input: string | URL | Request,
    init?: RequestInit
  ): Promise<Response> {
    const target = new URL(input instanceof Request ? input.url : input.toString())
    const expected = new URL(`${this.getManagedModelBaseUrl(providerId)}/chat/completions`)
    if (
      target.origin !== expected.origin
      || target.pathname !== expected.pathname
      || target.username
      || target.password
      || target.hash
    ) {
      throw new Error(workbenchMainText('account.untrustedModelEndpoint', { provider: providerId }))
    }

    await this.#requireManagedProvider(providerId)
    const session = await this.#requireActiveSession()
    const headers = new Headers(input instanceof Request ? input.headers : undefined)
    new Headers(init?.headers).forEach((value, key) => headers.set(key, value))
    headers.set('Authorization', `Bearer ${session.accessToken}`)
    headers.set(DeviceIdHeader, await this.store.getDeviceId())
    if (!headers.has('Idempotency-Key')) headers.set('Idempotency-Key', randomUUID())

    const requestInput = input instanceof Request ? new Request(target, input) : target
    return this.fetchImpl(requestInput, { ...init, headers })
  }

  /**
   * 公开模型价格目录：只用来在本地估算用户所选服务商的成本（回答末尾的约价），不代表 Velar 计费，
   * 也不需要登录。刷新失败时沿用上一份。
   */
  public async getPublicModelPricing(): Promise<ModelPricingCatalog> {
    const cached = this.#publicModelPricing
    if (cached && cached.expiresAt > Date.now()) return cached.catalog

    try {
      const response = await this.fetchImpl(`${this.#baseUrl}/v1/model-pricing`, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(CloudRequestTimeoutMs),
      })
      if (!response.ok) throw new Error(workbenchMainText('account.pricingRequestFailed', { status: response.status }))
      const catalog = parseModelPricingCatalog(await response.json())
      const serverExpiry = Date.parse(catalog.expiresAt)
      this.#publicModelPricing = {
        catalog,
        expiresAt: Math.min(
          Number.isFinite(serverExpiry) ? serverExpiry : Number.POSITIVE_INFINITY,
          Date.now() + PublicModelPricingCacheMs
        ),
      }
      return catalog
    } catch (error) {
      if (cached) return cached.catalog
      throw error
    }
  }

  public async fetchPluginResource(input: URL): Promise<Response> {
    const base = new URL(this.getPluginArtifactBaseUrl())
    if (input.origin !== base.origin || !input.pathname.startsWith(base.pathname)) {
      throw new Error(workbenchMainText('account.untrustedPluginUrl'))
    }
    await this.ensureSignedIn()
    const session = await this.#requireActiveSession()
    return this.fetchImpl(input, {
      headers: {
        Authorization: `Bearer ${session.accessToken}`,
        [DeviceIdHeader]: await this.store.getDeviceId(),
      },
    })
  }

  async #performGoogleSignIn(): Promise<WorkbenchAccountState> {
    const deviceId = await this.store.getDeviceId()
    const started = await this.#request<GoogleDesktopStart>('/v1/auth/google/desktop/start', {
      headers: { [DeviceIdHeader]: deviceId },
    })
    const authorizationUrl = new URL(started.authorizationUrl)
    if (authorizationUrl.protocol !== 'https:' || authorizationUrl.hostname !== 'accounts.google.com') {
      throw new Error(workbenchMainText('account.untrustedSignInUrl'))
    }
    await this.openExternal(authorizationUrl.toString())
    const deadline = Math.min(
      Date.now() + GoogleSignInTimeoutMs,
      Number.isFinite(Date.parse(started.expiresAt))
        ? Date.parse(started.expiresAt)
        : Date.now() + GoogleSignInTimeoutMs
    )
    let retryAfterMs = Math.max(500, started.pollAfterMs)
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, retryAfterMs))
      const result = await this.#request<GoogleDesktopResult>('/v1/auth/google/desktop/session', {
        headers: { [DeviceIdHeader]: deviceId },
        body: {
          attemptId: started.attemptId,
          exchangeToken: started.exchangeToken,
          deviceName: os.hostname().replace(/\.(local|lan|home)$/iu, '').slice(0, 120),
          devicePlatform: process.platform === 'darwin' ? 'macOS' : process.platform,
        },
      })
      if (result.status === 'pending') {
        retryAfterMs = Math.max(500, result.retryAfterMs)
        continue
      }
      await this.store.save(result.session)
      return { status: 'signed-in', account: result.session.account }
    }
    throw new Error(workbenchMainText('account.signInTimedOut'))
  }

  async #request<T = unknown>(
    path: string,
    input: { readonly headers?: Record<string, string>; readonly body?: unknown }
  ): Promise<T> {
    const response = await this.fetchImpl(`${this.#baseUrl}${path}`, {
      method: 'POST',
      signal: AbortSignal.timeout(CloudRequestTimeoutMs),
      headers: { 'Content-Type': 'application/json', ...input.headers },
      body: JSON.stringify(input.body ?? {}),
    })
    if (!response.ok) throw new Error(workbenchMainText('account.serviceRequestFailed', { status: response.status }))
    return await response.json() as T
  }

  async #authorizedJson(path: string): Promise<unknown> {
    const response = await this.#authorizedFetch(path, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(CloudRequestTimeoutMs),
    })
    if (!response.ok) throw new Error(workbenchMainText('account.serviceRequestFailed', { status: response.status }))
    return response.json()
  }

  async #authorizedFetch(path: string, init: RequestInit): Promise<Response> {
    if (!path.startsWith('/v1/')) throw new Error(workbenchMainText('account.invalidCloudPath'))
    const session = await this.#requireActiveSession()
    const headers = new Headers(init.headers)
    headers.set('Authorization', `Bearer ${session.accessToken}`)
    headers.set(DeviceIdHeader, await this.store.getDeviceId())
    return this.fetchImpl(`${this.#baseUrl}${path}`, { ...init, headers })
  }

  async #requireActiveSession(): Promise<WorkbenchCloudSession> {
    const session = await this.store.load()
    if (!session || Date.parse(session.refreshExpiresAt) <= Date.now()) {
      if (session) await this.store.disconnect()
      throw new Error(workbenchMainText('account.signInRequired'))
    }
    if (Date.parse(session.accessExpiresAt) - Date.now() > 60_000) return session
    if (this.#refreshOperation?.token === session.refreshToken) return this.#refreshOperation.promise
    const operation = this.#refreshSession(session).finally(() => {
      if (this.#refreshOperation?.promise === operation) this.#refreshOperation = null
    })
    this.#refreshOperation = { token: session.refreshToken, promise: operation }
    return operation
  }

  async #refreshSession(previous: WorkbenchCloudSession): Promise<WorkbenchCloudSession> {
    try {
      const next = await this.#request<WorkbenchCloudSession>('/v1/auth/session/refresh', {
        headers: { [DeviceIdHeader]: await this.store.getDeviceId() },
        body: { refreshToken: previous.refreshToken },
      })
      const current = await this.store.replaceSession(previous, next)
      if (!current) throw new Error(workbenchMainText('account.signInRequired'))
      return current
    } catch (error) {
      // Desktop 可能已续期；旧凭据失败不能清掉它刚写入的共享登录。
      const current = await this.store.load()
      if (
        current?.account.id === previous.account.id &&
        current.refreshToken !== previous.refreshToken &&
        Date.parse(current.accessExpiresAt) > Date.now()
      )
        return current
      throw error
    }
  }

  async #requireManagedProvider(
    providerId: WorkbenchManagedModelProviderId
  ): Promise<WorkbenchManagedModelProvider> {
    const access = await this.getManagedModelAccess()
    const provider = access.managedModels.find((entry) => entry.providerId === providerId)
    if (!provider)
      throw new Error(
        workbenchMainText('account.providerNotGranted', {
          provider: getWorkbenchManagedModelProviderLabel(providerId),
        })
      )
    if (!provider.enabled)
      throw new Error(workbenchMainText('account.providerUnavailable', { provider: provider.displayName }))
    return provider
  }
}

export function parseWorkbenchManagedModelAccessSnapshot(
  value: unknown
): WorkbenchManagedModelAccessSnapshot {
  const root = readRecord(value, 'account usage')
  const updatedAt = readNonEmptyString(root['updatedAt'], 'account usage.updatedAt')
  const rawManagedModels = root['managedModels']
  if (rawManagedModels === undefined) return { managedModels: [], updatedAt }
  if (!Array.isArray(rawManagedModels)) {
    throw new Error(workbenchMainText('account.invalidGrantFormat'))
  }

  const managedModels: WorkbenchManagedModelProvider[] = []
  const seen = new Set<WorkbenchManagedModelProviderId>()
  for (const rawProvider of rawManagedModels) {
    const provider = parseManagedProvider(rawProvider)
    if (!provider || seen.has(provider.providerId)) continue
    seen.add(provider.providerId)
    managedModels.push(provider)
  }
  return { managedModels, updatedAt }
}

function parseManagedProvider(value: unknown): WorkbenchManagedModelProvider | null {
  const record = readRecord(value, 'managed model')
  const providerId = record['providerId']
  if (typeof providerId !== 'string' || !isManagedModelProviderId(providerId)) return null
  if (typeof record['enabled'] !== 'boolean') {
    throw new Error(workbenchMainText('account.invalidProviderEnabledState', { provider: providerId }))
  }
  readNonEmptyString(
    record['displayName'],
    `${providerId}.displayName`
  )
  const defaultModel = optionalNonEmptyString(record['defaultModel'])
  const modelSources = [record['models']]
  const routePolicy = record['routePolicy']
  if (isRecord(routePolicy)) modelSources.push(routePolicy['models'])
  const models = parseManagedProviderOptions(modelSources)
  return {
    providerId,
    displayName: getWorkbenchManagedModelProviderLabel(providerId),
    enabled: record['enabled'],
    defaultModel,
    models,
  }
}

function parseManagedProviderOptions(sources: readonly unknown[]): WorkbenchManagedModelOption[] {
  const models: WorkbenchManagedModelOption[] = []
  const seen = new Set<string>()
  for (const source of sources) {
    if (source === undefined) continue
    if (!Array.isArray(source)) throw new Error(workbenchMainText('account.invalidManagedCatalog'))
    for (const value of source) {
      if (!isRecord(value)) throw new Error(workbenchMainText('account.invalidManagedEntry'))
      const id = readNonEmptyString(value['id'], 'managed model.id')
      if (id.length > 512 || seen.has(id)) continue
      const label = optionalNonEmptyString(value['label']) ?? id
      const rawStatus = value['status']
      const status =
        rawStatus === undefined || rawStatus === 'available'
          ? 'available'
          : rawStatus === 'disabled' || rawStatus === 'not-configured'
          ? rawStatus
          : null
      if (!status) throw new Error(workbenchMainText('account.invalidManagedState'))
      seen.add(id)
      models.push({ id, label: label.slice(0, 256), status })
    }
  }
  return models
}

function parseManagedProviderModelList(value: unknown): ProviderModelCatalogEntry[] {
  const root = readRecord(value, 'model catalog')
  if (!Array.isArray(root['data'])) throw new Error(workbenchMainText('account.invalidCatalog'))
  const models: ProviderModelCatalogEntry[] = []
  const seen = new Set<string>()
  for (const value of root['data'].slice(0, 256)) {
    if (!isRecord(value)) continue
    const id = optionalNonEmptyString(value['id'])
    if (!id || id.length > 512 || seen.has(id)) continue
    const label = optionalNonEmptyString(value['display_name']) ?? id
    seen.add(id)
    models.push({ id, label: label.slice(0, 256) })
  }
  return models
}

function managedModelEndpointPath(providerId: WorkbenchManagedModelProviderId): string {
  return providerId === 'velar-dev' ? '/v1/velar-dev' : '/v1/model'
}

function isManagedModelProviderId(value: string): value is WorkbenchManagedModelProviderId {
  return ManagedProviderIds.has(value as WorkbenchManagedModelProviderId)
}

/** 价格目录来自网络：外壳不对就报错，单条价格不对就丢掉那一条。 */
export function parseModelPricingCatalog(value: unknown): ModelPricingCatalog {
  const root = readRecord(value, 'model pricing')
  if (root['currency'] !== 'USD') throw new Error(workbenchMainText('account.invalidPricingCurrency'))
  const entries = root['entries']
  if (!Array.isArray(entries)) throw new Error(workbenchMainText('account.invalidPricing'))
  return {
    currency: 'USD',
    version: readNonEmptyString(root['version'], 'model pricing.version'),
    updatedAt: readNonEmptyString(root['updatedAt'], 'model pricing.updatedAt'),
    expiresAt: readNonEmptyString(root['expiresAt'], 'model pricing.expiresAt'),
    entries: entries.flatMap((entry): ModelPricingEntry[] => {
      if (!isRecord(entry)) return []
      const {
        provider,
        model,
        aliases,
        inputUsdPerMillion,
        outputUsdPerMillion,
        cacheReadUsdPerMillion,
        cacheWriteUsdPerMillion,
        source,
      } = entry
      if (
        typeof provider !== 'string' || !provider.trim()
        || typeof model !== 'string' || !model.trim()
        || !isNonNegativePrice(inputUsdPerMillion)
        || !isNonNegativePrice(outputUsdPerMillion)
      )
        return []
      return [{
        provider,
        model,
        aliases: Array.isArray(aliases)
          ? aliases.filter((alias): alias is string => typeof alias === 'string')
          : [],
        inputUsdPerMillion,
        outputUsdPerMillion,
        // 缓存读 / 写单价是可选项：目录给了才透传，回答末尾的整轮约价据此给缓存命中的输入单独计价。
        cacheReadUsdPerMillion: readOptionalPrice(cacheReadUsdPerMillion),
        cacheWriteUsdPerMillion: readOptionalPrice(cacheWriteUsdPerMillion),
        source: typeof source === 'string' ? source : '',
      }]
    }),
  }
}

function isNonNegativePrice(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function readOptionalPrice(value: unknown): number | undefined {
  return optionalWhen(isNonNegativePrice(value), value as number)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(workbenchMainText('account.mustBeObject', { label }))
  return value
}

function readNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(workbenchMainText('account.mustBeNonEmptyString', { label }))
  return value.trim()
}

function optionalNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}
