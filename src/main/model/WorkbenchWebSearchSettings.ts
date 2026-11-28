import { z } from 'zod'

import { webOperations, type WebSearchApiConnection } from '@velaros-ai/capabilities/web'
import { AppError } from '@velaros-ai/velaros/core/error'
import { fetchWithTimeout } from '@velaros-ai/velaros/core/utils/fetchWithTimeout'

import type { WorkbenchWebSearchSettings } from '../../shared/workbenchSettingsWindow'
import { workbenchMainText } from '../i18n/workbenchMainMessages'

import type { WorkbenchModelCredentialStore } from './WorkbenchModelCredentialStore'

const TavilyUsage = z.object({ key: z.object({ usage: z.number() }) })
const SearchSettingsKey = 'web-search-settings'
const Provider = z.enum(['browser', 'tavily', 'custom'])
const ApiKey = z
  .string()
  .trim()
  .max(512)
  .regex(/^[\x21-\x7e]*$/u)
const Custom = z.object({
  endpoint: z
    .string()
    .trim()
    .max(2048)
    .transform((value, ctx) => {
      const url = URL.parse(value)
      if (
        url &&
        ['http:', 'https:'].includes(url.protocol) &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash
      )
        return url.href
      ctx.addIssue({ code: 'custom', message: 'Invalid search endpoint' })
      return z.NEVER
    }),
  apiKey: ApiKey,
})
const Stored = z.object({ provider: Provider, tavilyApiKey: ApiKey, custom: Custom.nullable() })
const Update = z.union([
  z.object({ action: z.literal('select'), provider: Provider }),
  z.object({ action: z.literal('remove'), provider: z.enum(['tavily', 'custom']) }),
  z.object({ action: z.literal('save'), provider: z.literal('tavily'), apiKey: ApiKey }),
  Custom.extend({ action: z.literal('save'), provider: z.literal('custom') }),
])
type StoredSettings = z.infer<typeof Stored>

/** 验证后保存连接，设置界面只读取脱敏后的回执。 */
export class WorkbenchWebSearchSettingsService {
  private pendingUpdate: Promise<unknown> = Promise.resolve()

  public constructor(
    private readonly credentials: Pick<WorkbenchModelCredentialStore, 'getApiKey' | 'setApiKey'>,
    private readonly fetcher: typeof fetch
  ) {}

  private async read(): Promise<StoredSettings> {
    const saved = await this.credentials.getApiKey(SearchSettingsKey)
    if (saved) return Stored.parse(JSON.parse(saved))
    const tavilyApiKey = await this.credentials.getApiKey('tavily')
    return { provider: tavilyApiKey ? 'tavily' : 'browser', tavilyApiKey, custom: null }
  }

  public async getSettings(): Promise<WorkbenchWebSearchSettings> {
    return this.receipt(await this.read())
  }

  public async getApiConnection(): Promise<Nullable<WebSearchApiConnection>> {
    const { provider, custom, tavilyApiKey } = await this.read()
    if (provider === 'tavily' && tavilyApiKey) return { provider, apiKey: tavilyApiKey }
    if (provider === 'custom' && custom)
      return { provider, endpoint: custom.endpoint, apiKey: custom.apiKey }
    return null
  }

  public update(input: unknown): Promise<WorkbenchWebSearchSettings> {
    const result = this.pendingUpdate.catch(() => undefined).then(() => this.applyUpdate(input))
    this.pendingUpdate = result
    return result
  }

  private async applyUpdate(input: unknown): Promise<WorkbenchWebSearchSettings> {
    const parsed = Update.safeParse(input)
    if (!parsed.success)
      throw new AppError('VALIDATION', workbenchMainText('search.invalidSettings'))
    const update = parsed.data
    const settings = await this.read()
    if (update.action === 'remove') {
      if (update.provider === 'tavily') settings.tavilyApiKey = ''
      else settings.custom = null
      if (settings.provider === update.provider) settings.provider = 'browser'
    } else {
      if (update.action === 'save') {
        if (update.provider === 'tavily') {
          if (!update.apiKey)
            throw new AppError('VALIDATION', workbenchMainText('search.missingKey'))
          await this.verifyTavily(update.apiKey)
          settings.tavilyApiKey = update.apiKey
        } else {
          const { endpoint } = update
          const previous = settings.custom
          const apiKey = update.apiKey || (previous?.endpoint === endpoint ? previous.apiKey : '')
          if (!apiKey) throw new AppError('VALIDATION', workbenchMainText('search.missingKey'))
          await this.verifyCustom({ provider: 'custom', endpoint, apiKey })
          settings.custom = { endpoint, apiKey }
        }
      }
      if (
        (update.provider === 'tavily' && !settings.tavilyApiKey) ||
        (update.provider === 'custom' && !settings.custom)
      )
        throw new AppError('VALIDATION', workbenchMainText('search.missingKey'))
      settings.provider = update.provider
    }
    await this.credentials.setApiKey(SearchSettingsKey, JSON.stringify(settings))
    return this.receipt(settings)
  }

  private receipt({ provider, custom, tavilyApiKey }: StoredSettings): WorkbenchWebSearchSettings {
    return {
      provider,
      tavilyConfigured: !!tavilyApiKey,
      custom: custom && { endpoint: custom.endpoint },
    }
  }

  private async verifyCustom(
    connection: Extract<WebSearchApiConnection, { provider: 'custom' }>
  ): Promise<void> {
    try {
      await webOperations.search(
        { query: 'VelarOS', limit: 1 },
        {
          abortSignal: AbortSignal.timeout(10_000),
          web: {
            searchApi: () => connection,
            fetchSearchApi: this.fetcher,
            searchEngine: () => 'google',
            openPage: () =>
              Promise.reject(new Error('Browser search is unavailable during API verification')),
          },
        }
      )
    } catch {
      throw new AppError('NETWORK', workbenchMainText('search.customVerificationFailed'))
    }
  }

  private async verifyTavily(apiKey: string): Promise<void> {
    const result = await fetchWithTimeout(
      'https://api.tavily.com/usage',
      {
        headers: { Authorization: `Bearer ${apiKey}` },
        cache: 'no-store',
        credentials: 'omit',
        redirect: 'error',
      },
      async (response) => {
        if (response.ok)
          return TavilyUsage.safeParse(await response.json()).success ? 'valid' : 'unavailable'
        await response.body?.cancel()
        return response.status === 401 ? 'invalid' : 'unavailable'
      },
      { timeoutMs: 10_000, fetch: this.fetcher }
    ).catch(() => 'unavailable' as const)

    if (result === 'invalid')
      throw new AppError('AUTH', workbenchMainText('search.tavilyInvalidKey'))
    if (result !== 'valid')
      throw new AppError('NETWORK', workbenchMainText('search.tavilyVerificationUnavailable'))
  }
}
