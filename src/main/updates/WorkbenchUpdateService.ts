import { CancellationError, CancellationToken } from 'builder-util-runtime'
import type { AppUpdater, ProgressInfo, UpdateDownloadedEvent, UpdateInfo } from 'electron-updater'

import { Log } from '@velaros-ai/core'

import type {
  WorkbenchUpdateChannel,
  WorkbenchUpdateState,
} from '../../shared/workbenchUpdate'

import { WorkbenchReleaseFeedServer } from './WorkbenchReleaseFeedServer'
import type { WorkbenchReleaseSource } from './WorkbenchReleaseSource'
import { validateWorkbenchReleaseCatalog } from './WorkbenchReleaseSource'
import type { WorkbenchUpdatePreferencesStore } from './WorkbenchUpdatePreferencesStore'

interface WorkbenchUpdateServiceOptions {
  readonly currentVersion: string
  readonly isPackaged: boolean
  readonly platform?: NodeJS.Platform
  readonly arch?: string
}

type WorkbenchUpdateListener = (state: WorkbenchUpdateState) => void

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

  public constructor(
    private readonly releases: WorkbenchReleaseSource,
    private readonly updater: AppUpdater,
    private readonly preferences: WorkbenchUpdatePreferencesStore,
    options: WorkbenchUpdateServiceOptions
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

    this.updater.autoDownload = false
    this.updater.allowPrerelease = preferences.channel !== 'stable'
    this.updater.autoInstallOnAppQuit = true
    this.updater.autoRunAppAfterInstall = true
    this.updater.disableDifferentialDownload = true
    this.updater.logger = {
      info: (message) => this.#log.info(String(message)),
      warn: (message) => this.#log.warn(String(message)),
      error: (message) => this.#log.error(String(message)),
      debug: (message) => this.#log.debug(String(message)),
    }
    this.updater.on('update-available', this.#handleAvailable)
    this.updater.on('update-not-available', this.#handleNotAvailable)
    this.updater.on('download-progress', this.#handleProgress)
    this.updater.on('update-downloaded', this.#handleDownloaded)
    this.updater.on('update-cancelled', this.#handleCancelled)
    this.updater.on('error', this.#handleError)
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
      this.#state.phase === 'downloading' ||
      this.#state.phase === 'paused' ||
      this.#state.phase === 'downloaded'
    ) return Promise.resolve(this.getState())
    if (this.#checkPromise) return this.#checkPromise
    const operation = this.#performCheck().finally(() => {
      if (this.#checkPromise === operation) this.#checkPromise = null
    })
    this.#checkPromise = operation
    return operation
  }

  public downloadUpdate(): Promise<WorkbenchUpdateState> {
    if (this.#downloadPromise) return this.#downloadPromise
    if (this.#state.phase !== 'available' && this.#state.phase !== 'error') return Promise.resolve(this.getState())
    if (!this.#state.targetVersion) throw new Error('No Workbench update is available.')

    const targetVersion = this.#state.targetVersion
    const cancellation = new CancellationToken()
    this.#downloadCancellation = cancellation
    this.#setState({
      phase: 'downloading',
      targetVersion,
      percent: 0,
      transferredBytes: 0,
    })
    const operation = this.updater
      .downloadUpdate(cancellation)
      .then(() => this.getState())
      .catch((error) => {
        if (error instanceof CancellationError || cancellation.cancelled) return this.getState()
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

  public pauseDownload(): WorkbenchUpdateState {
    if (this.#state.phase !== 'downloading') return this.getState()
    this.#feed?.pause()
    this.#setState({
      ...this.#downloadSnapshot(),
      phase: 'paused',
    })
    return this.getState()
  }

  public resumeDownload(): WorkbenchUpdateState {
    if (this.#state.phase !== 'paused') return this.getState()
    this.#feed?.resume()
    this.#setState({
      ...this.#downloadSnapshot(),
      phase: 'downloading',
    })
    return this.getState()
  }

  public cancelDownload(): WorkbenchUpdateState {
    if (this.#state.phase !== 'paused') return this.getState()
    const targetVersion = this.#state.targetVersion
    this.#feed?.resume()
    this.#downloadCancellation?.cancel()
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
    this.#downloadCancellation?.cancel()
    if (this.#downloadPromise) await this.#downloadPromise.catch(() => undefined)
    await this.#replaceFeed(null)
    this.preferences.setChannel(channel)
    this.updater.allowPrerelease = channel !== 'stable'
    this.#setState({ phase: 'idle' })
    return this.checkForUpdates()
  }

  public restartToUpdate(): void {
    if (this.#state.phase !== 'downloaded') throw new Error('Update is not downloaded yet.')
    this.updater.quitAndInstall(true, true)
  }

  public async dispose(): Promise<void> {
    this.updater.removeListener('update-available', this.#handleAvailable)
    this.updater.removeListener('update-not-available', this.#handleNotAvailable)
    this.updater.removeListener('download-progress', this.#handleProgress)
    this.updater.removeListener('update-downloaded', this.#handleDownloaded)
    this.updater.removeListener('update-cancelled', this.#handleCancelled)
    this.updater.removeListener('error', this.#handleError)
    this.#downloadCancellation?.cancel()
    await this.#replaceFeed(null)
    this.#listeners.clear()
  }

  async #performCheck(): Promise<WorkbenchUpdateState> {
    if (!this.#isPackaged || !expectedFiles(this.#platform)) return this.getState()
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
      if (release.catalog.artifacts.length === 0) {
        await this.#replaceFeed(null)
        this.#setState({ phase: 'idle' })
        return this.getState()
      }
      const feed = new WorkbenchReleaseFeedServer(this.releases, release)
      const feedUrl = await feed.listen()
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
    if (this.#state.phase === 'paused') return
    this.#setState({
      phase: 'downloading',
      targetVersion: this.#state.targetVersion,
      percent: Math.max(0, Math.min(100, progress.percent)),
      transferredBytes: progress.transferred,
      totalBytes: progress.total,
      bytesPerSecond: progress.bytesPerSecond,
    })
  }

  readonly #handleDownloaded = (event: UpdateDownloadedEvent): void => {
    this.#setState({ phase: 'downloaded', targetVersion: event.version, percent: 100 })
  }

  readonly #handleCancelled = (): void => {
    this.#setState({ phase: 'available', targetVersion: this.#state.targetVersion })
  }

  readonly #handleError = (error: Error): void => {
    if (this.#state.phase === 'downloaded' || this.#downloadCancellation?.cancelled) return
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
    > & Partial<Pick<WorkbenchUpdateState, 'automaticDownloads'>>
  ): void {
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
