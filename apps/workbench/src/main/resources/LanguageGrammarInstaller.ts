import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { ReadableStream as NodeReadableStream } from 'node:stream/web'
import { fileURLToPath } from 'node:url'

import { AppError } from '@velaros/core/error'
import type {
  WorkbenchLanguageGrammarCatalog,
  WorkbenchLanguageGrammarInstallState,
  WorkbenchLanguageGrammarRecord,
} from '@velaros/core/types'
import {
  getPluginWorkbenchLanguageServices,
  WORKBENCH_GRAMMAR_RUNTIME_GLOBAL,
} from '@velaros/workbench/language/workbenchLanguageServices'

const GrammarManifestFile = 'grammars-manifest.json'
const GrammarEntryFile = 'index.js'
const GrammarMetaFile = 'meta.json'
const MaximumGrammarArtifactBytes = 25 * 1024 * 1024
const DefaultArtifactBase =
  'https://github.com/Error-Zhang/VelarOS-Workbench/releases/latest/download'
const KnownGrammarIds = new Set(
  getPluginWorkbenchLanguageServices().map((service) => service.id)
)

interface GrammarManifestEntry {
  version: string
  file: string
  sha256: string
  size: number
}

interface InstalledGrammarMeta {
  version: string
  sha256: string
}

interface LanguageGrammarInstallerDependencies {
  installRoot: () => string
  artifactBase?: () => string
  fetchImpl?: typeof fetch
  now?: () => number
}

type ChangeListener = () => void

export class LanguageGrammarInstaller {
  private readonly installRoot: () => string
  private readonly artifactBase: () => string
  private readonly fetchImpl: typeof fetch
  private readonly now: () => number
  private readonly states = new Map<string, WorkbenchLanguageGrammarInstallState>()
  private readonly inflight = new Map<string, Promise<void>>()
  private readonly listeners = new Set<ChangeListener>()

  constructor(dependencies: LanguageGrammarInstallerDependencies) {
    this.installRoot = dependencies.installRoot
    this.artifactBase =
      dependencies.artifactBase ??
      (() =>
        process.env['VELAROS_WORKBENCH_ARTIFACT_BASE']?.trim() ||
        process.env['VELAROS_PLUGIN_ARTIFACT_BASE']?.trim() ||
        DefaultArtifactBase)
    this.fetchImpl = dependencies.fetchImpl ?? fetch
    this.now = dependencies.now ?? Date.now
  }

