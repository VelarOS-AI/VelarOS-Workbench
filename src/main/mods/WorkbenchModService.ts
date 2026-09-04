import { readFileSync } from 'node:fs'
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

import { createBrowserBundledModDefinition } from '@velaros-ai/browser/composition/mod'

import type {
  WorkbenchModCatalog,
  WorkbenchModChangedEvent,
  WorkbenchModId,
  WorkbenchModRecord,
} from '../../shared/workbenchMods'

interface PersistedModPreferences {
  schemaVersion?: unknown
  enabled?: Record<string, unknown>
}

type ModListener = (event: WorkbenchModChangedEvent) => void

const PreferencesSchemaVersion = 1

/**
 * Bundled Mod 的主进程权威状态。
 *
 * Browser 本体随 Workbench 发布，用户选择是否启用；Agent 工具与浏览器
 * surface 都由同一份 Mod 清单和生命周期状态投影。
 */
export class WorkbenchModService {
  private readonly browser = createBrowserBundledModDefinition()
  private readonly preferencesPath: string
  private readonly listeners = new Set<ModListener>()
  private mutationTail: Promise<void> = Promise.resolve()
  private temporaryFileSequence = 0
  private generation = 1
  private browserEnabled: boolean

  public constructor(dataRootDir: string) {
    this.preferencesPath = join(dataRootDir, 'mods.json')
    this.browserEnabled = this.readPersistedEnabled(this.browser.defaultEnabled)
  }

  public subscribe(listener: ModListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  public listCatalog(): WorkbenchModCatalog {
    return Object.freeze({
      generation: this.generation,
      mods: Object.freeze([this.describeBrowser()]),
    })
  }

  public isEnabled(id: WorkbenchModId): boolean {
    this.assertSupported(id)
    return this.browserEnabled
  }

  public setEnabled(id: WorkbenchModId, enabled: boolean): Promise<WorkbenchModCatalog> {
    this.assertSupported(id)
    return this.enqueueMutation(async () => {
      if (this.browserEnabled === enabled) return this.listCatalog()

      await this.persistEnabled(enabled)
      this.browserEnabled = enabled
      this.advanceGeneration()
      return this.listCatalog()
    })
  }

  public dispose(): void {
    this.listeners.clear()
  }

  private describeBrowser(): WorkbenchModRecord {
    return Object.freeze({
      id: this.browser.id,
      displayName: this.browser.manifest.displayName,
      description: this.browser.manifest.description,
      version: this.browser.manifest.version,
      source: 'bundled',
      installed: true,
      enabled: this.browserEnabled,
      defaultEnabled: this.browser.defaultEnabled,
      capabilities: Object.freeze(['browser-surface', 'chat-tools'] as const),
    })
  }

  private assertSupported(id: WorkbenchModId): void {
    if (id !== this.browser.id) throw new Error(`Unsupported Workbench Mod: ${id}`)
  }

  private enqueueMutation<T>(operation: () => T | Promise<T>): Promise<T> {
    const result = this.mutationTail.then(operation, operation)
    this.mutationTail = result.then(() => undefined, () => undefined)
    return result
  }

  private advanceGeneration(): void {
    this.generation += 1
    const event = Object.freeze({ generation: this.generation })
    for (const listener of this.listeners) listener(event)
  }

  private readPersistedEnabled(fallback: boolean): boolean {
    try {
      const parsed = JSON.parse(readFileSync(this.preferencesPath, 'utf8')) as
        PersistedModPreferences
      if (parsed.schemaVersion !== PreferencesSchemaVersion) return fallback
      const enabled = parsed.enabled?.[this.browser.id]
      return typeof enabled === 'boolean' ? enabled : fallback
    } catch {
      return fallback
    }
  }

  private async persistEnabled(enabled: boolean): Promise<void> {
    const directory = dirname(this.preferencesPath)
    await mkdir(directory, { recursive: true })
    const payload = `${JSON.stringify({
      schemaVersion: PreferencesSchemaVersion,
      enabled: { [this.browser.id]: enabled },
    }, null, 2)}\n`
    const temporaryPath = join(
      directory,
      `.${basename(this.preferencesPath)}.${process.pid}.${this.temporaryFileSequence += 1}.tmp`
    )
    try {
      await writeFile(temporaryPath, payload, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
      await rename(temporaryPath, this.preferencesPath)
    } finally {
      await rm(temporaryPath, { force: true }).catch(() => undefined)
    }
  }
}
