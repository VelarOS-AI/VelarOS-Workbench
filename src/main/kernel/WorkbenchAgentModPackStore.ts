import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'

import type { AgentModPackDescriptorLike, AgentModPackReader } from '@velaros-ai/agent'
import { Log } from '@velaros-ai/core'
import {
  parseVelarosModEnvelope,
  VelarosModManifestFileName,
} from '@velaros-ai/kernel/contracts/protocol'

/**
 * Workbench 本地的 mod pack 存储。
 *
 * kernel-contract §15.1 原则三：pack 的发现 / 启停 / 安装**单一 owner**——P6 起从 Kernel
 * daemon 的 `mods.*` RPC 收归本进程。两种来源合成一份清单：
 *  1. 安装根目录 `<dataRoot>/mods/<packId>/` 逐目录扫描；
 *  2. 注册表 `<dataRoot>/mods/mod-registry.json` 里登记的外部 pack 目录（原地安装，不复制）。
 *
 * 状态只有「停用位 + 外部目录登记」两项，落在同一个注册表文件里；pack 的身份与版本一律
 * 现读 manifest，不做二次缓存（避免注册表与磁盘各说各话）。与 Desktop 的
 * `DesktopAgentModPackStore` 逐项同形——两个宿主各自持有自己的数据根，不共享单写者。
 */

interface WorkbenchAgentModPackRecord extends AgentModPackDescriptorLike {
  readonly id: string
  readonly kind: 'system' | 'user' | 'contrib'
  readonly version: string
  readonly enabled: boolean
  readonly provides: readonly string[]
  /** pack 目录绝对路径（Loader 据此读 manifest）。 */
  readonly specifier: string
}

interface WorkbenchAgentModRegistryFile {
  /** 显式停用的 pack id；缺省即启用。 */
  disabled?: readonly string[]
  /** 原地安装的外部 pack 目录绝对路径。 */
  external?: readonly string[]
}

interface WorkbenchAgentModPackIdentity {
  id: string
  version?: string
  provides: readonly string[]
}

/**
 * 分节信封（velaros.mod.json）的身份读法。
 *
 * 身份住 `module` 节；宿主只读 module 节，`agent` 节归领域 Loader。这是 Desktop
 * 0df74aac0 立的规矩，两宿主共用同一份磁盘格式。
 */
function readManifestIdentity(
  raw: unknown,
  packDirectory: string
): WorkbenchAgentModPackIdentity {
  const parsed = parseVelarosModEnvelope(raw, { origin: packDirectory })
  if (!parsed.ok) {
    throw new Error(
      parsed.diagnostics
        .map((diagnostic) => `${diagnostic.path ?? '<root>'}: ${diagnostic.message}`)
        .join('; ')
    )
  }
  return {
    id: parsed.envelope.module.id,
    version: parsed.envelope.module.version,
    provides: parsed.envelope.module.provides.map((capability) => capability.id),
  }
}

/**
 * Agent mod pack 的磁盘读取端口。
 *
 * 有界读取：只读 pack 目录下那一个 manifest 文件名，不遍历、不写入、不加载第三方代码。
 * 领域 Loader 的 IO 全经此注入，装载编排层因此零文件系统依赖。
 */
function createWorkbenchAgentModPackReader(): AgentModPackReader {
  return {
    readManifest: async ({ packDirectory, manifestFileName }) => {
      const raw = await readFile(join(packDirectory, manifestFileName), 'utf8')
      return JSON.parse(raw)
    },
  }
}

class WorkbenchAgentModPackStore {
  private readonly log = Log.tag('WorkbenchAgentModPackStore')

  public constructor(
    private readonly packsDirectory: string,
    private readonly registryPath: string = join(packsDirectory, 'mod-registry.json')
  ) {}

  /** 全量清单：安装目录扫描 ∪ 外部登记目录，逐个现读 manifest 取身份。 */
  public async list(): Promise<readonly WorkbenchAgentModPackRecord[]> {
    const registry = await this.readRegistry()
    const disabled = new Set(registry.disabled ?? [])
    const records = new Map<string, WorkbenchAgentModPackRecord>()

    for (const directory of await this.listInstalledDirectories()) {
      const record = await this.readPackRecord(directory, 'user', disabled)
      if (record) records.set(record.id, record)
    }
    for (const directory of registry.external ?? []) {
      const record = await this.readPackRecord(directory, 'contrib', disabled)
      if (record) records.set(record.id, record)
    }
    return [...records.values()]
  }

