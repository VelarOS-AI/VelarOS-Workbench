import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, test } from 'bun:test'

const root = resolve(import.meta.dir, '..')
const readSource = (path: string): string => readFileSync(resolve(root, path), 'utf8')

describe('Workbench Agent Engines Mod', () => {
  test('contributes switchable Claude and ChatGPT right-side tools', () => {
    const surface = readSource('src/renderer/src/models/layout/workbenchSurfaceModel.ts')
    const contribution = readSource('src/plugins/agent-engines/renderer/contribution.tsx')
    const presentation = readSource('src/renderer/src/StandaloneWorkbenchPagePresentation.tsx')

    expect(surface).toContain("'chat' | 'claude' | 'chatgpt'")
    expect(contribution).toContain("id: 'claude'")
    expect(contribution).toContain("id: 'chatgpt'")
    expect(contribution).toContain('velarosWorkbenchAgentMods')
    expect(contribution).not.toContain('velarosWorkbenchResourcePlugins')
    expect(presentation).toContain('resolveWorkbenchChatProviderId(activeRightTool)')
    expect(presentation).toContain('surface.toggleRightTool(item.id)')
  })

  test('keeps the bundled Agent Engines Mod off until the user enables it', () => {
    const service = readSource('src/main/mods/WorkbenchModService.ts')
    const contribution = readSource('src/plugins/agent-engines/renderer/contribution.tsx')

    expect(service).toContain('private enabled = false')
    expect(service).toContain("join(dataRootDir, 'mods.json')")
    expect(service).toContain('this.agentEngines.setEnabled(enabled)')
    expect(contribution).toContain('mod?.enabled ?? false')
  })

  test('keeps a separate persisted conversation for every provider', () => {
    const adapter = readSource('src/renderer/src/runtime/standaloneWorkbenchChatAdapter.tsx')

    expect(adapter).toContain('`${providerId}\\0${projectRoot.trim()}`')
    expect(adapter).toContain('velaros.workbench.chat:${providerId}')
    expect(adapter).toContain("engineId: providerId")
    expect(adapter).toContain('const activeAgentExecutions = new Map')
    expect(adapter).toContain('const inactiveStates = new Map')
    expect(adapter).toContain('findActiveExecution(projectRoot, providerId, chat.sessionId)')
    expect(adapter).toContain('activeSessionId: getState')
  })

  test('passes VelarOS goal and plan axes without making plan mode read-only', () => {
    const adapter = readSource('src/renderer/src/runtime/standaloneWorkbenchChatAdapter.tsx')
    const claude = readSource('src/plugins/agent-engines/main/WorkbenchClaudeAgentRuntime.ts')
    const codex = readSource('src/plugins/agent-engines/main/WorkbenchCodexAgentRuntime.ts')

    expect(adapter).toContain("goalMode ? ['goal' as const]")
    expect(adapter).toContain("planMode ? ['plan' as const]")
    expect(codex).toContain("sandbox: 'workspace-write'")
    expect(claude).toContain("permissionMode: 'default'")
    expect(claude).toContain('Plan mode is writable.')
    expect(codex).toContain('Plan mode is writable.')
    expect(codex).toContain('buildCodexPrompt(\n            input.messages,\n            input.executionModes')
    expect(`${claude}${codex}`).not.toContain("'read-only'")
    expect(`${claude}${codex}`).not.toContain("planMode ? 'plan'")
  })

  test('uses the shared official Mod identity and preserves native engine tools', () => {
    const identity = readSource('src/plugins/agent-engines/identity.ts')
    const manifest = readSource('src/plugins/agent-engines/manifest.ts')
    const claude = readSource('src/plugins/agent-engines/main/WorkbenchClaudeAgentRuntime.ts')
    const codex = readSource('src/plugins/agent-engines/main/WorkbenchCodexAgentRuntime.ts')
    const broker = readSource('src/plugins/agent-engines/main/WorkbenchEngineInteractionBroker.ts')
    const extensionTools = readSource(
      'src/plugins/agent-engines/main/WorkbenchAgentExtensionTools.ts',
    )

    expect(identity).toContain("WorkbenchAgentEnginesModId = 'velaros.agent-engines'")
    expect(manifest).toContain("'process:exec', 'agent:execute'")
    expect(claude).toContain("toolName === 'AskUserQuestion'")
    expect(codex).toContain("method === 'item/tool/requestUserInput'")
    expect(codex).toContain("method === 'item/permissions/requestApproval'")
    expect(codex).toContain("method === 'mcpServer/elicitation/request'")
    expect(broker).toContain("kind: 'awaiting-input'")
    expect(broker).toContain("kind: 'awaiting-confirmation'")
    expect(codex).toContain("toolName: names[type] ?? type")
    expect(extensionTools).toContain('ProjectToolNames.queryCode')
    expect(`${claude}${codex}`).toContain('ProjectCodeToolIdentity')
    expect(`${claude}${codex}`).not.toContain('WorkbenchAgentToolRegistry')
  })
})
