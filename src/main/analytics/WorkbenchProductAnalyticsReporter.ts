import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { VelarOSCloudBaseUrl } from '../updates/WorkbenchReleaseSource'

const SampleIntervalMs = 30_000
const UploadIntervalMs = 10 * 60_000
const MaximumPendingSeconds = 1_800
const FirstReportThresholdSeconds = 1_800

interface InstallationRecord {
  readonly schemaVersion: 1
  readonly installationId: string
}

type CounterName =
  | 'runs.started'
  | 'runs.completed'
  | 'runs.failed'
  | 'runs.aborted'
  | 'agent.turns'
  | 'agent.retries'
  | 'permissions.prompted'
  | 'files.read'
  | 'files.created'
  | 'files.updated'
  | 'files.deleted'
  | 'features.browser'
  | 'features.terminal'
  | 'features.mcp'
  | 'errors'

interface WorkbenchModelMetrics {
  provider: string
  model: string
  calls: number
  failures: number
  inputTokens: number
  outputTokens: number
}

interface WorkbenchWorkspaceMetrics {
  activeSeconds: number
  conversationCount: number
  toolCallCount: number
}

interface WorkbenchMetrics {
  conversationCount: number
  toolCallCount: number
  toolSuccessCount: number
  toolFailureCount: number
  inputTokens: number
  outputTokens: number
  peakContextWindowPercent: number
  models: Map<string, WorkbenchModelMetrics>
  workspaces: Map<string, WorkbenchWorkspaceMetrics>
  counters: Map<CounterName, number>
  runDurationCount: number
  runDurationTotal: number
  runDurationMaximum: number
}

export interface WorkbenchProductAnalyticsReporterOptions {
  readonly dataRoot: string
  readonly appVersion: string
  readonly isActive: () => boolean
  readonly fetchImpl?: typeof fetch
  readonly now?: () => number
  readonly enabled?: boolean
}

