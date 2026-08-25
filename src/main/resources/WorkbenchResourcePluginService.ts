import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import * as tar from 'tar'

import { Log } from '@velaros-ai/core'

import type {
  WorkbenchResourcePluginCatalog,
  WorkbenchResourcePluginId,
  WorkbenchResourcePluginRecord,
} from '../../shared/workbenchResourcePlugins'

import { resolveVelarOSSharedResourcesRoot } from './VelarOSSharedResourceStore'
import { type WorkbenchCodeGraphResource } from './WorkbenchCodeGraphResource'
interface PersistedResourcePluginPreferences {
  disabled?: string[]
}

interface NpmPackageMetadata {
  'dist-tags'?: { latest?: unknown }
  versions?: Record<string, { dist?: { tarball?: unknown; integrity?: unknown } } | undefined>
}

interface InstallState {
  progress: number
  error: string | null
  running: boolean
}

type CatalogListener = () => void

/** Workbench 自己托管的轻量资源插件目录；Agent 核心能力不经过这里。 */
class WorkbenchResourcePluginService {
  private readonly log = Log.tag('WorkbenchResourcePluginService')
  private readonly preferencesPath: string
  private readonly sharedResourcesRoot: string
  private readonly disabled = new Set<WorkbenchResourcePluginId>()
  private readonly listeners = new Set<CatalogListener>()
  private readonly installStates = new Map<WorkbenchResourcePluginId, InstallState>()
  private readonly inflight = new Map<WorkbenchResourcePluginId, Promise<void>>()

  public constructor(
    dataRootDir: string,
    private readonly codeGraph: WorkbenchCodeGraphResource,
    sharedResourcesRoot = resolveVelarOSSharedResourcesRoot()
  ) {
    this.preferencesPath = join(dataRootDir, 'resource-plugins.json')
    this.sharedResourcesRoot = sharedResourcesRoot
    this.loadPreferences()
    this.codeGraph.setEnabled(!this.disabled.has('codegraph'))
  }

