import { CancellationError, CancellationToken } from 'builder-util-runtime'
import type { AppUpdater, ProgressInfo, UpdateDownloadedEvent, UpdateInfo } from 'electron-updater'

import { Log } from '@velaros-ai/velaros/core'
import { AppError } from '@velaros-ai/velaros/core/error'
import { TimerScope } from '@velaros-ai/velaros/core/utils/TimerScope'

import type { WorkbenchUpdateChannel, WorkbenchUpdateState } from '../../shared/workbenchUpdate'

import { WorkbenchReleaseFeedServer } from './WorkbenchReleaseFeedServer'
import type {
  ResolvedWorkbenchReleaseCatalog,
  WorkbenchReleaseArtifact,
  WorkbenchReleaseSource,
} from './WorkbenchReleaseSource'
import { validateWorkbenchReleaseCatalog } from './WorkbenchReleaseSource'
import type { WorkbenchUpdateDownloadCache } from './WorkbenchUpdateDownloadCache'
import type { WorkbenchUpdatePreferencesStore } from './WorkbenchUpdatePreferencesStore'

interface WorkbenchUpdateServiceOptions {
  readonly currentVersion: string
  readonly isPackaged: boolean
  readonly platform?: NodeJS.Platform
  readonly arch?: string
  readonly downloadCache?: WorkbenchUpdateDownloadCache
}

interface WorkbenchUpdateInstaller extends AppUpdater {
  cancelPreparedUpdate?(): Promise<void>
}

type WorkbenchUpdateListener = (state: WorkbenchUpdateState) => void

const DownloadRetryLimit = 3
const DownloadRetryDelayMs = 1000

function expectedFiles(platform: NodeJS.Platform): Nullable<{
  readonly metadata: string
  readonly packageFormat: string
}> {
  if (platform === 'darwin') return { metadata: 'latest-mac.yml', packageFormat: 'zip' }
  if (platform === 'win32') return { metadata: 'latest.yml', packageFormat: 'exe' }
  if (platform === 'linux') return { metadata: 'latest-linux.yml', packageFormat: 'appimage' }
  return null
}

export class WorkbenchUpdateService {
  readonly #log = Log.tag('WorkbenchUpdate')
  readonly #listeners = new Set<WorkbenchUpdateListener>()
  readonly #currentVersion: string
  readonly #isPackaged: boolean
  readonly #platform: NodeJS.Platform
  readonly #arch: string
  #state: WorkbenchUpdateState
  #feed: Nullable<WorkbenchReleaseFeedServer> = null
  #checkPromise: Nullable<Promise<WorkbenchUpdateState>> = null
  #downloadPromise: Nullable<Promise<WorkbenchUpdateState>> = null
  #downloadCancellation: Nullable<CancellationToken> = null
  #downloadController: Nullable<AbortController> = null
  #release: Nullable<ResolvedWorkbenchReleaseCatalog> = null
  #selectedArtifact: Nullable<WorkbenchReleaseArtifact> = null
  readonly #cached = new Map<string, string>()
  #installingCached = false
  #updater: WorkbenchUpdateInstaller | null = null
  #updaterPromise: Promise<AppUpdater> | null = null
  #disposed = false

  public constructor(
    private readonly releases: WorkbenchReleaseSource,
    private readonly updaterSource: AppUpdater | (() => Promise<AppUpdater>),
    private readonly preferences: WorkbenchUpdatePreferencesStore,
    private readonly options: WorkbenchUpdateServiceOptions
  ) {
    this.#currentVersion = options.currentVersion
    this.#isPackaged = options.isPackaged
    this.#platform = options.platform ?? process.platform
    this.#arch = options.arch ?? process.arch
    this.#state = {
      revision: 0,
      phase: 'idle',
      currentVersion: this.#currentVersion,
      channel: preferences.channel,
      automaticDownloads: preferences.automaticDownloads,
    }