async function readOrCreateInstallationId(dataRoot: string): Promise<string> {
  const path = join(dataRoot, 'analytics-installation.json')
  try {
    const value = JSON.parse(await readFile(path, 'utf8')) as Partial<InstallationRecord>
    if (
      value.schemaVersion === 1 &&
      typeof value.installationId === 'string' &&
      /^[0-9a-f-]{36}$/iu.test(value.installationId)
    )
      return value.installationId
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
  #enabled: boolean
  #noticeResolved = false
  #reportingAllowed = false
  #onNoticeRequired: () => void = () => undefined
  #metrics = emptyMetrics()
  #currentWorkspace: string | null = null
  readonly #knownSessions = new Set<string>()
  readonly #runStartedAt = new Map<string, number>()

  private constructor(installationId: string, options: WorkbenchProductAnalyticsReporterOptions) {
    this.#installationId = installationId
    this.#appVersion = options.appVersion
    this.#isActive = options.isActive
    this.#fetch = options.fetchImpl ?? fetch
    this.#now = options.now ?? Date.now
    this.#enabled = options.enabled ?? true
    this.#lastSampleAt = this.#now()
    this.#lastUploadAttemptAt = this.#lastSampleAt
  }

  public static async create(
    options: WorkbenchProductAnalyticsReporterOptions
  ): Promise<WorkbenchProductAnalyticsReporter | undefined> {
    if (process.env['VELAROS_ANALYTICS_DISABLED'] === '1' || process.env['DO_NOT_TRACK'] === '1')
      return undefined
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

  public setEnabled(enabled: boolean): void {
    this.#enabled = enabled
    this.#lastSampleAt = this.#now()
    if (!enabled) {
      this.#pendingActiveSeconds = 0
      this.#metrics = emptyMetrics()
      this.#runStartedAt.clear()
    }
  }

  public setConsentState(input: {
    readonly noticeResolved: boolean
    readonly reportingAllowed: boolean
    readonly onNoticeRequired: () => void
  }): void {
    this.#noticeResolved = input.noticeResolved
    this.#reportingAllowed = input.reportingAllowed
    this.#onNoticeRequired = input.onNoticeRequired
  }

  public async recordConsentDecision(
    decision: 'allowed' | 'declined',
    signal?: AbortSignal
  ): Promise<void> {
    const timeout = AbortSignal.timeout(15_000)
    const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout
    requestSignal.throwIfAborted()
    const response = await this.#fetch(`${VelarOSCloudBaseUrl}/v1/analytics/consent`, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        eventId: randomUUID(),
        installationId: this.#installationId,
        product: 'workbench',
        decision,
        noticeVersion: 1,
        occurredAt: new Date(this.#now()).toISOString(),
      }),
      signal: requestSignal,
    })
    requestSignal.throwIfAborted()
    if (!response.ok) throw new Error(`Consent analytics returned HTTP ${response.status}.`)
  }

  public recordRunStarted(input: {
    readonly executionId: string
    readonly sessionId: string
    readonly projectRoot: string | null
    readonly modelSelection: unknown
  }): void {
    if (!this.#enabled) return
    if (input.projectRoot?.trim()) this.#currentWorkspace = input.projectRoot.trim()
    if (!this.#knownSessions.has(input.sessionId)) {
      this.#knownSessions.add(input.sessionId)
      this.#metrics.conversationCount += 1
      this.#recordWorkspace(input.projectRoot, { conversationCount: 1 })
    }
    this.#bumpCounter('runs.started')
    this.#runStartedAt.set(input.executionId, this.#now())
    const selection = asRecord(input.modelSelection)
    const provider = safeDimension(selection['provider'])
    const model = safeDimension(selection['model'])
    const key = `${provider}\0${model}`
    if (!this.#metrics.models.has(key)) {
      this.#metrics.models.set(key, {
        provider,
        model,
        calls: 0,
        failures: 0,
        inputTokens: 0,
        outputTokens: 0,
      })
    }
  }

  public recordAgentEvent(event: unknown, projectRoot: string | null): void {
    if (!this.#enabled) return
    const value = asRecord(event)
    if (value['type'] === 'tool-start') {
      this.#metrics.toolCallCount += 1
      this.#recordWorkspace(projectRoot, { toolCallCount: 1 })
      const toolName = typeof value['toolName'] === 'string' ? value['toolName'].toLowerCase() : ''
      if (toolName.includes('browser')) this.#bumpCounter('features.browser')
      if (toolName.includes('terminal') || toolName.includes('command')) {
        this.#bumpCounter('features.terminal')
      }
      if (toolName.includes('mcp')) this.#bumpCounter('features.mcp')
      for (const counter of fileOperationCounters(toolName)) this.#bumpCounter(counter)
      return
    }
    if (value['type'] === 'tool-done') {
      if (typeof value['error'] === 'string' && value['error'].trim()) {
        this.#metrics.toolFailureCount += 1
        this.#bumpCounter('errors')
      } else {
        this.#metrics.toolSuccessCount += 1
      }
      return
    }
    if (value['type'] !== 'runtime') return
    const payload = asRecord(value['payload'])
    if (payload['kind'] === 'turn-start') this.#bumpCounter('agent.turns')
    if (payload['kind'] === 'retrying-turn') this.#bumpCounter('agent.retries')
    if (payload['kind'] === 'awaiting-confirmation') this.#bumpCounter('permissions.prompted')
    if (payload['kind'] === 'context-usage-estimate') {
      this.#metrics.peakContextWindowPercent = Math.max(
        this.#metrics.peakContextWindowPercent,
        Math.min(100, nonNegativeInteger(payload['percent']))
      )
    }
    if (payload['kind'] !== 'usage-telemetry') return
    const provider = safeDimension(payload['provider'])
    const model = safeDimension(payload['model'])
    const inputTokens = nonNegativeInteger(payload['inputTokens'])
    const outputTokens = nonNegativeInteger(payload['outputTokens'])
    const finishReasons = Array.isArray(payload['finishReasons']) ? payload['finishReasons'] : []
    const failed = finishReasons.some(
      (reason) => typeof reason === 'string' && /error|fail/iu.test(reason)
    )
    const key = `${provider}\0${model}`
    const current = this.#metrics.models.get(key) ?? {
      provider,
      model,
      calls: 0,
      failures: 0,
      inputTokens: 0,
      outputTokens: 0,
    }
    current.calls += 1
    current.failures += failed ? 1 : 0
    current.inputTokens += inputTokens
    current.outputTokens += outputTokens
    this.#metrics.models.set(key, current)
    this.#metrics.inputTokens += inputTokens
    this.#metrics.outputTokens += outputTokens
  }

  public recordRunFinished(executionId: string, status: 'completed' | 'aborted' | 'error'): void {
    if (!this.#enabled) return
    this.#bumpCounter(
      status === 'completed'
        ? 'runs.completed'
        : status === 'aborted'
          ? 'runs.aborted'
          : 'runs.failed'
    )
    if (status === 'error') this.#bumpCounter('errors')
    const startedAt = this.#runStartedAt.get(executionId)
    this.#runStartedAt.delete(executionId)
    if (startedAt === undefined) return
    const duration = Math.max(0, Math.round(this.#now() - startedAt))
    this.#metrics.runDurationCount += 1
    this.#metrics.runDurationTotal += duration
    this.#metrics.runDurationMaximum = Math.max(this.#metrics.runDurationMaximum, duration)
  }

  public flush(force = false): Promise<void> {
    if (this.#uploading) return this.#uploading
    this.#sample()
    if (!this.#enabled) return Promise.resolve()
    const now = this.#now()
    if (this.#pendingActiveSeconds < 1) return Promise.resolve()
    if (!this.#noticeResolved) {
      if (this.#pendingActiveSeconds >= FirstReportThresholdSeconds) this.#onNoticeRequired()
      return Promise.resolve()
    }
    if (!this.#reportingAllowed) return Promise.resolve()
    if (!force && now - this.#lastUploadAttemptAt < UploadIntervalMs) return Promise.resolve()
    this.#lastUploadAttemptAt = now
    const activeSeconds = this.#pendingActiveSeconds
    const pendingMetrics = this.#metrics
    const metrics = cloneMetrics(pendingMetrics)
    const operation = this.#upload(now, activeSeconds, metrics)
      .then(() => {
        if (this.#metrics !== pendingMetrics) return
        this.#pendingActiveSeconds = Math.max(0, this.#pendingActiveSeconds - activeSeconds)
        subtractMetrics(pendingMetrics, metrics)
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
    if (!this.#enabled) {
      this.#pendingActiveSeconds = 0
      return
    }
    if (!this.#isActive() || elapsedSeconds < 1) return
    const acceptedSeconds = Math.min(
      elapsedSeconds,
      MaximumPendingSeconds - this.#pendingActiveSeconds
    )
    this.#pendingActiveSeconds += acceptedSeconds
    this.#recordWorkspace(this.#currentWorkspace, {
      activeSeconds: acceptedSeconds,
    })
  }

  async #upload(
    occurredAt: number,
    activeSeconds: number,
    metrics: WorkbenchMetrics
  ): Promise<void> {
    let remainingWorkspaceSeconds = activeSeconds
    const workspaces = [...metrics.workspaces.entries()].slice(0, 32).map(([path, value]) => {
      const workspaceSeconds = Math.min(value.activeSeconds, remainingWorkspaceSeconds)
      remainingWorkspaceSeconds -= workspaceSeconds
      return {
        workspaceId: createHash('sha256').update(`${this.#installationId}\0${path}`).digest('hex'),
        ...value,
        activeSeconds: workspaceSeconds,
      }
    })
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
          process.platform === 'darwin' ||
          process.platform === 'win32' ||
          process.platform === 'linux'
            ? process.platform
            : 'other',
        arch: process.arch,
        conversationCount: metrics.conversationCount,
        toolCallCount: metrics.toolCallCount,
        toolSuccessCount: metrics.toolSuccessCount,
        toolFailureCount: metrics.toolFailureCount,
        inputTokens: metrics.inputTokens,
        outputTokens: metrics.outputTokens,
        peakContextWindowPercent: metrics.peakContextWindowPercent,
        workspaces,
        models: [...metrics.models.values()].filter((model) => model.calls > 0).slice(0, 32),
        counters: [...metrics.counters].slice(0, 32).map(([name, count]) => ({ name, count })),
        measurements:
          metrics.runDurationCount > 0
            ? [
                {
                  name: 'run.ms',
                  count: metrics.runDurationCount,
                  total: metrics.runDurationTotal,
                  maximum: metrics.runDurationMaximum,
                },
              ]
            : [],
      }),
      signal: AbortSignal.timeout(15_000),
    })
    if (!response.ok) throw new Error(`Analytics returned HTTP ${response.status}.`)
  }

  #bumpCounter(name: CounterName): void {
    this.#metrics.counters.set(name, (this.#metrics.counters.get(name) ?? 0) + 1)
  }

  #recordWorkspace(projectRoot: string | null, patch: Partial<WorkbenchWorkspaceMetrics>): void {
    const normalized = projectRoot?.trim()
    if (!normalized) return
    const current = this.#metrics.workspaces.get(normalized) ?? {
      activeSeconds: 0,
      conversationCount: 0,
      toolCallCount: 0,
    }
    current.activeSeconds += patch.activeSeconds ?? 0
    current.conversationCount += patch.conversationCount ?? 0
    current.toolCallCount += patch.toolCallCount ?? 0
    this.#metrics.workspaces.set(normalized, current)
  }
}

function emptyMetrics(): WorkbenchMetrics {
  return {
    conversationCount: 0,
    toolCallCount: 0,
    toolSuccessCount: 0,
    toolFailureCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    peakContextWindowPercent: 0,
    models: new Map(),
    workspaces: new Map(),
    counters: new Map(),
    runDurationCount: 0,
    runDurationTotal: 0,
    runDurationMaximum: 0,
  }
}

function cloneMetrics(value: WorkbenchMetrics): WorkbenchMetrics {
  return {
    ...value,
    models: new Map([...value.models].map(([key, item]) => [key, { ...item }])),
    workspaces: new Map([...value.workspaces].map(([key, item]) => [key, { ...item }])),
    counters: new Map(value.counters),
  }
}

function subtractMetrics(target: WorkbenchMetrics, captured: WorkbenchMetrics): void {
  target.conversationCount = subtract(target.conversationCount, captured.conversationCount)
  target.toolCallCount = subtract(target.toolCallCount, captured.toolCallCount)
  target.toolSuccessCount = subtract(target.toolSuccessCount, captured.toolSuccessCount)
  target.toolFailureCount = subtract(target.toolFailureCount, captured.toolFailureCount)
  target.inputTokens = subtract(target.inputTokens, captured.inputTokens)
  target.outputTokens = subtract(target.outputTokens, captured.outputTokens)
  if (target.peakContextWindowPercent <= captured.peakContextWindowPercent) {
    target.peakContextWindowPercent = 0
  }
  for (const [key, value] of captured.models) {
    const current = target.models.get(key)
    if (!current) continue
    current.calls = subtract(current.calls, value.calls)
    current.failures = subtract(current.failures, value.failures)
    current.inputTokens = subtract(current.inputTokens, value.inputTokens)
    current.outputTokens = subtract(current.outputTokens, value.outputTokens)
    if (current.calls + current.inputTokens + current.outputTokens === 0) target.models.delete(key)
  }
  for (const [key, value] of captured.workspaces) {
    const current = target.workspaces.get(key)
    if (!current) continue
    current.activeSeconds = subtract(current.activeSeconds, value.activeSeconds)
    current.conversationCount = subtract(current.conversationCount, value.conversationCount)
    current.toolCallCount = subtract(current.toolCallCount, value.toolCallCount)
    if (current.activeSeconds + current.conversationCount + current.toolCallCount === 0) {
      target.workspaces.delete(key)
    }
  }
  for (const [name, value] of captured.counters) {
    const remaining = subtract(target.counters.get(name) ?? 0, value)
    if (remaining > 0) target.counters.set(name, remaining)
    else target.counters.delete(name)
  }
  target.runDurationCount = subtract(target.runDurationCount, captured.runDurationCount)
  target.runDurationTotal = subtract(target.runDurationTotal, captured.runDurationTotal)
  if (target.runDurationMaximum <= captured.runDurationMaximum) target.runDurationMaximum = 0
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function safeDimension(value: unknown): string {
  if (typeof value !== 'string') return 'unknown'
  return (
    value
      .trim()
      .replace(/[^A-Za-z0-9._:/+-]+/gu, '-')
      .slice(0, 120) || 'unknown'
  )
}

function nonNegativeInteger(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0
}

function fileOperationCounters(toolName: string): CounterName[] {
  const counters: CounterName[] = []
  if (/(read|open|view).*(file|project)|(file|project).*(read|open|view)/u.test(toolName)) {
    counters.push('files.read')
  }
  if (/create.*(file|directory)|(file|directory).*create/u.test(toolName)) {
    counters.push('files.created')
  }
  if (/(write|edit|patch|replace).*(file|project)|(file|project).*(write|edit|patch|replace)/u.test(toolName)) {
    counters.push('files.updated')
  }
  if (/(delete|remove).*(file|directory)|(file|directory).*(delete|remove)/u.test(toolName)) {
    counters.push('files.deleted')
  }
  return counters
}

function subtract(current: number, captured: number): number {
  return Math.max(0, current - captured)
}
