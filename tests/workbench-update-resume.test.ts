import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { CancellationToken } from 'builder-util-runtime'
import { test } from 'bun:test'
import type { AppUpdater } from 'electron-updater'

import type {
  WorkbenchReleaseArtifact,
  WorkbenchReleaseSource,
} from '../src/main/updates/WorkbenchReleaseSource'
import { WorkbenchUpdateDownloadCache } from '../src/main/updates/WorkbenchUpdateDownloadCache'
import { WorkbenchUpdatePreferencesStore } from '../src/main/updates/WorkbenchUpdatePreferencesStore'
import { WorkbenchUpdateService } from '../src/main/updates/WorkbenchUpdateService'
import type { WorkbenchUpdateState } from '../src/shared/workbenchUpdate'

const body = Buffer.alloc(128 * 1024, 42)
const metadata = Buffer.from('version: 1.1.0\n')
const digest = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')

class CachedUpdater extends EventEmitter {
  feedUrl = ''
  downloads = 0

  public constructor(private readonly fileName: string) {
    super()
  }

  public setFeedURL(input: { url: string }): void {
    this.feedUrl = input.url
  }

  public async checkForUpdates(): Promise<{ isUpdateAvailable: boolean }> {
    const response = await fetch(`${this.feedUrl}latest-mac.yml`)
    assert.equal(response.status, 200)
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), metadata)
    this.emit('update-available', { version: '1.1.0', files: [{ url: this.fileName }] })
    return { isUpdateAvailable: true }
  }

  public downloadUpdate(token: CancellationToken): Promise<void> {
    this.downloads++
    return token.createPromise((resolve, reject, onCancel) => {
      const controller = new AbortController()
      onCancel(() => {
        controller.abort()
        this.emit('update-cancelled')
      })
      const operation = async (): Promise<void> => {
        const url = `${this.feedUrl}${this.fileName}`
        const response = await fetch(url, { signal: controller.signal })
        assert.deepEqual(Buffer.from(await response.arrayBuffer()), body)
        // 安装器从回环读取时不能把网络进度从 100% 拉回 25%。
        this.emit('download-progress', {
          percent: 25,
          transferred: 1,
          total: body.length,
          bytesPerSecond: 1,
        })
        const range = await fetch(url, { headers: { Range: 'bytes=10-19' } })
        assert.equal(range.status, 206)
        assert.equal(range.headers.get('content-range'), `bytes 10-19/${body.length}`)
        assert.deepEqual(Buffer.from(await range.arrayBuffer()), body.subarray(10, 20))
        const invalid = await fetch(url, { headers: { Range: `bytes=${body.length}-` } })
        assert.equal(invalid.status, 416)
        this.emit('update-downloaded', { version: '1.1.0' })
      }
      void operation().then(resolve, reject)
    })
  }
}

