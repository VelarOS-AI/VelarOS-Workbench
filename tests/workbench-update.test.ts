import { EventEmitter } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { CancellationToken } from 'builder-util-runtime'
import { afterEach, describe, expect, test } from 'bun:test'
import type { AppUpdater } from 'electron-updater'

import type { WorkbenchCloudEndpointProvider } from '../src/main/updates/WorkbenchCloudEndpointResolver'
import {
  CloudWorkbenchReleaseSource,
  validateWorkbenchReleaseCatalog,
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

describe('Workbench lazy update installer', () => {
  async function preferences() {
    const root = await mkdtemp(join(tmpdir(), 'workbench-lazy-update-'))
    temporaryRoots.push(root)
    const store = new WorkbenchUpdatePreferencesStore(root)
    store.setAutomaticDownloads(false)
    return store
  }
  const options = { currentVersion: '1.0.0', isPackaged: true, platform: 'darwin' as const, arch: 'arm64' }

  test('current, empty and development release checks never load the platform installer', async () => {
    let loads = 0
    for (const scenario of ['current', 'empty', 'development'] as const) {
      const releases = releaseSource()
      if (scenario === 'empty') releases.getCurrentRelease = async ({ channel }) => ({ baseUrl: 'https://updates.test', catalog: { product: 'workbench', channel, updatePolicy: 'optional', artifacts: [] } })
      const service = new WorkbenchUpdateService(releases, async () => { loads++; return new FakeUpdater() as unknown as AppUpdater }, await preferences(), {
        ...options, currentVersion: scenario === 'current' ? '1.1.0' : '1.0.0', isPackaged: scenario !== 'development',
      })
      expect((await service.checkForUpdates()).phase).toBe('idle')
      expect(loads).toBe(0)
      await service.dispose()
    }
  })

  test('concurrent real update checks share one installer and retain channel, events and disposal', async () => {
    let loads = 0
    const updater = new FakeUpdater()
    const service = new WorkbenchUpdateService(releaseSource(), async () => { loads++; return updater as unknown as AppUpdater }, await preferences(), options)
    expect(loads).toBe(0)
    const first = service.checkForUpdates()
    expect(service.checkForUpdates()).toBe(first)
    expect((await first).phase).toBe('available')
    expect(loads).toBe(1)
    expect(updater.listenerCount('update-available')).toBe(1)
    expect(updater.autoDownload).toBe(false)
    await service.setChannel('beta')
    expect(updater.allowPrerelease).toBe(true)
    expect(loads).toBe(1)
    updater.emit('update-downloaded', { version: '1.1.0' })
    service.restartToUpdate()
    expect(updater.quitCalls).toBe(1)
    await service.dispose()
    expect(updater.listenerCount('update-available')).toBe(0)
  })

  test('failed installer loading can retry and disposal during loading never attaches listeners', async () => {
    let loads = 0
    const updater = new FakeUpdater()
    const service = new WorkbenchUpdateService(releaseSource(), async () => {
      if (++loads === 1) throw new Error('controlled loader failure')
      return updater as unknown as AppUpdater
    }, await preferences(), options)
    await expect(service.checkForUpdates()).rejects.toThrow('controlled loader failure')
    expect((await service.checkForUpdates()).phase).toBe('available')
    expect(loads).toBe(2)
    await service.dispose()

    let release!: (updater: AppUpdater) => void
    let started!: () => void
    const loading = new Promise<AppUpdater>((resolve) => { release = resolve })
    const ready = new Promise<void>((resolve) => { started = resolve })
    const other = new FakeUpdater()
    const disposed = new WorkbenchUpdateService(releaseSource(), () => { started(); return loading }, await preferences(), options)
    const check = disposed.checkForUpdates()
    await ready
    await disposed.dispose()
    release(other as unknown as AppUpdater)
    await expect(check).rejects.toThrow('disposed while loading')
    expect(other.listenerCount('update-available')).toBe(0)
  })
})

describe('CloudWorkbenchReleaseSource', () => {
  test('accepts only the current attested unsigned Windows x64 installer', () => {
    const catalog = {
      product: 'workbench' as const,
      channel: 'stable',
      updatePolicy: 'optional' as const,
      artifacts: [
        {
          id: 'metadata',
          softwareProduct: 'workbench' as const,
          artifactRole: 'update-metadata' as const,
          format: 'yml',
          version: '1.1.0',
          channel: 'stable',
          platform: 'win32',
          arch: 'x64',
          fileName: 'latest.yml',
          sha256: 'a'.repeat(64),
          sizeBytes: 10,
          signatureStatus: 'verified' as const,
          attestationVerified: true,
          isCurrent: true,
          downloadPath: '/v1/releases/download/metadata',
        },
        {
          id: 'installer',
          softwareProduct: 'workbench' as const,
          artifactRole: 'installer' as const,
          format: 'exe',
          version: '1.1.0',
          channel: 'stable',
          platform: 'win32',
          arch: 'x64',
          fileName: 'VelarOS-Workbench-1.1.0-win-x64.exe',
          sha256: 'b'.repeat(64),
          sizeBytes: 100,
          signatureStatus: 'unsigned' as const,
          attestationVerified: true,
          isCurrent: true,
          downloadPath: '/v1/releases/download/installer',
        },
      ],
    }

    expect(
      validateWorkbenchReleaseCatalog(catalog, {
        channel: 'stable',
        platform: 'win32',
        arch: 'x64',
      })
    ).toEqual(catalog)

    for (const installer of [
      { ...catalog.artifacts[1], attestationVerified: false },
      { ...catalog.artifacts[1], isCurrent: false },
      { ...catalog.artifacts[1], artifactRole: 'update-metadata' as const },
      { ...catalog.artifacts[1], signatureStatus: 'forged' as const },
    ]) {
      expect(() =>
        validateWorkbenchReleaseCatalog(
          { ...catalog, artifacts: [catalog.artifacts[0], installer] },
          { channel: 'stable', platform: 'win32', arch: 'x64' }
        )
      ).toThrow('integrity validation')
    }

    const arm64Catalog = {
      ...catalog,
      artifacts: catalog.artifacts.map((artifact) => ({ ...artifact, arch: 'arm64' })),
    }
    expect(() =>
      validateWorkbenchReleaseCatalog(arm64Catalog, {
        channel: 'stable',
        platform: 'win32',
        arch: 'arm64',
      })
    ).toThrow('integrity validation')
  })

  test('rejects unsigned artifacts outside Windows x64', () => {
    const unsignedLinuxCatalog = {
      product: 'workbench',
      channel: 'stable',
      updatePolicy: 'optional',
      artifacts: [
        {
          id: 'metadata',
          softwareProduct: 'workbench',
          artifactRole: 'update-metadata',
          format: 'yml',
          version: '1.1.0',
          channel: 'stable',
          platform: 'linux',
          arch: 'x64',
          fileName: 'latest-linux.yml',
          sha256: 'a'.repeat(64),
          sizeBytes: 10,
          signatureStatus: 'verified',
          attestationVerified: true,
          isCurrent: true,
          downloadPath: '/v1/releases/download/metadata',
        },
        {
          id: 'installer',
          softwareProduct: 'workbench',
          artifactRole: 'installer',
          format: 'appimage',
          version: '1.1.0',
          channel: 'stable',
          platform: 'linux',
          arch: 'x64',
          fileName: 'VelarOS-Workbench-1.1.0-linux-x64.AppImage',
          sha256: 'b'.repeat(64),
          sizeBytes: 100,
          signatureStatus: 'unsigned',
          attestationVerified: true,
          isCurrent: true,
          downloadPath: '/v1/releases/download/installer',
        },
      ],
    }

    expect(() =>
      validateWorkbenchReleaseCatalog(unsignedLinuxCatalog, {
        channel: 'stable',
        platform: 'linux',
        arch: 'x64',
      })
    ).toThrow('integrity validation')
  })

  test('falls back across connection, HTTP, and malformed catalog failures', async () => {
    const requestedUrls: string[] = []
    const healthyUrls: string[] = []
    const endpoints: WorkbenchCloudEndpointProvider = {
      currentBaseUrl: () => 'https://global.velaros.cn/api',
      candidates: async () => [
        'https://global.velaros.cn/api',
        'https://unavailable.example/api',
        'https://invalid.example/api',
        'https://wrong-product.example/api',
        'https://8.152.209.233/api',
      ],
      markHealthy: (baseUrl) => healthyUrls.push(baseUrl),
    }
    const request = (async (input: string | URL | Request) => {
      requestedUrls.push(String(input))
      if (String(input).startsWith('https://global.velaros.cn/')) {
        throw new TypeError('fetch failed')
      }
      if (String(input).startsWith('https://unavailable.example/'))
        return new Response(null, { status: 503 })
      if (String(input).startsWith('https://invalid.example/'))
        return new Response('<html>ICP interstitial</html>', {
          headers: { 'Content-Type': 'text/html' },
        })
      if (String(input).startsWith('https://wrong-product.example/'))
        return Response.json({
          product: 'desktop',
          channel: 'stable',
          updatePolicy: 'optional',
          artifacts: [],
        })
      return Response.json({
        product: 'workbench',
        channel: 'stable',
        updatePolicy: 'optional',
        artifacts: [],
      })
    }) as typeof fetch
    const source = new CloudWorkbenchReleaseSource(endpoints, request)

    const release = await source.getCurrentRelease({
      channel: 'stable',
      platform: 'darwin',
      arch: 'arm64',
    })

    expect(release.baseUrl).toBe('https://8.152.209.233/api')
    expect(requestedUrls).toEqual([
      'https://global.velaros.cn/api/v1/releases/current?product=workbench&channel=stable&platform=darwin&arch=arm64',
      'https://unavailable.example/api/v1/releases/current?product=workbench&channel=stable&platform=darwin&arch=arm64',
      'https://invalid.example/api/v1/releases/current?product=workbench&channel=stable&platform=darwin&arch=arm64',
      'https://wrong-product.example/api/v1/releases/current?product=workbench&channel=stable&platform=darwin&arch=arm64',
      'https://8.152.209.233/api/v1/releases/current?product=workbench&channel=stable&platform=darwin&arch=arm64',
    ])
    expect(healthyUrls).toEqual(['https://8.152.209.233/api'])
  })

  test('downloads only from a trusted candidate and a closed release path', async () => {
    const healthyUrls: string[] = []
    const endpoints: WorkbenchCloudEndpointProvider = {
      currentBaseUrl: () => 'https://8.152.209.233/api',
      candidates: async () => ['https://8.152.209.233/api'],
      markHealthy: (baseUrl) => healthyUrls.push(baseUrl),
    }
    const source = new CloudWorkbenchReleaseSource(
      endpoints,
      (async () => new Response('archive')) as typeof fetch
    )

    await expect(
      source.fetchArtifact({
        baseUrl: 'https://attacker.example/api',
        downloadPath: '/v1/releases/download/package',
      })
    ).rejects.toThrow('base URL is not trusted')
    await expect(
      source.fetchArtifact({
        baseUrl: 'https://8.152.209.233/api',
        downloadPath: '/v1/releases/download/../account',
      })
    ).rejects.toThrow('path is not trusted')

    const response = await source.fetchArtifact({
      baseUrl: 'https://8.152.209.233/api',
      downloadPath: '/v1/releases/download/package-1',
    })
    expect(await response.text()).toBe('archive')
    expect(healthyUrls).toEqual(['https://8.152.209.233/api'])
  })
})
