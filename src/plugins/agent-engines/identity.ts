export type WorkbenchAgentEngineId = 'claude-code' | 'codex'
export type WorkbenchChatProviderId = 'workbench' | WorkbenchAgentEngineId
export type WorkbenchAgentEngineRightTool = 'claude' | 'chatgpt'

export function resolveWorkbenchChatProviderId(
  tool: 'chat' | WorkbenchAgentEngineRightTool
): WorkbenchChatProviderId {
  if (tool === 'claude') return 'claude-code'
  if (tool === 'chatgpt') return 'codex'
  return 'workbench'
}

export function isWorkbenchAgentEngineId(value: unknown): value is WorkbenchAgentEngineId {
  return value === 'claude-code' || value === 'codex'
}
