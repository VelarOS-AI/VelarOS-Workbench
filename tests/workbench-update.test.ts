import { EventEmitter } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { CancellationToken } from 'builder-util-runtime'
import { afterEach, describe, expect, test } from 'bun:test'
import type { AppUpdater } from 'electron-updater'

import {
  CloudWorkbenchReleaseSource,
  type WorkbenchReleaseSource,
} from '../src/main/updates/WorkbenchReleaseSource'
import { WorkbenchUpdatePreferencesStore } from '../src/main/updates/WorkbenchUpdatePreferencesStore'
import { WorkbenchUpdateService } from '../src/main/updates/WorkbenchUpdateService'

const temporaryRoots: string[] = []

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

class FakeUpdater extends EventEmitter {
  autoDownload = true
  allowPrerelease = true
  autoInstallOnAppQuit = false
  autoRunAppAfterInstall = false
  disableDifferentialDownload = false
  logger: unknown
  feedUrl = ''
  quitCalls = 0

  public setFeedURL(input: { readonly url: string }): void {
    this.feedUrl = input.url
  }

  public async checkForUpdates(): Promise<{ readonly isUpdateAvailable: boolean }> {
    this.emit('update-available', { version: '1.1.0' })
    return { isUpdateAvailable: true }
  }

  public downloadUpdate(token: CancellationToken): Promise<never> {
    this.emit('download-progress', {
      percent: 25,
      transferred: 25,
      total: 100,
      bytesPerSecond: 10,
    })
    return token.createPromise(() => undefined)
  }

  public quitAndInstall(): void {
    this.quitCalls += 1
  }
}

function releaseSource(): WorkbenchReleaseSource {
  return {
    getCurrentRelease: async ({ channel }) => ({
      baseUrl: 'https://updates.test',
      catalog: {
        product: 'workbench',
        channel,
        updatePolicy: 'optional',
        artifacts: [
          {
            id: 'metadata',
            softwareProduct: 'workbench',
            artifactRole: 'update-metadata',
            format: 'yml',
            version: '1.1.0',
            channel,
            platform: 'darwin',
            arch: 'arm64',
            fileName: 'latest-mac.yml',
            sha256: 'a'.repeat(64),
            sizeBytes: 10,
            signatureStatus: 'verified',
            attestationVerified: true,
            isCurrent: true,
            downloadPath: '/v1/releases/download/metadata',
          },
          {
            id: 'package',
            softwareProduct: 'workbench',
            artifactRole: 'update-package',
            format: 'zip',
            version: '1.1.0',
            channel,
            platform: 'darwin',
            arch: 'arm64',
            fileName: 'VelarOS-Workbench-1.1.0-mac-arm64.zip',
            sha256: 'b'.repeat(64),
            sizeBytes: 100,
            signatureStatus: 'notarized',
            attestationVerified: true,
            isCurrent: true,
            downloadPath: '/v1/releases/download/package',
          },
        ],
      },
    }),
    fetchArtifact: async () => new Response(),
  }
}

describe('WorkbenchUpdateService', () => {
  test('defaults to automatic download and removes a paused download on cancel', async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), 'workbench-update-test-'))
    temporaryRoots.push(dataRoot)
    const updater = new FakeUpdater()
    const service = new WorkbenchUpdateService(
      releaseSource(),
      updater as unknown as AppUpdater,
      new WorkbenchUpdatePreferencesStore(dataRoot),
      {
        currentVersion: '1.0.0',
        isPackaged: true,
        platform: 'darwin',
        arch: 'arm64',
      }
    )

    await service.checkForUpdates()
    expect(service.getState()).toMatchObject({
      phase: 'downloading',
      channel: 'stable',
      automaticDownloads: true,
      percent: 25,
    })
    expect(service.pauseDownload().phase).toBe('paused')
    expect(service.cancelDownload().phase).toBe('available')
    expect(service.getState().percent).toBeUndefined()
    await service.dispose()
  })

  test('persists a selected channel and checks that catalog immediately', async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), 'workbench-update-channel-test-'))
    temporaryRoots.push(dataRoot)
    const updater = new FakeUpdater()
    const preferences = new WorkbenchUpdatePreferencesStore(dataRoot)
    preferences.setAutomaticDownloads(false)
    const service = new WorkbenchUpdateService(
      releaseSource(),
      updater as unknown as AppUpdater,
      preferences,
      {
        currentVersion: '1.0.0',
        isPackaged: true,
        platform: 'darwin',
        arch: 'arm64',
      }
    )

    const state = await service.setChannel('beta')
    expect(state).toMatchObject({ phase: 'available', channel: 'beta' })
    expect(new WorkbenchUpdatePreferencesStore(dataRoot).channel).toBe('beta')
    expect(updater.allowPrerelease).toBe(true)
    await service.dispose()
  })
})

describe('CloudWorkbenchReleaseSource', () => {
  test('requests the Workbench catalog from the public Cloud API route', async () => {
    const requestedUrls: string[] = []
    const request = (async (input: string | URL | Request) => {
      requestedUrls.push(String(input))
      return Response.json({
        product: 'workbench',
        channel: 'stable',
        updatePolicy: 'optional',
        artifacts: [],
      })
    }) as typeof fetch
    const source = new CloudWorkbenchReleaseSource(request)

    const release = await source.getCurrentRelease({
      channel: 'stable',
      platform: 'darwin',
      arch: 'arm64',
    })

    expect(release.baseUrl).toBe('https://global.velaros.cn/api')
    expect(requestedUrls).toEqual([
      'https://global.velaros.cn/api/v1/releases/current?product=workbench&channel=stable&platform=darwin&arch=arm64',
    ])
  })
})
