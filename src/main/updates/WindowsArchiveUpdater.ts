import { type ChildProcess, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { copyFile, mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

import { AppUpdater } from 'electron-updater'
import type { DownloadUpdateOptions } from 'electron-updater/out/AppUpdater'
import { ElectronHttpExecutor } from 'electron-updater/out/electronHttpExecutor.js'

import { isBoolean, isPlainObject, isString, Log } from '@velaros-ai/velaros/core'
import { AppError } from '@velaros-ai/velaros/core/error'

interface WindowsArchiveUpdaterOptions {
  readonly appId: string
  readonly executable: string
  readonly nodeExecutable: string
  readonly workerFile: string
  readonly userDataDirectory: string
}

interface WindowsUpdateWorker {
  readonly process: ChildProcess
  readonly closed: Promise<void>
  readonly task: WindowsUpdateTask
  ready: boolean
  cancelling: boolean
  failure?: AppError
  release?: Promise<void>
}

interface WindowsUpdateTask {
  readonly schema: 1
  readonly jobId: string
  readonly appId: string
  readonly appDir: string
  readonly executable: string
  readonly userDataDir: string
  readonly helperDirectory: string
  readonly workRoot: string
  readonly archive: string
  readonly version: string
  readonly sha512: string
  readonly pid: number
  readonly restart: boolean
}

/** Windows 更新下载 ZIP，由应用目录外的独立进程完成替换。 */
export class WindowsArchiveUpdater extends AppUpdater {
  readonly #executor = new ElectronHttpExecutor((auth, callback) =>
    this.emit('login', auth, callback)
  )
  #worker?: WindowsUpdateWorker
  #installing = false
  public readonly recovery: Promise<void>

  public constructor(private readonly options: WindowsArchiveUpdaterOptions) {
    super(undefined)
    this.recovery = this.#readPreviousResult()
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
      },
    })
  }

  public override quitAndInstall(_isSilent = true, isForceRunAfter = true): void {
    if (this.#installing) return
    const worker = this.#worker
    if (!worker?.process.connected || !worker.ready || worker.cancelling) {
      this.dispatchError(new AppError('CONFLICT', 'Windows update helper is not ready.'))
      return
    }
    this.#installing = true
    worker.process.send({ restart: isForceRunAfter || this.autoRunAppAfterInstall }, (error) => {
      if (error) {
        this.#installing = false
        this.dispatchError(AppError.from(error, 'IO'))
      } else this.app.quit()
    })
  }

  async #prepare(archive: string, version: string, sha512: string): Promise<void> {
    await this.recovery
    await this.cancelPreparedUpdate()
    const jobId = randomUUID()
    const helperDirectory = join(resolve(tmpdir()), `velaros-update-helper-${jobId}`)
    const job: WindowsUpdateTask = {
      schema: 1,
      jobId,
      appId: this.options.appId,
      appDir: dirname(this.options.executable),
      executable: basename(this.options.executable),
      userDataDir: this.options.userDataDirectory,
      helperDirectory,
      workRoot: join(dirname(dirname(this.options.executable)), `.velaros-update-${jobId}`),
      archive,
      version,
      sha512,
      pid: process.pid,
      restart: false,
    }
    await mkdir(helperDirectory)
    let workRootCreated = false
    let registered = false
    try {
      await mkdir(job.workRoot)
      workRootCreated = true
      await mkdir(this.options.userDataDirectory, { recursive: true })
      await this.#registerTask(job)
      registered = true
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
        let processError: Nullable<Error> = null
        worker.stderr?.on('data', (bytes: Buffer) => {
          errorText = (errorText + bytes.toString()).slice(-4000)
        })
        worker.once('error', (error) => {
          processError = error
        })
        worker.once('close', (code) => {
          if (processError) reject(AppError.from(processError, 'IO'))
          else if (code === 0) resolve()
          else reject(new AppError('IO', errorText.trim() || 'Could not prepare Windows update.'))
        })
      })
      await this.#armWorker(job)
    } catch (error) {
      try {
        if (this.#worker?.task === job) await this.cancelPreparedUpdate()
        else {
          if (registered) await this.#recordCancellation(job)
          if (workRootCreated) await rm(job.workRoot, { recursive: true, force: true })
          await rm(helperDirectory, { recursive: true, force: true })
          if (registered) {
            await this.#removeTaskOwner(job)
            await rm(join(this.options.userDataDirectory, `windows-update-result-${job.jobId}.json`))
          }
        }
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          `${AppError.from(error, 'IO').message}; update cleanup failed: ${AppError.from(cleanupError, 'IO').message}`
        )
      }
      throw error
    }
  }

  public cancelPreparedUpdate(): Promise<void> {
    const worker = this.#worker
    if (!worker) return Promise.resolve()
    if (this.#installing)
      return Promise.reject(new AppError('CONFLICT', 'Windows update installation has started.'))
    worker.cancelling = true
    if (!worker.release) {
      const operation = this.#releaseWorker(worker).catch((error) => {
        if (worker.release === operation) worker.release = undefined
        throw error
      })
      worker.release = operation
    }
    return worker.release
  }

  async #releaseWorker(owner: WindowsUpdateWorker): Promise<void> {
    const worker = owner.process
    worker.ref()
    worker.channel?.ref()
    try {
      if (worker.connected) {
        await new Promise<void>((resolve, reject) => {
          worker.send({ cancel: true }, (error) => {
            if (error) reject(error)
            else resolve()
          })
        })
      } else if (worker.exitCode === null && worker.signalCode === null) worker.kill()
    } catch (error) {
      Log.tag('WindowsArchiveUpdater').caught('Windows update cancellation message failed', error)
      worker.kill()
    }
    await owner.closed
    if (owner.failure || worker.exitCode !== 0)
      throw owner.failure ?? new AppError('IO', 'Windows update helper did not cancel cleanly.')
    const resultFile = await this.#recordCancellation(owner.task)
    await rm(owner.task.workRoot, { recursive: true, force: true })
    await rm(owner.task.helperDirectory, { recursive: true, force: true })
    await this.#removeTaskOwner(owner.task)
    if (this.#worker === owner) this.#worker = undefined
    await rm(resultFile)
  }

  async #recordCancellation(task: WindowsUpdateTask): Promise<string> {
    const resultFile = join(this.options.userDataDirectory, `windows-update-result-${task.jobId}.json`)
    const temporaryFile = `${resultFile}.tmp`
    await writeFile(temporaryFile, JSON.stringify({
      schema: 1,
      jobId: task.jobId,
      helperDirectory: task.helperDirectory,
      workRoot: task.workRoot,
      version: task.version,
      workerExited: true,
      success: false,
      cancelled: true,
      error: '',
    }))
    await rename(temporaryFile, resultFile)
    return resultFile
  }

  async #registerTask(task: WindowsUpdateTask): Promise<void> {
    const path = join(this.options.userDataDirectory, 'windows-update-owner.json')
    const owner = await open(path, 'wx')
    try {
      try {
        await owner.writeFile(JSON.stringify(task))
      } finally {
        await owner.close()
      }
    } catch (error) {
      try {
        await rm(path, { force: true })
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          `${AppError.from(error, 'IO').message}; task registration cleanup failed: ${AppError.from(cleanupError, 'IO').message}`
        )
      }
      throw error
    }
  }

  async #removeTaskOwner(task: WindowsUpdateTask): Promise<void> {
    const path = join(this.options.userDataDirectory, 'windows-update-owner.json')
    const owner: unknown = JSON.parse(await readFile(path, 'utf8'))
    if (
      !isPlainObject(owner) ||
      owner.jobId !== task.jobId ||
      owner.helperDirectory !== task.helperDirectory ||
      owner.workRoot !== task.workRoot
    )
      throw new AppError('SECURITY', 'Windows update task ownership changed.')
    await rm(path)
  }

  async #armWorker(task: WindowsUpdateTask): Promise<void> {
    const directory = task.helperDirectory
    // 在发布 downloaded 之前等待独立进程就绪；退出事件里启动进程来不及取得启动回执。
    const worker = spawn(
      join(directory, 'node.exe'),
      [
        join(directory, 'update.cjs'),
        'watch',
        directory,
        this.autoInstallOnAppQuit ? 'exit' : 'skip',
      ],
      {
        cwd: directory,
        detached: true,
        windowsHide: true,
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        env: { ...process.env, NODE_OPTIONS: '', NODE_PATH: '' },
      }
    )
    const owner: WindowsUpdateWorker = {
      process: worker,
      closed: new Promise<void>((resolve) => worker.once('close', () => resolve())),
      task,
      ready: false,
      cancelling: false,
    }
    this.#worker = owner
    await new Promise<void>((resolve, reject) => {
      const fail = (error: AppError): void => {
        owner.ready = false
        owner.failure ??= error
        if (!owner.cancelling) this.dispatchError(owner.failure)
        reject(owner.failure)
      }
      worker.once('error', (error) => fail(AppError.from(error, 'IO')))
      worker.on('message', (message: { ready?: boolean; error?: string }) => {
        if (message.error) fail(new AppError('IO', message.error))
        if (message.ready) {
          if (owner.cancelling || owner.failure) return
          owner.ready = true
          // IPC 保持到父进程退出，但不能让等待退出的子进程反过来阻止应用退出。
          worker.unref()
          worker.channel?.unref()
          resolve()
        }
      })
      worker.once('close', (code) => {
        if (owner.cancelling && code === 0) {
          reject(new AppError('CANCELLED', 'Windows update preparation was cancelled.'))
          return
        }
        fail(new AppError('IO', 'Windows update helper stopped before installation.'))
      })
    })
    if (owner.failure) throw owner.failure
  }

  async #readPreviousResult(): Promise<void> {
    const ownerFile = join(this.options.userDataDirectory, 'windows-update-owner.json')
    let task: WindowsUpdateTask
    try {
      let owner: unknown
      try {
        owner = JSON.parse(await readFile(ownerFile, 'utf8'))
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
        throw error
      }
      task = this.#readTaskOwner(owner)
      const resultFile = join(this.options.userDataDirectory, `windows-update-result-${task.jobId}.json`)
      let result: unknown
      try {
        result = JSON.parse(await readFile(resultFile, 'utf8'))
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT')
          throw new AppError('CONFLICT', 'Windows update completion has not been recorded yet.')
        throw error
      }
      if (
        !isPlainObject(result) ||
        result.schema !== 1 ||
        result.jobId !== task.jobId ||
        result.helperDirectory !== task.helperDirectory ||
        result.workRoot !== task.workRoot ||
        result.version !== task.version ||
        result.workerExited !== true ||
        !isBoolean(result.success) ||
        !isBoolean(result.cancelled) ||
        (result.success && result.cancelled)
      )
        throw new AppError('SECURITY', 'Invalid Windows update completion receipt.')
      if (result.success && task.version !== this.app.version)
        throw new AppError('CONFLICT', 'Windows update receipt does not match this application version.')
      if (result.success || result.cancelled)
        await rm(task.workRoot, { recursive: true, force: true, maxRetries: 8, retryDelay: 500 })
      await rm(task.helperDirectory, { recursive: true, force: true })
      await this.#removeTaskOwner(task)
      await rm(resultFile)
      if (!result.success && !result.cancelled) {
        Log.tag('WindowsArchiveUpdater').error('Windows update failed; recovery files retained', {
          jobId: task.jobId,
          workRoot: task.workRoot,
        })
        this.dispatchError(
          new AppError(
            'IO',
            isString(result.error)
              ? result.error
              : 'Windows update failed; the previous version was restored.'
          )
        )
      }
    } catch (error) {
      Log.tag('WindowsArchiveUpdater').caught('Windows update recovery failed', error)
      this.dispatchError(AppError.from(error, 'IO'))
      throw error
    }
  }

  #readTaskOwner(value: unknown): WindowsUpdateTask {
    if (
      !isPlainObject(value) ||
      value.schema !== 1 ||
      !isString(value.jobId) ||
      !/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/iu.test(value.jobId) ||
      value.appId !== this.options.appId ||
      value.appDir !== dirname(this.options.executable) ||
      value.executable !== basename(this.options.executable) ||
      value.userDataDir !== this.options.userDataDirectory ||
      !isString(value.helperDirectory) ||
      !isAbsolute(value.helperDirectory) ||
      basename(value.helperDirectory) !== `velaros-update-helper-${value.jobId}` ||
      value.workRoot !== join(dirname(dirname(this.options.executable)), `.velaros-update-${value.jobId}`) ||
      !isString(value.archive) ||
      !isAbsolute(value.archive) ||
      !isString(value.version) ||
      !isString(value.sha512) ||
      typeof value.pid !== 'number' ||
      !Number.isSafeInteger(value.pid) ||
      value.pid <= 0 ||
      !isBoolean(value.restart)
    )
      throw new AppError('SECURITY', 'Invalid Windows update task owner.')
    const helperDirectory = value.helperDirectory
    const workRoot = join(dirname(dirname(this.options.executable)), `.velaros-update-${value.jobId}`)
    for (const directory of [helperDirectory, workRoot]) {
      for (const protectedDirectory of [dirname(this.options.executable), this.options.userDataDirectory]) {
        const path = relative(directory, protectedDirectory)
        if (path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path)))
          throw new AppError('SECURITY', 'Windows update cleanup would include application or user data.')
      }
    }
    return {
      schema: 1,
      jobId: value.jobId,
      appId: this.options.appId,
      appDir: dirname(this.options.executable),
      executable: basename(this.options.executable),
      userDataDir: this.options.userDataDirectory,
      helperDirectory,
      workRoot,
      archive: value.archive,
      version: value.version,
      sha512: value.sha512,
      pid: value.pid,
      restart: value.restart,
    }
  }
}
