import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import * as tar from 'tar'

import { Log } from '@velaros-ai/core'

import type { WorkbenchAgentEngineId } from '../../plugins/agent-engines/identity'
import { WorkbenchAgentPluginResolver } from '../../plugins/agent-engines/main/WorkbenchAgentPluginResolver'
import type { WorkbenchAgentPluginRuntime } from '../../plugins/agent-engines/main/WorkbenchAgentPluginRuntime'
import type {
  WorkbenchAgentEngineModelCatalog,
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

interface PluginArtifactManifestEntry {
  version: string
  platforms: Record<string, { file: string; sha256: string; size: number } | undefined>
}

interface InstallState {
  progress: number
  error: string | null
  running: boolean
}

interface WorkbenchResourcePluginServiceOptions {
  sharedResourcesRoot?: string
  artifactBase: () => string
  fetchImpl: typeof fetch
  agentEngines: Pick<WorkbenchAgentPluginRuntime, 'listModels'>
  agentPluginResolver?: WorkbenchAgentPluginResolver
}

type CatalogListener = () => void

/** Workbench 插件目录。重型能力只从共享插件资源按需装配，不进入应用包。 */
class WorkbenchResourcePluginService {
  private readonly log = Log.tag('WorkbenchResourcePluginService')
  private readonly preferencesPath: string
  private readonly sharedResourcesRoot: string
  private readonly agentPluginResolver: WorkbenchAgentPluginResolver
  private readonly disabled = new Set<WorkbenchResourcePluginId>()
  private readonly listeners = new Set<CatalogListener>()
  private readonly installStates = new Map<WorkbenchResourcePluginId, InstallState>()
  private readonly inflight = new Map<WorkbenchResourcePluginId, Promise<void>>()

  public constructor(
    dataRootDir: string,
    private readonly codeGraph: WorkbenchCodeGraphResource,
    private readonly options: WorkbenchResourcePluginServiceOptions
  ) {
    this.preferencesPath = join(dataRootDir, 'resource-plugins.json')
    this.sharedResourcesRoot = options.sharedResourcesRoot ?? resolveVelarOSSharedResourcesRoot()
    this.agentPluginResolver = options.agentPluginResolver
      ?? new WorkbenchAgentPluginResolver(this.sharedResourcesRoot)
    this.loadPreferences()
    this.codeGraph.setEnabled(!this.disabled.has('codegraph'))
  }

  public subscribe(listener: CatalogListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  public listCatalog(): WorkbenchResourcePluginCatalog {
    return {
      generatedAt: Date.now(),
      plugins: [
        this.describePlugin('codegraph'),
        this.describePlugin('claude-agent'),
        this.describePlugin('chatgpt'),
      ],
    }
  }

  public isAgentPluginEnabled(engineId: WorkbenchAgentEngineId): boolean {
    const id = engineId === 'claude-code' ? 'claude-agent' : 'chatgpt'
    return this.agentPluginResolver.isInstalled(id) && !this.disabled.has(id)
  }

  public listAgentEngineModels(
    engineId: WorkbenchAgentEngineId
  ): Promise<WorkbenchAgentEngineModelCatalog> {
    return this.options.agentEngines.listModels(engineId)
  }

  public async setEnabled(id: WorkbenchResourcePluginId, enabled: boolean): Promise<void> {
    this.assertSupported(id)
    if (enabled) this.disabled.delete(id)
    else this.disabled.add(id)
    if (id === 'codegraph') this.codeGraph.setEnabled(enabled)
    await this.persistPreferences()
    this.notify()
  }

  public install(id: WorkbenchResourcePluginId): Promise<void> {
    this.assertSupported(id)
    const running = this.inflight.get(id)
    if (running) return running
    const task = (id === 'codegraph' ? this.installCodeGraph() : this.installCloudPlugin(id))
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

  private describePlugin(id: WorkbenchResourcePluginId): WorkbenchResourcePluginRecord {
    const physical = id === 'codegraph'
      ? this.codeGraph.describePhysical()
      : {
          available: this.agentPluginResolver.isInstalled(id),
          packageRoot: this.agentPluginResolver.resolvePackageRoot(id),
          version: this.agentPluginResolver.readVersion(id),
        }
    const install = this.installStates.get(id)
    const installed = physical.available
    const enabled = installed && !this.disabled.has(id)
    return {
      id,
      status: install?.running
        ? 'installing'
        : install?.error
          ? 'failed'
          : installed
            ? enabled ? 'available' : 'disabled'
            : 'missing',
      installed,
      enabled,
      canInstall: !installed && !install?.running,
      version: physical.version,
      packageRoot: installed ? physical.packageRoot : null,
      progress: install?.running ? install.progress : null,
      error: install?.error ?? null,
    }
  }

  private async installCodeGraph(): Promise<void> {
    if (this.codeGraph.describePhysical().available) {
      this.installStates.delete('codegraph')
      this.notify()
      return
    }
    this.setInstallState('codegraph', { running: true, progress: 8, error: null })
    const packageName = `@colbymchenry/codegraph-${process.platform}-${process.arch}`
    const metadataResponse = await fetch(
      `https://registry.npmjs.org/${encodeURIComponent(packageName)}`
    )
    if (!metadataResponse.ok) {
      throw new Error(`CodeGraph registry request failed (${metadataResponse.status}).`)
    }
    const metadata = await metadataResponse.json() as NpmPackageMetadata
    const version = metadata['dist-tags']?.latest
    const distribution = typeof version === 'string' ? metadata.versions?.[version]?.dist : undefined
    if (
      typeof version !== 'string'
      || typeof distribution?.tarball !== 'string'
      || typeof distribution.integrity !== 'string'
      || !distribution.integrity.startsWith('sha512-')
    ) throw new Error('CodeGraph registry metadata is missing a verified artifact.')

    this.setInstallState('codegraph', { running: true, progress: 24, error: null })
    const artifactResponse = await fetch(distribution.tarball)
    if (!artifactResponse.ok) throw new Error(`CodeGraph download failed (${artifactResponse.status}).`)
    const archive = Buffer.from(await artifactResponse.arrayBuffer())
    const actualIntegrity = createHash('sha512').update(archive).digest('base64')
    if (`sha512-${actualIntegrity}` !== distribution.integrity) {
      throw new Error('CodeGraph artifact integrity verification failed.')
    }
    await this.extractPlugin({
      id: 'codegraph',
      archive,
      packageRoot: this.codeGraph.resolvePackageRoot(),
      version,
      strip: 1,
    })
    this.codeGraph.setEnabled(true)
  }

  private async installCloudPlugin(id: 'claude-agent' | 'chatgpt'): Promise<void> {
    this.setInstallState(id, { running: true, progress: 8, error: null })
    const base = this.normalizedArtifactBase()
    const manifestResponse = await this.options.fetchImpl(new URL('manifest.json', base))
    if (!manifestResponse.ok) {
      throw new Error(`插件目录请求失败（${manifestResponse.status}）。`)
    }
    const manifest = await manifestResponse.json() as {
      plugins?: Record<string, PluginArtifactManifestEntry | undefined>
    }
    const entry = manifest.plugins?.[id]
    const artifact = entry?.platforms[`${process.platform}-${process.arch}`]
    if (!entry || !artifact) throw new Error('当前平台没有可用的插件产物。')

    this.setInstallState(id, { running: true, progress: 24, error: null })
    const artifactResponse = await this.options.fetchImpl(new URL(artifact.file, base))
    if (!artifactResponse.ok) throw new Error(`插件下载失败（${artifactResponse.status}）。`)
    const archive = Buffer.from(await artifactResponse.arrayBuffer())
    if (archive.byteLength !== artifact.size) throw new Error('插件产物大小校验失败。')
    const sha256 = createHash('sha256').update(archive).digest('hex')
    if (sha256 !== artifact.sha256.toLowerCase()) throw new Error('插件产物完整性校验失败。')
    await this.extractPlugin({
      id,
      archive,
      packageRoot: this.agentPluginResolver.resolvePackageRoot(id),
      version: entry.version,
      strip: 0,
    })
  }

  private async extractPlugin(input: {
    id: WorkbenchResourcePluginId
    archive: Buffer
    packageRoot: string
    version: string
    strip: number
  }): Promise<void> {
    this.setInstallState(input.id, { running: true, progress: 68, error: null })
    const stagingRoot = join(
      this.sharedResourcesRoot,
      `.${input.id}-install-${process.pid}-${Date.now()}`
    )
    const archivePath = join(stagingRoot, 'package.tgz')
    const extractedRoot = join(stagingRoot, 'package')
    try {
      await mkdir(extractedRoot, { recursive: true })
      await writeFile(archivePath, input.archive)
      await tar.x({ file: archivePath, cwd: extractedRoot, strip: input.strip })
      await writeFile(
        join(extractedRoot, '.velaros-resource.json'),
        `${JSON.stringify({
          schemaVersion: 1,
          resourceId: input.id,
          version: input.version,
          installedAt: Date.now(),
        }, null, 2)}\n`,
        'utf8'
      )
      await mkdir(dirname(input.packageRoot), { recursive: true })
      await rm(input.packageRoot, { recursive: true, force: true })
      await rename(extractedRoot, input.packageRoot)
    } finally {
      await rm(stagingRoot, { recursive: true, force: true }).catch(() => undefined)
    }
    this.disabled.delete(input.id)
    await this.persistPreferences()
    this.installStates.delete(input.id)
    this.notify()
  }

  private normalizedArtifactBase(): URL {
    const base = this.options.artifactBase()
    return new URL(base.endsWith('/') ? base : `${base}/`)
  }

  private setInstallState(id: WorkbenchResourcePluginId, state: InstallState): void {
    this.installStates.set(id, state)
    this.notify()
  }

  private loadPreferences(): void {
    try {
      const parsed = JSON.parse(
        readFileSync(this.preferencesPath, 'utf8')
      ) as PersistedResourcePluginPreferences
      for (const id of parsed.disabled ?? []) {
        if (id === 'codegraph' || id === 'claude-agent' || id === 'chatgpt') {
          this.disabled.add(id)
        }
      }
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
    if (id !== 'codegraph' && id !== 'claude-agent' && id !== 'chatgpt') {
      throw new Error(`Unsupported Workbench resource plugin: ${id}`)
    }
  }

  private notify(): void {
    for (const listener of this.listeners) listener()
  }
}

export { WorkbenchResourcePluginService, type WorkbenchResourcePluginServiceOptions }
