import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { VelarOSCloudBaseUrl } from '../updates/WorkbenchReleaseSource'

const SampleIntervalMs = 30_000
const UploadIntervalMs = 10 * 60_000
const MaximumPendingSeconds = 1_800

interface InstallationRecord {
  readonly schemaVersion: 1
  readonly installationId: string
}

export interface WorkbenchProductAnalyticsReporterOptions {
  readonly dataRoot: string
  readonly appVersion: string
  readonly isActive: () => boolean
  readonly fetchImpl?: typeof fetch
  readonly now?: () => number
}

async function readOrCreateInstallationId(dataRoot: string): Promise<string> {
  const path = join(dataRoot, 'analytics-installation.json')
  try {
    const value = JSON.parse(await readFile(path, 'utf8')) as Partial<InstallationRecord>
    if (
      value.schemaVersion === 1 &&
      typeof value.installationId === 'string' &&
      /^[0-9a-f-]{36}$/iu.test(value.installationId)
    ) return value.installationId
  } catch {
    // Missing or invalid local analytics identity is replaced with a random identifier.
  }
  const installationId = randomUUID()
  await mkdir(dirname(path), { recursive: true })
  const temporaryPath = `${path}.${process.pid}.tmp`
  await writeFile(
    temporaryPath,
    `${JSON.stringify({ schemaVersion: 1, installationId } satisfies InstallationRecord)}\n`,
    { mode: 0o600 }
  )
  await rename(temporaryPath, path)
  return installationId
}

export class WorkbenchProductAnalyticsReporter {
  readonly #installationId: string
  readonly #sessionId = randomUUID()
  readonly #appVersion: string
  readonly #isActive: () => boolean
  readonly #fetch: typeof fetch
  readonly #now: () => number
  #lastSampleAt: number
  #lastUploadAttemptAt: number
  #pendingActiveSeconds = 0
  #sampleTimer: ReturnType<typeof setInterval> | undefined
  #uploadTimer: ReturnType<typeof setInterval> | undefined
  #uploading: Promise<void> | undefined

  private constructor(
    installationId: string,
    options: WorkbenchProductAnalyticsReporterOptions
  ) {
    this.#installationId = installationId
    this.#appVersion = options.appVersion
    this.#isActive = options.isActive
    this.#fetch = options.fetchImpl ?? fetch
    this.#now = options.now ?? Date.now
    this.#lastSampleAt = this.#now()
    this.#lastUploadAttemptAt = this.#lastSampleAt
  }

  public static async create(
    options: WorkbenchProductAnalyticsReporterOptions
  ): Promise<WorkbenchProductAnalyticsReporter | undefined> {
    if (
      process.env['VELAROS_ANALYTICS_DISABLED'] === '1' ||
      process.env['DO_NOT_TRACK'] === '1'
    ) return undefined
    return new WorkbenchProductAnalyticsReporter(
      await readOrCreateInstallationId(options.dataRoot),
      options
    )
  }

  public start(): void {
    if (this.#sampleTimer || this.#uploadTimer) return
    this.#sampleTimer = setInterval(() => this.#sample(), SampleIntervalMs)
    this.#sampleTimer.unref?.()
    this.#uploadTimer = setInterval(() => void this.flush(), UploadIntervalMs)
    this.#uploadTimer.unref?.()
  }

  public flush(force = false): Promise<void> {
    if (this.#uploading) return this.#uploading
    this.#sample()
    const now = this.#now()
    if (this.#pendingActiveSeconds < 1) return Promise.resolve()
    if (!force && now - this.#lastUploadAttemptAt < UploadIntervalMs) return Promise.resolve()
    this.#lastUploadAttemptAt = now
    const activeSeconds = this.#pendingActiveSeconds
    const operation = this.#upload(now, activeSeconds)
      .then(() => {
        this.#pendingActiveSeconds = Math.max(
          0,
          this.#pendingActiveSeconds - activeSeconds
        )
      })
      .catch(() => undefined)
      .finally(() => {
        if (this.#uploading === operation) this.#uploading = undefined
      })
    this.#uploading = operation
    return operation
  }

  public async dispose(): Promise<void> {
    if (this.#sampleTimer) clearInterval(this.#sampleTimer)
    if (this.#uploadTimer) clearInterval(this.#uploadTimer)
    this.#sampleTimer = undefined
    this.#uploadTimer = undefined
    await this.flush(true)
  }

  #sample(): void {
    const now = this.#now()
    const elapsedSeconds = Math.floor(Math.min(60, Math.max(0, now - this.#lastSampleAt) / 1_000))
    this.#lastSampleAt = now
    if (!this.#isActive() || elapsedSeconds < 1) return
    this.#pendingActiveSeconds = Math.min(
      MaximumPendingSeconds,
      this.#pendingActiveSeconds + elapsedSeconds
    )
  }

  async #upload(occurredAt: number, activeSeconds: number): Promise<void> {
    const response = await this.#fetch(`${VelarOSCloudBaseUrl}/v1/analytics/activity`, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        eventId: randomUUID(),
        sessionId: this.#sessionId,
        installationId: this.#installationId,
        product: 'workbench',
        occurredAt: new Date(occurredAt).toISOString(),
        activeSeconds,
        appVersion: this.#appVersion,
        platform:
          process.platform === 'darwin' || process.platform === 'win32' || process.platform === 'linux'
            ? process.platform
            : 'other',
        arch: process.arch,
      }),
      signal: AbortSignal.timeout(15_000),
    })
    if (!response.ok) throw new Error(`Analytics returned HTTP ${response.status}.`)
  }
}
