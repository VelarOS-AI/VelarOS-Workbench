import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

interface WorkbenchProductAnalyticsPreferencesFile {
  readonly version: 1
  readonly enabled: boolean
  readonly noticeRequired: boolean
  readonly noticeResolved: boolean
  readonly consentDecision: 'unresolved' | 'allowed' | 'declined'
  readonly consentReceiptRecorded: boolean
}

export type WorkbenchProductAnalyticsPreferences = Omit<
  WorkbenchProductAnalyticsPreferencesFile,
  'version'
>

const DefaultPreferences: WorkbenchProductAnalyticsPreferences = {
  enabled: true,
  noticeRequired: false,
  noticeResolved: false,
  consentDecision: 'unresolved',
  consentReceiptRecorded: false,
}

export class WorkbenchProductAnalyticsPreferencesStore {
  readonly #filePath: string
  #preferences: WorkbenchProductAnalyticsPreferences

  public constructor(dataRootDir: string) {
    this.#filePath = join(dataRootDir, 'storage', 'product-analytics-preferences.json')
    this.#preferences = readPreferences(this.#filePath)
  }

  public get enabled(): boolean {
    return this.#preferences.enabled
  }

  public get value(): WorkbenchProductAnalyticsPreferences {
    return this.#preferences
  }

  public setEnabled(enabled: boolean): void {
    this.update({
      enabled,
      ...(this.#preferences.noticeResolved
        ? ({
            consentDecision: enabled ? 'allowed' : 'declined',
            consentReceiptRecorded: false,
          } as const)
        : {}),
    })
  }

  public requireNotice(): void {
    if (!this.#preferences.enabled || this.#preferences.noticeResolved) return
    this.update({ noticeRequired: true })
  }

  public resolveNotice(decision: 'allowed' | 'declined'): void {
    this.update({
      enabled: decision === 'allowed',
      noticeRequired: false,
      noticeResolved: true,
      consentDecision: decision,
      consentReceiptRecorded: false,
    })
  }

  public markConsentReceiptRecorded(): void {
    this.update({ consentReceiptRecorded: true })
  }

  private update(patch: Partial<WorkbenchProductAnalyticsPreferences>): void {
    const next = { ...this.#preferences, ...patch }
    if (JSON.stringify(next) === JSON.stringify(this.#preferences)) return
    this.#preferences = next
    const file: WorkbenchProductAnalyticsPreferencesFile = {
      version: 1,
      ...next,
    }
    mkdirSync(dirname(this.#filePath), { recursive: true })
    const temporaryPath = `${this.#filePath}.tmp`
    writeFileSync(temporaryPath, `${JSON.stringify(file, null, 2)}\n`, 'utf8')
    renameSync(temporaryPath, this.#filePath)
  }
}

function readPreferences(filePath: string): WorkbenchProductAnalyticsPreferences {
  try {
    const parsed = JSON.parse(
      readFileSync(filePath, 'utf8')
    ) as Partial<WorkbenchProductAnalyticsPreferencesFile>
    if (parsed.version !== 1) return DefaultPreferences
    return {
      enabled: typeof parsed.enabled === 'boolean' ? parsed.enabled : true,
      noticeRequired: typeof parsed.noticeRequired === 'boolean' ? parsed.noticeRequired : false,
      noticeResolved: typeof parsed.noticeResolved === 'boolean' ? parsed.noticeResolved : false,
      consentDecision:
        parsed.consentDecision === 'allowed' || parsed.consentDecision === 'declined'
          ? parsed.consentDecision
          : 'unresolved',
      consentReceiptRecorded:
        typeof parsed.consentReceiptRecorded === 'boolean' ? parsed.consentReceiptRecorded : false,
    }
  } catch {
    return DefaultPreferences
  }
}
