import { randomUUID } from 'node:crypto'
import os from 'node:os'

import type { ProviderModelCatalog, ProviderModelCatalogEntry } from '@velaros-ai/model/contracts'

import type { WorkbenchAccountState } from '../../shared/workbenchAccount'
import type {
  WorkbenchManagedModelAccessSnapshot,
  WorkbenchManagedModelOption,
  WorkbenchManagedModelProvider,
  WorkbenchManagedModelProviderId,
} from '../../shared/workbenchModel'

import type { WorkbenchCloudSession } from './WorkbenchSharedAccountStore'
import { type WorkbenchSharedAccountStore } from './WorkbenchSharedAccountStore'

const DefaultCloudBaseUrl = 'https://8.152.209.233/api'
const DeviceIdHeader = 'X-VelarOS-Device-Id'
const GoogleSignInTimeoutMs = 3 * 60_000
const CloudRequestTimeoutMs = 20_000
const ManagedProviderIds = new Set<WorkbenchManagedModelProviderId>(['velar', 'velar-dev'])

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
  #signInOperation: Promise<WorkbenchAccountState> | null = null

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
      throw new Error(`${access.displayName} 模型目录请求失败（${response.status}）。`)
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
      throw new Error(`${providerId} 模型请求地址不受信任。`)
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

  public async fetchPluginResource(input: URL): Promise<Response> {
    const base = new URL(this.getPluginArtifactBaseUrl())
    if (input.origin !== base.origin || !input.pathname.startsWith(base.pathname)) {
      throw new Error('Workbench 拒绝访问不受信任的插件地址。')
    }
    await this.ensureSignedIn()
    const session = await this.store.load()
    if (!session) throw new Error('请先登录 VelarOS 再下载插件。')
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
      throw new Error('VelarOS 返回了不受信任的登录地址。')
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
    throw new Error('VelarOS 登录等待超时，请重新尝试。')
  }

  async #request<T = unknown>(
    path: string,
    input: { readonly headers?: Record<string, string>; readonly body?: unknown }
  ): Promise<T> {
    const response = await this.fetchImpl(`${this.#baseUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...input.headers },
      body: JSON.stringify(input.body ?? {}),
    })
    if (!response.ok) throw new Error(`VelarOS 账户服务请求失败（${response.status}）。`)
    return await response.json() as T
  }

  async #authorizedJson(path: string): Promise<unknown> {
    const response = await this.#authorizedFetch(path, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(CloudRequestTimeoutMs),
    })
    if (!response.ok) throw new Error(`VelarOS 账户服务请求失败（${response.status}）。`)
    return response.json()
  }

  async #authorizedFetch(path: string, init: RequestInit): Promise<Response> {
    if (!path.startsWith('/v1/')) throw new Error('VelarOS Cloud 请求路径无效。')
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
      throw new Error('请先登录 VelarOS。')
    }
    return session
  }

  async #requireManagedProvider(
    providerId: WorkbenchManagedModelProviderId
  ): Promise<WorkbenchManagedModelProvider> {
    const access = await this.getManagedModelAccess()
    const provider = access.managedModels.find((entry) => entry.providerId === providerId)
    if (!provider) throw new Error(`当前账户尚未获得 ${managedProviderLabel(providerId)} 授权。`)
    if (!provider.enabled) throw new Error(`${provider.displayName} 当前不可用。`)
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
    throw new Error('VelarOS 托管模型授权格式无效。')
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
    throw new Error(`${providerId} 托管模型启用状态无效。`)
  }
  const displayName = readNonEmptyString(
    record['displayName'],
    `${providerId}.displayName`
  ).slice(0, 120)
  const defaultModel = optionalNonEmptyString(record['defaultModel'])
  const modelSources = [record['models']]
  const routePolicy = record['routePolicy']
  if (isRecord(routePolicy)) modelSources.push(routePolicy['models'])
  const models = parseManagedProviderOptions(modelSources)
  return {
    providerId,
    displayName,
    enabled: record['enabled'],
    ...(defaultModel ? { defaultModel } : {}),
    models,
  }
}

function parseManagedProviderOptions(sources: readonly unknown[]): WorkbenchManagedModelOption[] {
  const models: WorkbenchManagedModelOption[] = []
  const seen = new Set<string>()
  for (const source of sources) {
    if (source === undefined) continue
    if (!Array.isArray(source)) throw new Error('VelarOS 托管模型目录格式无效。')
    for (const value of source) {
      if (!isRecord(value)) throw new Error('VelarOS 托管模型条目格式无效。')
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
      if (!status) throw new Error('VelarOS 托管模型状态无效。')
      seen.add(id)
      models.push({ id, label: label.slice(0, 256), status })
    }
  }
  return models
}

function parseManagedProviderModelList(value: unknown): ProviderModelCatalogEntry[] {
  const root = readRecord(value, 'model catalog')
  if (!Array.isArray(root['data'])) throw new Error('VelarOS 模型目录格式无效。')
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

function managedProviderLabel(providerId: WorkbenchManagedModelProviderId): string {
  return providerId === 'velar-dev' ? 'Velar Dev' : 'VelarOS'
}

function isManagedModelProviderId(value: string): value is WorkbenchManagedModelProviderId {
  return ManagedProviderIds.has(value as WorkbenchManagedModelProviderId)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label} 必须是对象。`)
  return value
}

function readNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} 必须是非空字符串。`)
  return value.trim()
}

function optionalNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}