  public subscribe(listener: CatalogListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  public listCatalog(): WorkbenchResourcePluginCatalog {
    const physical = this.codeGraph.describePhysical()
    const install = this.installStates.get('codegraph')
    const installed = physical.available
    const enabled = installed && !this.disabled.has('codegraph')
    const record: WorkbenchResourcePluginRecord = {
      id: 'codegraph',
      status: install?.running
        ? 'installing'
        : install?.error
          ? 'failed'
          : installed
            ? enabled
              ? 'available'
              : 'disabled'
            : 'missing',
      installed,
      enabled,
      canInstall: !installed && !install?.running,
      version: physical.version,
      packageRoot: physical.packageRoot,
      progress: install?.running ? install.progress : null,
      error: install?.error ?? null,
    }
    return { generatedAt: Date.now(), plugins: [record] }
  }

  public async setEnabled(id: WorkbenchResourcePluginId, enabled: boolean): Promise<void> {
    this.assertSupported(id)
    if (enabled) this.disabled.delete(id)
    else this.disabled.add(id)
    this.codeGraph.setEnabled(enabled)
    await this.persistPreferences()
    this.notify()
  }

  public install(id: WorkbenchResourcePluginId): Promise<void> {
    this.assertSupported(id)
    const running = this.inflight.get(id)
    if (running) return running
    const task = this.installCodeGraph()
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error)
        this.log.warn('resource_plugin.install_failed', { id, error: message })
        this.installStates.set(id, { running: false, progress: 0, error: message })
        this.notify()
      })
      .finally(() => this.inflight.delete(id))
    this.inflight.set(id, task)
    return task
  }

  private async installCodeGraph(): Promise<void> {
    if (this.codeGraph.describePhysical().available) {
      this.installStates.delete('codegraph')
      this.notify()
      return
    }
    this.setInstallState({ running: true, progress: 8, error: null })
    const packageName = `@colbymchenry/codegraph-${process.platform}-${process.arch}`
    const registryUrl = `https://registry.npmjs.org/${encodeURIComponent(packageName)}`
    const metadataResponse = await fetch(registryUrl)
    if (!metadataResponse.ok) {
      throw new Error(`CodeGraph registry request failed (${metadataResponse.status}).`)
    }
    const metadata = await metadataResponse.json() as NpmPackageMetadata
    const version = metadata['dist-tags']?.latest
    if (typeof version !== 'string' || !version) {
      throw new Error('CodeGraph registry metadata has no latest version.')
    }
    const distribution = metadata.versions?.[version]?.dist
    if (
      typeof distribution?.tarball !== 'string'
      || typeof distribution.integrity !== 'string'
      || !distribution.integrity.startsWith('sha512-')
    ) {
      throw new Error('CodeGraph registry metadata is missing a verified artifact.')
    }

    this.setInstallState({ running: true, progress: 24, error: null })
    const artifactResponse = await fetch(distribution.tarball)
    if (!artifactResponse.ok) {
      throw new Error(`CodeGraph download failed (${artifactResponse.status}).`)
    }
    const archive = Buffer.from(await artifactResponse.arrayBuffer())
    const actualIntegrity = createHash('sha512').update(archive).digest('base64')
    if (`sha512-${actualIntegrity}` !== distribution.integrity) {
      throw new Error('CodeGraph artifact integrity verification failed.')
    }

    this.setInstallState({ running: true, progress: 68, error: null })
    const packageRoot = this.codeGraph.resolvePackageRoot()
    const stagingRoot = join(
      this.sharedResourcesRoot,
      `.codegraph-install-${process.pid}-${Date.now()}`
    )
    const archivePath = join(stagingRoot, 'package.tgz')
    const extractedRoot = join(stagingRoot, 'package')
    try {
      await mkdir(extractedRoot, { recursive: true })
      await writeFile(archivePath, archive)
      await tar.x({ file: archivePath, cwd: extractedRoot, strip: 1 })
      await mkdir(dirname(packageRoot), { recursive: true })
      await rm(packageRoot, { recursive: true, force: true })
      await rename(extractedRoot, packageRoot)
      await writeFile(
        join(packageRoot, '.velaros-resource.json'),
        `${JSON.stringify({
          schemaVersion: 1,
          resourceId: 'codegraph',
          packageName,
          version,
          installedAt: Date.now(),
        }, null, 2)}\n`,
        'utf8'
      )
    } finally {
      await rm(stagingRoot, { recursive: true, force: true }).catch(() => undefined)
    }

    this.disabled.delete('codegraph')
    this.codeGraph.setEnabled(true)
    await this.persistPreferences()
    this.installStates.delete('codegraph')
    this.notify()
  }

  private setInstallState(state: InstallState): void {
    this.installStates.set('codegraph', state)
    this.notify()
  }

  private loadPreferences(): void {
    try {
      const parsed = JSON.parse(readFileSync(this.preferencesPath, 'utf8')) as PersistedResourcePluginPreferences
      if (parsed.disabled?.includes('codegraph')) this.disabled.add('codegraph')
    } catch {
      // 首次启动没有配置文件是正常状态。
    }
  }

  private async persistPreferences(): Promise<void> {
    await mkdir(dirname(this.preferencesPath), { recursive: true })
    const previous = await readFile(this.preferencesPath, 'utf8').catch(() => '')
    const payload = `${JSON.stringify({ disabled: [...this.disabled] }, null, 2)}\n`
    if (previous !== payload) await writeFile(this.preferencesPath, payload, 'utf8')
  }

  private assertSupported(id: WorkbenchResourcePluginId): void {
    if (id !== 'codegraph') throw new Error(`Unsupported Workbench resource plugin: ${id}`)
  }

  private notify(): void {
    for (const listener of this.listeners) listener()
  }
}

export { WorkbenchResourcePluginService }