    if (typeof updaterSource !== 'function') this.#configureUpdater(updaterSource)
  }

  #configureUpdater(updater: AppUpdater): void {
    this.#updater = updater
    updater.autoDownload = false
    updater.allowPrerelease = this.preferences.channel !== 'stable'
    updater.autoInstallOnAppQuit = true
    updater.autoRunAppAfterInstall = true
    updater.disableDifferentialDownload = true
    updater.logger = {
      info: (message) => this.#log.info(String(message)),
      warn: (message) => this.#log.warn(String(message)),
      error: (message) => this.#log.error(String(message)),
      debug: (message) => this.#log.debug(String(message)),
    }
    updater.on('update-available', this.#handleAvailable)
    updater.on('update-not-available', this.#handleNotAvailable)
    updater.on('download-progress', this.#handleProgress)
    updater.on('update-downloaded', this.#handleDownloaded)
    updater.on('update-cancelled', this.#handleCancelled)
    updater.on('error', this.#handleError)
  }

  private get updater(): WorkbenchUpdateInstaller {
    if (!this.#updater) throw new Error('Workbench update installer is not initialized.')
    return this.#updater
  }

  #loadUpdater(): Promise<AppUpdater> {
    if (this.#disposed) return Promise.reject(new Error('Workbench update service is disposed.'))
    if (this.#updater) return Promise.resolve(this.#updater)
    if (!this.#updaterPromise) {
      const pending = Promise.resolve()
        .then(() =>
          typeof this.updaterSource === 'function' ? this.updaterSource() : this.updaterSource
        )
        .then((updater) => {
          if (this.#disposed)
            throw new Error('Workbench update service was disposed while loading its installer.')
          this.#configureUpdater(updater)
          return updater
        })
        .finally(() => {
          if (this.#updaterPromise === pending) this.#updaterPromise = null
        })
      this.#updaterPromise = pending
    }
    return this.#updaterPromise
  }

  public getState(): WorkbenchUpdateState {
    return { ...this.#state }
  }

  public subscribe(listener: WorkbenchUpdateListener): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  public start(): void {
    if (!this.#isPackaged || !expectedFiles(this.#platform)) return
    void this.checkForUpdates().catch((error) => {
      this.#log.caught('startup update check failed', error)
    })
  }

  public checkForUpdates(): Promise<WorkbenchUpdateState> {
    if (
      this.#downloadPromise ||
      this.#state.phase === 'downloading' ||
      this.#state.phase === 'paused' ||
      this.#state.phase === 'downloaded'
    )
      return Promise.resolve(this.getState())
    if (this.#checkPromise) return this.#checkPromise
    const operation = this.#performCheck().finally(() => {
      if (this.#checkPromise === operation) this.#checkPromise = null
    })
    this.#checkPromise = operation
    return operation
  }

  public downloadUpdate(): Promise<WorkbenchUpdateState> {
    if (this.#disposed) return Promise.reject(new Error('Workbench update service is disposed.'))
    if (this.#downloadPromise) return this.#downloadPromise
    if (
      this.#state.phase !== 'available' &&
      this.#state.phase !== 'error' &&
      this.#state.phase !== 'paused'
    )
      return Promise.resolve(this.getState())
    if (!this.#state.targetVersion) throw new Error('No Workbench update is available.')

    const targetVersion = this.#state.targetVersion
    const cancellation = new CancellationToken()
    const controller = new AbortController()
    this.#downloadCancellation = cancellation
    this.#downloadController = controller
    this.#installingCached = false
    // 先登记任务再通知状态，订阅者重入时共享同一次下载。
    const operation = Promise.resolve()
      .then(async () => {
        controller.signal.throwIfAborted()
        this.#setState({
          ...this.#downloadSnapshot(),
          phase: 'downloading',
          targetVersion,
          percent: this.#state.percent ?? 0,
          transferredBytes: this.#state.transferredBytes ?? 0,
        })
        if (this.options.downloadCache) {
          if (!this.#selectedArtifact || !this.#release)
            throw new Error('Update metadata does not select an admitted package.')
          await this.#cacheArtifactWithRetries(this.#selectedArtifact, controller.signal)
          this.#installingCached = true
          this.#setState({ ...this.#downloadSnapshot(), phase: 'preparing', bytesPerSecond: 0 })
        }
        controller.signal.throwIfAborted()
        await this.updater.downloadUpdate(cancellation)
        return this.getState()
      })
      .catch((error) => {
        if (
          controller.signal.aborted ||
          error instanceof CancellationError ||
          cancellation.cancelled
        )
          return this.getState()
        this.#setError(error, targetVersion)
        throw error
      })
      .finally(() => {
        if (this.#downloadPromise === operation) this.#downloadPromise = null
        if (this.#downloadCancellation === cancellation) this.#downloadCancellation = null
      })
    this.#downloadPromise = operation
    return operation
  }

  async #cacheArtifactWithRetries(
    artifact: WorkbenchReleaseArtifact,
    signal: AbortSignal
  ): Promise<void> {
    for (let attempt = 0; ; attempt += 1) {
      signal.throwIfAborted()
      this.#setState({ ...this.#downloadSnapshot(), phase: 'downloading' })
      try {
        await this.#cacheArtifact(artifact, signal)
        return
      } catch (error) {
        if (
          signal.aborted ||
          !(error instanceof AppError) ||
          error.code !== 'NETWORK' ||
          attempt >= DownloadRetryLimit
        )
          throw error
        this.#log.caught('update download interrupted; resuming cached bytes', error)
        this.#setState({
          ...this.#downloadSnapshot(),
          phase: 'retrying',
          retryAttempt: attempt + 1,
          bytesPerSecond: 0,
        })
        await TimerScope.sleep(DownloadRetryDelayMs * 2 ** attempt, {
          signal,
          label: 'WorkbenchUpdate.retry',
        })
      }
    }
  }

  async #cacheArtifact(artifact: WorkbenchReleaseArtifact, signal: AbortSignal): Promise<void> {
    const release = this.#release!
    const started = Date.now()
    let initialBytes: Nullable<number> = null
    const path = await this.options.downloadCache!.download(
      artifact,
      (init) =>
        this.releases.fetchArtifact(
          { baseUrl: release.baseUrl, downloadPath: artifact.downloadPath },
          init
        ),
      signal,
      (transferred) => {
        initialBytes ??= transferred
        this.#handleProgress({
          total: artifact.sizeBytes,
          transferred,
          percent: (transferred / artifact.sizeBytes) * 100,
          delta: 0,
          bytesPerSecond: Math.round(
            ((transferred - initialBytes) * 1000) / Math.max(1, Date.now() - started)
          ),
        })
      }
    )
    this.#cached.set(artifact.fileName, path)
  }

  public pauseDownload(): WorkbenchUpdateState {
    if (this.#state.phase !== 'downloading' && this.#state.phase !== 'retrying')
      return this.getState()
    if (this.options.downloadCache) {
      this.#downloadController?.abort()
      this.#downloadCancellation?.cancel()
    } else this.#feed?.pause()
    this.#setState({
      ...this.#downloadSnapshot(),
      phase: 'paused',
      bytesPerSecond: 0,
    })
    return this.getState()
  }

  public async resumeDownload(): Promise<WorkbenchUpdateState> {
    if (this.#state.phase !== 'paused') return this.getState()
    if (this.options.downloadCache) {
      await this.#downloadPromise
      if (this.#state.phase !== 'paused' || this.#disposed) return this.getState()
      void this.downloadUpdate().catch((error) => {
        this.#log.caught('resumed update download failed', error)
      })
      await Promise.resolve()
      return this.getState()
    }
    this.#feed?.resume()
    this.#setState({
      ...this.#downloadSnapshot(),
      phase: 'downloading',
    })
    return this.getState()
  }

  public async cancelDownload(): Promise<WorkbenchUpdateState> {
    if (this.#state.phase !== 'paused') return this.getState()
    const targetVersion = this.#state.targetVersion
    this.#feed?.resume()
    this.#downloadController?.abort()
    this.#downloadCancellation?.cancel()
    await this.#downloadPromise
    await this.#updater?.cancelPreparedUpdate?.()
    this.#cached.clear()
    await this.options.downloadCache?.clear()
    this.#setState({ phase: 'available', targetVersion })
    return this.getState()
  }

  public setAutomaticDownloads(enabled: boolean): WorkbenchUpdateState {
    this.preferences.setAutomaticDownloads(enabled)
    const {
      currentVersion: _currentVersion,
      channel: _channel,
      automaticDownloads: _automaticDownloads,
      ...state
    } = this.#stateWithoutRevision()
    this.#setState({ ...state, automaticDownloads: enabled })
    if (enabled && this.#state.phase === 'available') {
      void this.downloadUpdate().catch((error) => {
        this.#log.caught('automatic update download failed', error)
      })
    }
    return this.getState()
  }

  public async setChannel(channel: WorkbenchUpdateChannel): Promise<WorkbenchUpdateState> {
    if (this.preferences.channel === channel) return this.getState()
    if (this.#checkPromise) await this.#checkPromise.catch(() => undefined)
    this.#feed?.resume()
    this.#downloadController?.abort()
    this.#downloadCancellation?.cancel()
    if (this.#downloadPromise) await this.#downloadPromise.catch(() => undefined)
    await this.#updater?.cancelPreparedUpdate?.()
    await this.#replaceFeed(null)
    try {
      this.preferences.setChannel(channel)
    } catch (error) {
      if (this.#updater?.cancelPreparedUpdate) this.#setState({ phase: 'idle' })
      throw error
    }
    if (this.#updater) this.#updater.allowPrerelease = channel !== 'stable'
    this.#setState({ phase: 'idle' })
    return this.checkForUpdates()
  }

  public restartToUpdate(): void {
    if (this.#state.phase !== 'downloaded') throw new Error('Update is not downloaded yet.')
    this.updater.quitAndInstall(true, true)
  }

  public async dispose(): Promise<void> {
    this.#disposed = true
    this.#updater?.removeListener('update-available', this.#handleAvailable)
    this.#updater?.removeListener('update-not-available', this.#handleNotAvailable)
    this.#updater?.removeListener('download-progress', this.#handleProgress)
    this.#updater?.removeListener('update-downloaded', this.#handleDownloaded)
    this.#updater?.removeListener('update-cancelled', this.#handleCancelled)
    this.#downloadCancellation?.cancel()
    this.#downloadController?.abort()
    // 更新器仍可能为已发出的请求报告取消错误，等在途任务收束后再移除接收者。
    void Promise.allSettled([this.#checkPromise, this.#downloadPromise]).then(() => {
      this.#updater?.removeListener('error', this.#handleError)
    })
    await this.#replaceFeed(null)
    if (this.#downloadPromise) await this.#downloadPromise.catch(() => undefined)
    this.#listeners.clear()
  }

  async #performCheck(): Promise<WorkbenchUpdateState> {
    if (this.#disposed || !this.#isPackaged || !expectedFiles(this.#platform))
      return this.getState()
    this.#setState({ phase: 'checking' })
    try {
      const release = await this.releases.getCurrentRelease({
        channel: this.preferences.channel,
        platform: this.#platform,
        arch: this.#arch,
      })
      validateWorkbenchReleaseCatalog(release.catalog, {
        channel: this.preferences.channel,
        platform: this.#platform,
        arch: this.#arch,
      })
      // The verified catalog can prove there is no version change without initializing the
      // platform installer, differential downloader, or local update-feed server.
      if (
        release.catalog.artifacts.length === 0 ||
        release.catalog.artifacts.every((artifact) => artifact.version === this.#currentVersion)
      ) {
        await this.#replaceFeed(null)
        this.#setState({ phase: 'idle' })
        return this.getState()
      }
      await this.#loadUpdater()
      this.#release = release
      this.#selectedArtifact = null
      this.#cached.clear()
      const feed = new WorkbenchReleaseFeedServer(this.releases, release, (artifact, range) => {
        const path = this.#cached.get(artifact.fileName)
        return path ? this.options.downloadCache!.stream(path, range) : null
      })
      const feedUrl = await feed.listen()
      if (this.#disposed) {
        await feed.close()
        return this.getState()
      }
      await this.#replaceFeed(feed)
      this.updater.setFeedURL({
        provider: 'generic',
        url: feedUrl,
        channel: 'latest',
        useMultipleRangeRequest: false,
      })
      const result = await this.updater.checkForUpdates()
      if (!result?.isUpdateAvailable) await this.#replaceFeed(null)
      return this.getState()
    } catch (error) {
      await this.#replaceFeed(null)
      this.#setError(error)
      throw error
    }
  }

  async #replaceFeed(next: Nullable<WorkbenchReleaseFeedServer>): Promise<void> {
    const previous = this.#feed
    this.#feed = next
    if (previous && previous !== next) await previous.close()
  }

  readonly #handleAvailable = (info: UpdateInfo): void => {
    const format = this.#platform === 'win32' ? 'zip' : expectedFiles(this.#platform)?.packageFormat
    const names = new Set(
      (info.files ?? []).map((file) =>
        decodeURIComponent(new URL(file.url, 'https://update.invalid/').pathname.split('/').at(-1)!)
      )
    )
    this.#selectedArtifact =
      this.#release?.catalog.artifacts.find(
        (artifact) =>
          names.has(artifact.fileName) &&
          artifact.format === format &&
          artifact.version === info.version
      ) ?? null
    this.#setState({ phase: 'available', targetVersion: info.version })
    if (this.preferences.automaticDownloads) {
      void this.downloadUpdate().catch((error) => {
        this.#log.caught('automatic update download failed', error)
      })
    }
  }

  readonly #handleNotAvailable = (): void => {
    this.#setState({ phase: 'idle' })
  }

  readonly #handleProgress = (progress: ProgressInfo): void => {
    if (
      this.#disposed ||
      this.#installingCached ||
      this.#downloadController?.signal.aborted ||
      this.#state.phase !== 'downloading'
    )
      return
    this.#setState({
      phase: progress.percent >= 100 ? 'verifying' : 'downloading',
      targetVersion: this.#state.targetVersion,
      percent: Math.max(0, Math.min(100, progress.percent)),
      transferredBytes: progress.transferred,
      totalBytes: progress.total,
      bytesPerSecond: progress.bytesPerSecond,
    })
  }

  readonly #handleDownloaded = (event: UpdateDownloadedEvent): void => {
    if (
      this.#disposed ||
      this.#state.phase === 'paused' ||
      this.#downloadController?.signal.aborted
    )
      return
    this.#setState({ phase: 'downloaded', targetVersion: event.version, percent: 100 })
  }

  readonly #handleCancelled = (): void => {
    if (
      this.#disposed ||
      this.#state.phase === 'paused' ||
      this.#downloadController?.signal.aborted
    )
      return
    this.#setState({ phase: 'available', targetVersion: this.#state.targetVersion })
  }

  readonly #handleError = (error: Error): void => {
    if (
      this.#disposed ||
      this.#downloadPromise ||
      this.#downloadCancellation?.cancelled ||
      this.#downloadController?.signal.aborted
    )
      return
    this.#setError(error, this.#state.targetVersion)
  }

  #downloadSnapshot(): Omit<
    WorkbenchUpdateState,
    'revision' | 'currentVersion' | 'automaticDownloads' | 'channel'
  > {
    return {
      phase: this.#state.phase,
      targetVersion: this.#state.targetVersion,
      percent: this.#state.percent,
      transferredBytes: this.#state.transferredBytes,
      totalBytes: this.#state.totalBytes,
      bytesPerSecond: this.#state.bytesPerSecond,
    }
  }

  #setError(error: unknown, targetVersion?: string): void {
    this.#setState({
      ...this.#downloadSnapshot(),
      phase: 'error',
      targetVersion,
      error: error instanceof Error ? error.message : String(error),
    })
  }

  #stateWithoutRevision(): Omit<WorkbenchUpdateState, 'revision'> {
    const { revision: _revision, ...state } = this.#state
    return state
  }

  #setState(
    state: Omit<
      WorkbenchUpdateState,
      'revision' | 'currentVersion' | 'automaticDownloads' | 'channel'
    > &
      Partial<Pick<WorkbenchUpdateState, 'automaticDownloads'>>
  ): void {
    if (this.#disposed) return
    const next: Omit<WorkbenchUpdateState, 'revision'> = {
      ...state,
      currentVersion: this.#currentVersion,
      channel: this.preferences.channel,
      automaticDownloads: state.automaticDownloads ?? this.preferences.automaticDownloads,
    }
    const current = this.#stateWithoutRevision()
    if (JSON.stringify(current) === JSON.stringify(next)) return
    this.#state = { ...next, revision: this.#state.revision + 1 }
    const snapshot = this.getState()
    for (const listener of this.#listeners) listener(snapshot)
  }
}