  public subscribe(listener: ChangeListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  public getInstallRoot(): string {
    return this.installRoot()
  }

  public async listCatalog(): Promise<WorkbenchLanguageGrammarCatalog> {
    const grammars: WorkbenchLanguageGrammarRecord[] = []
    for (const id of [...KnownGrammarIds].sort()) {
      if (!this.inflight.has(id)) await this.recoverInterruptedInstall(id)
      const meta = await this.readInstalledMeta(id)
      const record: WorkbenchLanguageGrammarRecord = { id, installed: meta !== null }
      if (meta) record.version = meta.version
      const install = this.states.get(id)
      if (install) record.install = install
      grammars.push(record)
    }
    return {
      generatedAt: this.now(),
      runtimeGlobal: WORKBENCH_GRAMMAR_RUNTIME_GLOBAL,
      grammars,
    }
  }

  public install(id: string): Promise<void> {
    if (!KnownGrammarIds.has(id))
      return Promise.reject(new AppError('VALIDATION', 'unknown-language-grammar'))
    const running = this.inflight.get(id)
    if (running) return running

    const task = this.runInstall(id)
      .catch((error) => {
        const reason = error instanceof AppError ? error.message : 'install-failed'
        this.setState(id, { phase: 'failed', error: reason })
      })
      .finally(() => this.inflight.delete(id))
    this.inflight.set(id, task)
    return task
  }

  private async runInstall(id: string): Promise<void> {
    await this.recoverInterruptedInstall(id)
    this.setState(id, { phase: 'downloading', percent: 0 })
    const artifact = await this.resolveArtifact(id)
    const root = this.installRoot()
    const nonce = `${this.now()}-${createHash('sha256').update(id).digest('hex').slice(0, 8)}`
    const stagingDir = join(root, `.staging-${id}-${nonce}`)
    const backupDir = join(root, `.backup-${id}`)
    const targetDir = join(root, id)
    const stagingFile = join(stagingDir, GrammarEntryFile)
    let backupCreated = false

    try {
      await mkdir(root, { recursive: true })
      await mkdir(stagingDir, { recursive: false })
      await this.downloadArtifact(id, artifact, stagingFile)
      this.setState(id, { phase: 'verifying' })
      await this.verifyArtifact(stagingFile, artifact)
      const meta: InstalledGrammarMeta = {
        version: artifact.version,
        sha256: artifact.sha256,
      }
      await writeFile(join(stagingDir, GrammarMetaFile), `${JSON.stringify(meta)}\n`, {
        mode: 0o600,
      })

      await rename(targetDir, backupDir)
        .then(() => {
          backupCreated = true
        })
        .catch((error: NodeJS.ErrnoException) => {
          if (error.code !== 'ENOENT') throw error
      })
      await rename(stagingDir, targetDir)
      backupCreated = false
      await rm(backupDir, { recursive: true, force: true }).catch(() => undefined)
      this.clearState(id)
    } catch (error) {
      if (backupCreated) {
        await rm(targetDir, { recursive: true, force: true })
        await rename(backupDir, targetDir)
          .then(() => {
            backupCreated = false
          })
          .catch(() => undefined)
      }
      throw error
    } finally {
      await rm(stagingDir, { recursive: true, force: true })
      if (!backupCreated) await rm(backupDir, { recursive: true, force: true })
    }
  }

  private async resolveArtifact(id: string): Promise<GrammarManifestEntry & { url: URL }> {
    const base = this.normalizedBase()
    const manifestUrl = new URL(GrammarManifestFile, base)
    if (!['file:', 'https:'].includes(manifestUrl.protocol))
      throw new AppError('VALIDATION', 'grammar-artifact-base-invalid')
    const parsed = JSON.parse(await this.readTextResource(manifestUrl)) as unknown
    const entry = readManifestEntry(parsed, id)
    if (!entry) throw new AppError('VALIDATION', 'grammar-manifest-invalid')

    return { ...entry, url: new URL(entry.file, base) }
  }

  private normalizedBase(): string {
    const value = this.artifactBase()
    return value.endsWith('/') ? value : `${value}/`
  }

  private async readTextResource(url: URL): Promise<string> {
    if (url.protocol === 'file:')
      return readFile(fileURLToPath(url), 'utf8').catch(() => {
        throw new AppError('VALIDATION', 'grammar-manifest-unavailable')
      })
    const response = await this.fetchImpl(url, {
      signal: AbortSignal.timeout(30_000),
    }).catch(() => null)
    if (!response?.ok) throw new AppError('VALIDATION', 'grammar-manifest-unavailable')
    return response.text()
  }

  private async downloadArtifact(
    id: string,
    artifact: GrammarManifestEntry & { url: URL },
    targetPath: string
  ): Promise<void> {
    if (artifact.url.protocol === 'file:') {
      const data = await readFile(fileURLToPath(artifact.url)).catch(() => null)
      if (!data) throw new AppError('VALIDATION', 'grammar-artifact-unavailable')
      if (data.byteLength > MaximumGrammarArtifactBytes) {
        throw new AppError('VALIDATION', 'grammar-artifact-too-large')
      }
      await writeFile(targetPath, data, { mode: 0o600 })
      this.setState(id, { phase: 'downloading', percent: 100 })
      return
    }

    const response = await this.fetchImpl(artifact.url, {
      signal: AbortSignal.timeout(60_000),
    }).catch(() => null)
    if (!response?.ok || !response.body) {
      throw new AppError('VALIDATION', 'grammar-artifact-unavailable')
    }

    const headerSize = Number.parseInt(response.headers.get('content-length') ?? '', 10)
    const totalBytes = Number.isFinite(headerSize) && headerSize > 0 ? headerSize : artifact.size
    if (totalBytes > MaximumGrammarArtifactBytes) {
      throw new AppError('VALIDATION', 'grammar-artifact-too-large')
    }

    let receivedBytes = 0
    let lastPercent = -1
    const updateProgress = (percent: number): void => {
      if (percent === lastPercent) return
      lastPercent = percent
      this.setState(id, { phase: 'downloading', percent })
    }
    async function* countProgress(chunks: AsyncIterable<Buffer>): AsyncGenerator<Buffer> {
      for await (const chunk of chunks) {
        receivedBytes += chunk.length
        if (receivedBytes > MaximumGrammarArtifactBytes) {
          throw new AppError('VALIDATION', 'grammar-artifact-too-large')
        }
        if (totalBytes > 0) {
          updateProgress(Math.min(100, Math.floor((receivedBytes / totalBytes) * 100)))
        }
        yield chunk
      }
    }

    await pipeline(
      Readable.fromWeb(response.body as NodeReadableStream),
      countProgress,
      createWriteStream(targetPath, { mode: 0o600 })
    )
  }

  private async verifyArtifact(filePath: string, expected: GrammarManifestEntry): Promise<void> {
    const info = await stat(filePath)
    if (info.size > MaximumGrammarArtifactBytes || (expected.size > 0 && info.size !== expected.size)) {
      throw new AppError('VALIDATION', 'grammar-artifact-size-mismatch')
    }
    const actual = createHash('sha256').update(await readFile(filePath)).digest('hex')
    if (actual !== expected.sha256) {
      throw new AppError('VALIDATION', 'grammar-checksum-mismatch')
    }
  }

  private async readInstalledMeta(id: string): Promise<Nullable<InstalledGrammarMeta>> {
    const directory = join(this.installRoot(), id)
    const [entryExists, metaRaw] = await Promise.all([
      stat(join(directory, GrammarEntryFile)).then(
        (info) => info.isFile(),
        () => false
      ),
      readFile(join(directory, GrammarMetaFile), 'utf8').catch(() => null),
    ])
    if (!entryExists || !metaRaw) return null

    try {
      const parsed = JSON.parse(metaRaw) as Partial<InstalledGrammarMeta>
      if (typeof parsed.version !== 'string' || typeof parsed.sha256 !== 'string') return null
      return { version: parsed.version, sha256: parsed.sha256 }
    } catch {
      return null
    }
  }

  private async recoverInterruptedInstall(id: string): Promise<void> {
    const root = this.installRoot()
    await mkdir(root, { recursive: true })
    const targetDir = join(root, id)
    const backupDir = join(root, `.backup-${id}`)
    const targetExists = await stat(targetDir).then(
      (info) => info.isDirectory(),
      () => false
    )
    const backupExists = await stat(backupDir).then(
      (info) => info.isDirectory(),
      () => false
    )

    if (!targetExists && backupExists) {
      await rename(backupDir, targetDir)
    } else if (targetExists && backupExists) {
      await rm(backupDir, { recursive: true, force: true })
    }

    const entries = await readdir(root).catch(() => [])
    await Promise.all(
      entries
        .filter((entry) => entry.startsWith(`.staging-${id}-`))
        .map((entry) => rm(join(root, entry), { recursive: true, force: true }))
    )
  }

  private setState(id: string, state: WorkbenchLanguageGrammarInstallState): void {
    this.states.set(id, state)
    this.emitChanged()
  }

  private clearState(id: string): void {
    this.states.delete(id)
    this.emitChanged()
  }

  private emitChanged(): void {
    for (const listener of this.listeners) listener()
  }
}

function readManifestEntry(value: unknown, id: string): Nullable<GrammarManifestEntry> {
  if (!value || typeof value !== 'object') return null
  const manifest = value as Record<string, unknown>
  if (manifest['runtimeGlobal'] !== WORKBENCH_GRAMMAR_RUNTIME_GLOBAL) return null
  const grammars = manifest['grammars']
  if (!grammars || typeof grammars !== 'object') return null
  const entry = (grammars as Record<string, unknown>)[id]
  if (!entry || typeof entry !== 'object') return null

  const record = entry as Record<string, unknown>
  const version = record['version']
  const file = record['file']
  const sha256 = record['sha256']
  const size = record['size']
  if (
    typeof version !== 'string' ||
    typeof file !== 'string' ||
    basename(file) !== file ||
    !new RegExp(`^grammar-${id}-[a-zA-Z0-9._+-]+\\.js$`).test(file) ||
    typeof sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(sha256) ||
    typeof size !== 'number' ||
    !Number.isSafeInteger(size) ||
    size <= 0 ||
    size > MaximumGrammarArtifactBytes
  ) return null
  return { version, file, sha256, size }
}
