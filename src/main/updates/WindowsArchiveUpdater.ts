import { spawn } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'

import electronUpdater from 'electron-updater'
import type { DownloadUpdateOptions } from 'electron-updater/out/AppUpdater'
import { ElectronHttpExecutor } from 'electron-updater/out/electronHttpExecutor.js'

import { isBoolean, isPlainObject, isString, Log } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

interface WindowsArchiveUpdaterOptions {
  readonly appId: string
  readonly executable: string
  readonly nodeExecutable: string
  readonly workerFile: string
  readonly userDataDirectory: string
}

/** Windows 更新下载 ZIP，由应用目录外的独立进程完成替换。 */
export class WindowsArchiveUpdater extends electronUpdater.AppUpdater {
  readonly #executor = new ElectronHttpExecutor((auth, callback) =>
    this.emit('login', auth, callback)
  )
  #helperDirectory?: string
  #installing = false
  #quitHandlerAdded = false

  public constructor(private readonly options: WindowsArchiveUpdaterOptions) {
    super(undefined)
    void this.#readPreviousResult()
  }

  protected override async doDownloadUpdate(options: DownloadUpdateOptions): Promise<string[]> {
    const { provider, info } = options.updateInfoAndProvider
    const fileInfo = provider
      .resolveFiles(info)
      .find((file) => file.url.pathname.toLowerCase().endsWith('.zip'))
    if (!fileInfo || !fileInfo.info.sha512)
      throw new AppError('SECURITY', 'Windows update archive is missing.')
    return this.executeDownload({
      fileExtension: 'zip',
      fileInfo,
      downloadUpdateOptions: options,
      task: async (destination, downloadOptions) => {
        await this.#executor.download(fileInfo.url, destination, downloadOptions)
      },
      done: async (event) => {
        await this.#prepare(event.downloadedFile, info.version, fileInfo.info.sha512)
        this.dispatchUpdateDownloaded(event)
        if (!this.#quitHandlerAdded) {
          this.#quitHandlerAdded = true
          this.app.onQuit((code) => {
            if (code === 0 && this.autoInstallOnAppQuit && !this.#installing)
              this.#startWorker(false)
          })
        }
      },
    })
  }

  public override quitAndInstall(_isSilent = true, isForceRunAfter = true): void {
    this.#startWorker(isForceRunAfter || this.autoRunAppAfterInstall, () => this.app.quit())
  }

  async #prepare(archive: string, version: string, sha512: string): Promise<void> {
    const helperDirectory = await mkdtemp(join(tmpdir(), 'velaros-update-helper-'))
    const job = {
      appId: this.options.appId,
      appDir: dirname(this.options.executable),
      executable: basename(this.options.executable),
      userDataDir: this.options.userDataDirectory,
      archive,
      version,
      sha512,
      pid: process.pid,
      restart: false,
    }
    try {
      await mkdir(this.options.userDataDirectory, { recursive: true })
      await copyFile(this.options.nodeExecutable, join(helperDirectory, 'node.exe'))
      await copyFile(this.options.workerFile, join(helperDirectory, 'update.cjs'))
      await writeFile(join(helperDirectory, 'job.json'), JSON.stringify(job))
      await new Promise<void>((resolve, reject) => {
        const worker = spawn(
          join(helperDirectory, 'node.exe'),
          [join(helperDirectory, 'update.cjs'), 'prepare', helperDirectory],
          {
            cwd: helperDirectory,
            windowsHide: true,
            stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
            env: { ...process.env, NODE_OPTIONS: '', NODE_PATH: '' },
          }
        )
        let errorText = ''
        worker.stderr?.on('data', (bytes: Buffer) => {
          errorText = (errorText + bytes.toString()).slice(-4000)
        })
        worker.once('error', reject)
        worker.once('exit', (code) => {
          if (code === 0) resolve()
          else reject(new AppError('IO', errorText.trim() || 'Could not prepare Windows update.'))
        })
      })
      this.#helperDirectory = helperDirectory
    } catch (error) {
      await rm(helperDirectory, { recursive: true, force: true })
      throw error
    }
  }

  #startWorker(restart: boolean, onReady?: () => void): void {
    if (this.#installing) return
    if (!this.#helperDirectory) {
      this.dispatchError(new AppError('CONFLICT', 'Windows update has not been prepared.'))
      return
    }
    this.#installing = true
    const directory = this.#helperDirectory
    // 退出事件不能等待异步磁盘操作；重启标志通过进程参数传给已就绪的独立更新进程。
    const worker = spawn(
      join(directory, 'node.exe'),
      [join(directory, 'update.cjs'), 'apply', directory, restart ? 'restart' : 'exit'],
      {
        cwd: directory,
        detached: true,
        windowsHide: true,
        stdio: onReady ? ['ignore', 'ignore', 'ignore', 'ipc'] : 'ignore',
        env: { ...process.env, NODE_OPTIONS: '', NODE_PATH: '' },
      }
    )
    let ready = false
    worker.once('error', (error) => {
      this.#installing = false
      this.dispatchError(AppError.from(error, 'IO'))
    })
    worker.on('message', (message: { ready?: boolean; error?: string }) => {
      if (message.error) {
        this.#installing = false
        this.dispatchError(new AppError('IO', message.error))
      }
      if (message.ready) {
        ready = true
        onReady?.()
      }
    })
    worker.once('exit', (code) => {
      if (!ready && code !== 0) {
        this.#installing = false
        this.dispatchError(new AppError('IO', 'Windows update helper could not start.'))
      }
    })
    worker.unref()
  }

  async #readPreviousResult(): Promise<void> {
    const resultFile = join(this.options.userDataDirectory, 'windows-update-result.json')
    try {
      const result: unknown = JSON.parse(await readFile(resultFile, 'utf8'))
      if (!isPlainObject(result) || !isBoolean(result.success))
        throw new AppError('IO', 'Invalid Windows update receipt.')
      await rm(resultFile)
      if (!result.success) {
        this.dispatchError(
          new AppError(
            'IO',
            isString(result.error)
              ? result.error
              : 'Windows update failed; the previous version was restored.'
          )
        )
      } else if (
        result.success &&
        result.version === this.app.version &&
        isString(result.workRoot) &&
        dirname(result.workRoot) === dirname(dirname(this.options.executable)) &&
        /^\.velaros-update-[\w-]+$/u.test(basename(result.workRoot))
      ) {
        await rm(result.workRoot, { recursive: true, force: true, maxRetries: 8, retryDelay: 500 })
      }
    } catch (error) {
      // 首次安装没有上次更新回执；其它清理问题仅影响备份回收。
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        Log.tag('WindowsArchiveUpdater').caught('Windows update recovery failed', error)
    }
  }
}
