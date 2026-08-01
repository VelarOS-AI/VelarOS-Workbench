import type { AgentModPackDescriptorLike, AgentModPackReader } from '@velaros-ai/agent'
import { BuiltinAgentModId } from '@velaros-ai/agent'
import type { AgentModManifest } from '@velaros-ai/agent/protocol'
import { AgentModManifestSchemaVersion } from '@velaros-ai/agent/protocol'

import {
  WorkbenchAgentModPackProvidesId,
  WorkbenchAgentModRoutedAxes,
  WorkbenchAgentModRuntime,
} from './WorkbenchAgentModRuntime'

let assertions = 0

function assert(condition: unknown, message: string): asserts condition {
  assertions += 1
  if (!condition) throw new Error(message)
}

function baseVersions() {
  return { velarosVersion: '0.3.0', agentApiVersion: '1.0.0', shellVersion: '0.3.2' }
}

function createManifest(overrides: Partial<AgentModManifest> = {}): AgentModManifest {
  return {
    id: 'probe.mod',
    version: '0.1.0',
    manifestSchemaVersion: AgentModManifestSchemaVersion,
    engines: { velaros: '^0.3.0' },
    trust: 'bundled-official',
    contributes: {},
    ...overrides,
  } as AgentModManifest
}

/**
 * velaros.mod.json 分节信封（Platform P4 73c4247 起 loader 只认信封，裸 manifest 拒载）：
 * module 节 = 窄 kernel descriptor，agent 节 = 九轴 manifest 原样。
 */
function envelope(manifest: AgentModManifest): unknown {
  return {
    module: {
      id: manifest.id,
      version: manifest.version,
      apiVersion: 1,
      provides: [WorkbenchAgentModPackProvidesId],
    },
    agent: manifest,
  }
}

// ── ① 清单读不动时只装 builtin：内置行为零变化，且未接住的轴留诊断 ──
{
  const runtime = new WorkbenchAgentModRuntime({
    versions: baseVersions(),
    reader: { readManifest: () => Promise.reject(new Error('reader must not be called')) },
  })
  const overview = await runtime.assembleDegraded('mod registry unreadable in probe')

  assert(overview.assembled, 'assembleDegraded 后 assembled 必须为 true')
  assert(overview.degradedReason === 'mod registry unreadable in probe', '降级原因必须透传')
  assert(overview.mods.length === 1, '零 pack 时只应装载内置 mod')
  const builtin = overview.mods[0]
  assert(builtin?.modId === BuiltinAgentModId, '内置 mod id 必须匹配')
  assert(builtin?.status === 'active', '声明全九轴支持后内置 mod 必须是 active 而非 partial')
  // P6：hooks 轴已接到本进程执行栈（seam 派发器注入 ContextBuilder / SoloStreamLoop），
  // 因此它必须**不**在 unroutedAxes 里；其余轴仍无落点，如实登记。
  assert(
    WorkbenchAgentModRoutedAxes.every((axis) => !builtin!.unroutedAxes.includes(axis)),
    '已接线的轴不得出现在 unroutedAxes'
  )
  const expectedUnrouted = builtin!.activeAxes.filter(
    (axis) => !WorkbenchAgentModRoutedAxes.includes(axis)
  )
  assert(
    builtin!.unroutedAxes.length === expectedUnrouted.length,
    'unroutedAxes 必须恰好是活跃轴减去已接线轴'
  )
  const unroutedDiagnostics = overview.diagnostics.filter(
    (diagnostic) => diagnostic.code === 'workbench.mod.axis-unrouted'
  )
  assert(
    unroutedDiagnostics.length === expectedUnrouted.length,
    '每条未接线的活跃轴都必须有一条 workbench.mod.axis-unrouted 诊断'
  )
}

// ── ② 本地清单里的 pack：过滤 provides、读分节信封、装载并合流进报告 ──
{
  const manifests = new Map<string, unknown>([
    [
      '/mods/probe-prompt-pack',
      envelope(createManifest({
        id: 'probe.prompt-pack',
        contributes: {
          promptSegments: [
            {
              id: 'probe.segment',
              stability: 'stable',
              priority: 10,
              text: 'probe segment text',
            },
          ],
        },
      })),
    ],
  ])
  const reader: AgentModPackReader = {
    readManifest: ({ packDirectory, manifestFileName }) => {
      const manifest = manifests.get(packDirectory)
      if (!manifest) throw new Error(`no fixture manifest for ${packDirectory}/${manifestFileName}`)
      return manifest
    },
  }
  const runtime = new WorkbenchAgentModRuntime({ versions: baseVersions(), reader })

  const packs: AgentModPackDescriptorLike[] = [
    {
      id: 'probe.prompt-pack',
      version: '0.1.0',
      enabled: true,
      provides: [WorkbenchAgentModPackProvidesId],
      specifier: '/mods/probe-prompt-pack',
      kind: 'contrib',
    },
    {
      id: 'probe.other-axis-pack',
      version: '0.1.0',
      enabled: true,
      // 不含 Agent 轴令牌：必须被跳过而不是拒载。
      provides: ['velaros.some-other-domain'],
      specifier: '/mods/probe-other-axis-pack',
      kind: 'contrib',
    },
    {
      id: 'probe.disabled-pack',
      version: '0.1.0',
      enabled: false,
      provides: [WorkbenchAgentModPackProvidesId],
      specifier: '/mods/probe-disabled-pack',
      kind: 'contrib',
    },
  ]

  const overview = await runtime.assemble({ packs })
  assert(overview.mods.length === 2, '内置 + 1 个真正装载的 pack，其余两个应留诊断跳过')
  const promptPack = overview.mods.find((mod) => mod.modId === 'probe.prompt-pack')
  assert(promptPack?.status === 'active', 'pack 贡献的 promptSegments 轴已声明支持，必须 active')
  assert(
    promptPack?.activeAxes.includes('promptSegments'),
    'pack 的 promptSegments 轴必须出现在 activeAxes'
  )
  assert(
    promptPack?.unroutedAxes.includes('promptSegments'),
    '即便声明支持，Workbench 目前也没有本地消费面，必须记 unrouted'
  )
}

// ── ③ 不受支持的信任级：拒载并带可读诊断，不做残废激活 ──
{
  const manifests = new Map<string, unknown>([
    [
      '/mods/probe-untrusted-pack',
      envelope(createManifest({ id: 'probe.untrusted-pack', trust: 'local-dev' })),
    ],
  ])
  const reader: AgentModPackReader = {
    readManifest: ({ packDirectory }) => {
      const manifest = manifests.get(packDirectory)
      if (!manifest) throw new Error(`no fixture manifest for ${packDirectory}`)
      return manifest
    },
  }
  const runtime = new WorkbenchAgentModRuntime({ versions: baseVersions(), reader })
  const overview = await runtime.assemble({
    packs: [
      {
        id: 'probe.untrusted-pack',
        version: '0.1.0',
        enabled: true,
        provides: [WorkbenchAgentModPackProvidesId],
        specifier: '/mods/probe-untrusted-pack',
        kind: 'contrib',
      },
    ],
  })
  const rejected = overview.mods.find((mod) => mod.modId === 'probe.untrusted-pack')
  assert(rejected?.status === 'rejected', 'local-dev 信任级不在 allowedTrustLevels 内必须拒载')
  assert(rejected!.reasons.length > 0, '拒载必须带可读诊断，不能是空原因')
}

console.info(`workbench agent-mod runtime probe passed (${assertions} assertions)`)