for (const mode of [
  'resume',
  'restart',
  'cancel',
  'unadmitted',
  'recovers',
  'exhausted',
  'pause-retry',
  'bad-hash',
] as const) {
  test(`Workbench update cache handles ${mode} through the real HTTP feed`, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'workbench-resume-'))
    const cacheDirectory = join(directory, 'downloads')
    const ranges: Array<string | undefined> = []
    let first = true
    const server = createServer((request, response) => {
      ranges.push(request.headers.range)
      if (['recovers', 'exhausted', 'pause-retry', 'bad-hash'].includes(mode)) {
        const start = Number(request.headers.range?.match(/bytes=(\d+)-/u)?.[1] ?? 0)
        const responseHeaders: Record<string, string | number> = {
          'Content-Length': body.length - start,
        }
        if (start)
          responseHeaders['Content-Range'] = `bytes ${start}-${body.length - 1}/${body.length}`
        response.writeHead(start ? 206 : 200, responseHeaders)
        if (mode === 'bad-hash') response.end(Buffer.alloc(body.length, 0))
        else if (ranges.length <= 3 || mode === 'exhausted' || mode === 'pause-retry') {
          response.write(body.subarray(start, start + 8192))
          setTimeout(() => response.destroy(), 20)
        } else response.end(body.subarray(start))
        return
      }
      if (first) {
        first = false
        response.writeHead(200, { 'Content-Length': body.length })
        response.write(body.subarray(0, 32768))
        return
      }
      const start = Number(request.headers.range?.match(/bytes=(\d+)-/u)?.[1] ?? 0)
      if (request.headers.range)
        response.writeHead(206, {
          'Content-Range': `bytes ${start}-${body.length - 1}/${body.length}`,
        })
      response.end(body.subarray(start))
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    assert.ok(address && typeof address !== 'string')
    const common = {
      softwareProduct: 'workbench' as const,
      version: '1.1.0',
      channel: 'stable',
      platform: 'darwin',
      arch: 'arm64',
      signatureStatus: 'verified' as const,
      attestationVerified: true,
      isCurrent: true,
    }
    const artifact: WorkbenchReleaseArtifact = {
      ...common,
      id: 'package',
      artifactRole: 'update-package',
      format: 'zip',
      fileName: 'update.zip',
      sha256: digest(body),
      sizeBytes: body.length,
      downloadPath: '/v1/releases/download/package',
    }
    let metadataRequests = 0
    const source: WorkbenchReleaseSource = {
      getCurrentRelease: async () => ({
        baseUrl: 'https://updates.test',
        catalog: {
          product: 'workbench',
          channel: 'stable',
          updatePolicy: 'optional',
          artifacts: [
            {
              ...common,
              id: 'metadata',
              artifactRole: 'update-metadata',
              format: 'yml',
              fileName: 'latest-mac.yml',
              sha256: digest(metadata),
              sizeBytes: metadata.length,
              downloadPath: '/v1/releases/download/metadata',
            },
            artifact,
          ],
        },
      }),
      fetchArtifact: (input, init) => {
        if (input.downloadPath === artifact.downloadPath)
          return fetch(`http://127.0.0.1:${address.port}/package`, init)
        metadataRequests++
        return Promise.resolve(new Response(metadata))
      },
    }
    const preferences = new WorkbenchUpdatePreferencesStore(directory)
    preferences.setAutomaticDownloads(false)
    const makeService = (): { service: WorkbenchUpdateService; updater: CachedUpdater } => {
      const updater = new CachedUpdater(
        mode === 'unadmitted' ? 'unverified.zip' : artifact.fileName
      )
      return {
        updater,
        service: new WorkbenchUpdateService(source, updater as unknown as AppUpdater, preferences, {
          currentVersion: '1.0.0',
          isPackaged: true,
          platform: 'darwin',
          arch: 'arm64',
          downloadCache: new WorkbenchUpdateDownloadCache(cacheDirectory),
        }),
      }
    }
    let { service, updater } = makeService()
    try {
      await service.checkForUpdates()
      if (['recovers', 'exhausted', 'pause-retry', 'bad-hash'].includes(mode)) {
        const states: WorkbenchUpdateState[] = []
        service.subscribe((state) => {
          states.push(state)
          if (state.phase === 'retrying' && mode === 'pause-retry') service.pauseDownload()
        })
        const operation = service.downloadUpdate()
        if (mode === 'exhausted' || mode === 'bad-hash') {
          await assert.rejects(operation)
          assert.equal(service.getState().phase, 'error')
          assert.equal(updater.downloads, 0)
        } else if (mode === 'pause-retry') {
          assert.equal((await operation).phase, 'paused')
          assert.equal(ranges.length, 1)
        } else {
          assert.equal((await operation).phase, 'downloaded')
          assert.equal(updater.downloads, 1)
          const phases = states.map((state) => state.phase)
          assert.ok(phases.indexOf('verifying') < phases.indexOf('preparing'))
          assert.ok(phases.indexOf('preparing') < phases.indexOf('downloaded'))
        }
        assert.deepEqual(
          states.filter((state) => state.phase === 'retrying').map((state) => state.retryAttempt),
          mode === 'bad-hash' ? [] : mode === 'pause-retry' ? [1] : [1, 2, 3]
        )
        if (mode === 'recovers' || mode === 'exhausted')
          assert.deepEqual(ranges, [undefined, 'bytes=8192-', 'bytes=16384-', 'bytes=24576-'])
        assert.equal(
          states.filter((state) => state.phase === 'error').length,
          mode === 'bad-hash' || mode === 'exhausted' ? 1 : 0
        )
        return
      }
      if (mode === 'unadmitted') {
        await assert.rejects(service.downloadUpdate(), /admitted package/u)
        assert.equal(updater.downloads, 0)
        assert.deepEqual(ranges, [])
        return
      }
      let paused = false
      const unsubscribe = service.subscribe((state) => {
        if (state.transferredBytes === 32768 && !paused) {
          paused = true
          service.pauseDownload()
        }
      })
      assert.equal((await service.downloadUpdate()).phase, 'paused')
      unsubscribe()
      updater.emit('update-cancelled')
      updater.emit('error', new Error('late cancellation error'))
      // 上游取消通知不能抹掉「暂停」，否则会丢失继续入口。
      updater.emit('download-progress', {
        percent: 0,
        transferred: 0,
        total: body.length,
        bytesPerSecond: 1,
      })
      assert.equal(service.getState().phase, 'paused')
      assert.equal(updater.downloads, 0)
      if (mode === 'restart') {
        await service.dispose()
        ;({ service, updater } = makeService())
        await service.checkForUpdates()
      } else if (mode === 'cancel') {
        assert.equal((await service.cancelDownload()).phase, 'available')
        assert.deepEqual(await readdir(cacheDirectory), [])
        assert.equal(service.getState().percent, undefined)
      }
      const percentages: number[] = []
      service.subscribe((state) => {
        if (state.percent !== undefined) percentages.push(state.percent)
      })
      if (mode === 'resume') await service.resumeDownload()
      assert.equal((await service.downloadUpdate()).phase, 'downloaded')
      assert.equal(updater.downloads, 1)
      assert.deepEqual(ranges, [undefined, mode === 'cancel' ? undefined : 'bytes=32768-'])
      assert.ok(
        percentages.every((value, index) => index === 0 || value >= percentages[index - 1]!)
      )
      assert.ok(metadataRequests >= 1)
    } finally {
      await service.dispose()
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await rm(directory, { recursive: true, force: true })
    }
  }, 15_000)
}
