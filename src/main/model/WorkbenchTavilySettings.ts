import { z } from 'zod'

import { AppError } from '@velaros-ai/velaros/core/error'
import { fetchWithTimeout } from '@velaros-ai/velaros/core/utils/fetchWithTimeout'

import { workbenchMainText } from '../i18n/workbenchMainMessages'

import type { WorkbenchModelCredentialStore } from './WorkbenchModelCredentialStore'

const TavilyUsage = z.object({ key: z.object({ usage: z.number() }) })

/** 验证新密钥后才替换已保存的密钥。 */
export class WorkbenchTavilySettings {
  private latestWrite?: symbol

  public constructor(
    private readonly credentials: Pick<WorkbenchModelCredentialStore, 'getApiKey' | 'setApiKey'>,
    private readonly fetcher: typeof fetch
  ) {}

  public getApiKey(): Promise<string> {
    return this.credentials.getApiKey('tavily')
  }

  public async setApiKey(apiKey: string): Promise<boolean> {
    const write = (this.latestWrite = Symbol())
    if (apiKey) await this.verify(apiKey)
    if (write !== this.latestWrite)
      throw new AppError('CONFLICT', workbenchMainText('search.tavilySettingsChanged'))
    await this.credentials.setApiKey('tavily', apiKey)
    return Boolean(apiKey)
  }

  private async verify(apiKey: string): Promise<void> {
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
