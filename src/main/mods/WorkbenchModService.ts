import { readFileSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import {
  type WorkbenchAgentEngineId,
  WorkbenchAgentEnginesModId,
  WorkbenchAgentEnginesModVersion,
} from '../../plugins/agent-engines/identity'
import type { WorkbenchAgentEnginesModRuntime } from '../../plugins/agent-engines/main/WorkbenchAgentEnginesModRuntime'
import type {
  WorkbenchAgentEngineModelCatalog,
  WorkbenchModCatalog,
  WorkbenchModRecord,
} from '../../shared/workbenchAgentMods'

interface PersistedWorkbenchModPreferences {
  enabled?: string[]
}

type CatalogListener = () => void

/** Workbench 的产品级 Mod 目录；外部 Agent 接入默认关闭，只能由用户在 Mod 页开启。 */
export class WorkbenchModService {
  private readonly preferencesPath: string
  private readonly listeners = new Set<CatalogListener>()
  private enabled = false

  public constructor(
    dataRootDir: string,
    private readonly agentEngines: WorkbenchAgentEnginesModRuntime
  ) {
    this.preferencesPath = join(dataRootDir, 'mods.json')
    this.loadPreferences()
    this.agentEngines.setEnabled(this.enabled)
  }

  public subscribe(listener: CatalogListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  public listCatalog(): WorkbenchModCatalog {
    const record: WorkbenchModRecord = {
      id: WorkbenchAgentEnginesModId,
      displayName: 'Agent Engines',
      description: 'Connect local Claude and ChatGPT sessions to Workbench.',
      version: WorkbenchAgentEnginesModVersion,
      enabled: this.enabled,
    }
    return { generatedAt: Date.now(), mods: [record] }
  }

  public async setEnabled(id: WorkbenchModRecord['id'], enabled: boolean): Promise<void> {
    if (id !== WorkbenchAgentEnginesModId) throw new Error(`Unsupported Workbench Mod: ${id}`)
    if (this.enabled === enabled) return
    this.enabled = enabled
    this.agentEngines.setEnabled(enabled)
    await this.persistPreferences()
    this.notify()
  }

  public listAgentEngineModels(
    engineId: WorkbenchAgentEngineId
  ): Promise<WorkbenchAgentEngineModelCatalog> {
    return this.agentEngines.listModels(engineId)
  }

  private loadPreferences(): void {
    try {
      const parsed = JSON.parse(
        readFileSync(this.preferencesPath, 'utf8')
      ) as PersistedWorkbenchModPreferences
      this.enabled = parsed.enabled?.includes(WorkbenchAgentEnginesModId) ?? false
    } catch {
      this.enabled = false
    }
  }

  private async persistPreferences(): Promise<void> {
    await mkdir(dirname(this.preferencesPath), { recursive: true })
    const previous = await readFile(this.preferencesPath, 'utf8').catch(() => '')
    const payload = `${JSON.stringify({
      enabled: this.enabled ? [WorkbenchAgentEnginesModId] : [],
    }, null, 2)}\n`
    if (previous !== payload) await writeFile(this.preferencesPath, payload, 'utf8')
  }

  private notify(): void {
    for (const listener of this.listeners) listener()
  }
}
