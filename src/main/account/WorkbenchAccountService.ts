import os from 'node:os'

import type { WorkbenchAccountState } from '../../shared/workbenchAccount'

import type { WorkbenchCloudSession } from './WorkbenchSharedAccountStore'
import { type WorkbenchSharedAccountStore } from './WorkbenchSharedAccountStore'

const DefaultCloudBaseUrl = 'https://8.152.209.233/api'
const DeviceIdHeader = 'X-VelarOS-Device-Id'
const GoogleSignInTimeoutMs = 3 * 60_000

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
}