  public async setEnabled(id: string, enabled: boolean): Promise<boolean> {
    const registry = await this.readRegistry()
    const disabled = new Set(registry.disabled ?? [])
    if (enabled) disabled.delete(id)
    else disabled.add(id)
    await this.writeRegistry({ ...registry, disabled: [...disabled] })
    return true
  }

  /**
   * 原地安装：校验目录里有可读 manifest 后登记进注册表（不复制文件）。
   *
   * 目录已在安装根下（扫描即可发现）时不重复登记，只回其描述符。
   */
  public async installFromDirectory(directory: string): Promise<WorkbenchAgentModPackRecord> {
    const packDirectory = resolve(directory)
    if (!isAbsolute(packDirectory)) {
      throw new Error('mod pack 目录必须是绝对路径')
    }
    const identity = readManifestIdentity(await this.readManifest(packDirectory), packDirectory)
    const registry = await this.readRegistry()
    const installedRoots = await this.listInstalledDirectories()
    const alreadyScanned = installedRoots.includes(packDirectory)
    if (!alreadyScanned) {
      const external = new Set(registry.external ?? [])
      external.add(packDirectory)
      await this.writeRegistry({ ...registry, external: [...external] })
    }
    const disabled = new Set(registry.disabled ?? [])
    return {
      id: identity.id,
      kind: alreadyScanned ? 'user' : 'contrib',
      version: identity.version ?? '0.0.0',
      enabled: !disabled.has(identity.id),
      provides: identity.provides,
      specifier: packDirectory,
    }
  }

  private async readPackRecord(
    packDirectory: string,
    kind: WorkbenchAgentModPackRecord['kind'],
    disabled: ReadonlySet<string>
  ): Promise<WorkbenchAgentModPackRecord | undefined> {
    try {
      const identity = readManifestIdentity(await this.readManifest(packDirectory), packDirectory)
      return {
        id: identity.id,
        kind,
        version: identity.version ?? '0.0.0',
        enabled: !disabled.has(identity.id),
        provides: identity.provides,
        specifier: packDirectory,
      }
    } catch (error) {
      // 目录里没有 mod manifest（或读不动）不是错误：它不属本清单，留 debug 痕即可。
      this.log.debug('mods.pack_manifest_unreadable', {
        packDirectory,
        error: error instanceof Error ? error.message : String(error),
      })
      return undefined
    }
  }

  private async readManifest(packDirectory: string): Promise<unknown> {
    const raw = await readFile(join(packDirectory, VelarosModManifestFileName), 'utf8')
    return JSON.parse(raw)
  }

  private async listInstalledDirectories(): Promise<readonly string[]> {
    try {
      const entries = await readdir(this.packsDirectory, { withFileTypes: true })
      return entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => join(this.packsDirectory, entry.name))
    } catch {
      return []
    }
  }

  private async readRegistry(): Promise<WorkbenchAgentModRegistryFile> {
    try {
      const raw = await readFile(this.registryPath, 'utf8')
      const parsed: unknown = JSON.parse(raw)
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
      const record = parsed as Record<string, unknown>
      return {
        ...(Array.isArray(record.disabled)
          ? { disabled: record.disabled.filter((id): id is string => typeof id === 'string') }
          : {}),
        ...(Array.isArray(record.external)
          ? { external: record.external.filter((path): path is string => typeof path === 'string') }
          : {}),
      }
    } catch {
      return {}
    }
  }

  private async writeRegistry(registry: WorkbenchAgentModRegistryFile): Promise<void> {
    await mkdir(this.packsDirectory, { recursive: true })
    await writeFile(this.registryPath, `${JSON.stringify(registry, null, 2)}\n`, 'utf8')
  }
}

export {
  createWorkbenchAgentModPackReader,
  readManifestIdentity,
  WorkbenchAgentModPackStore,
}
export type { WorkbenchAgentModPackRecord }
