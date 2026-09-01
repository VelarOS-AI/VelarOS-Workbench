import type { ZodType } from 'zod'

type ClaudeAgentPermissionResult =
  | { behavior: 'allow'; updatedInput?: Record<string, unknown> }
  | { behavior: 'deny'; message: string }

interface ClaudeAgentModelInfo {
  value: string
  displayName: string
  description?: string
  resolvedModel?: string
}

interface ClaudeAgentQueryOptions {
  abortController?: AbortController
  additionalDirectories?: string[]
  canUseTool?: (
    toolName: string,
    toolInput: Record<string, unknown>,
    options: { signal: AbortSignal }
  ) => Promise<ClaudeAgentPermissionResult>
  cwd?: string
  env?: Record<string, string | undefined>
  includePartialMessages?: boolean
  mcpServers?: Record<string, unknown>
  model?: string
  pathToClaudeCodeExecutable?: string
  permissionMode?: string
  resume?: string
  settingSources?: string[]
}

type ClaudeAgentSdkMessage = Record<string, unknown> & { type: string }

interface ClaudeAgentQuery extends AsyncIterable<ClaudeAgentSdkMessage> {
  close(): void
  supportedModels(): Promise<ClaudeAgentModelInfo[]>
}

interface ClaudeAgentSdkModule {
  query(input: { prompt: string; options: ClaudeAgentQueryOptions }): ClaudeAgentQuery
  createSdkMcpServer(input: {
    name: string
    version: string
    instructions: string
    tools: unknown[]
  }): unknown
  tool(
    name: string,
    description: string,
    input: Record<string, ZodType>,
    handler: (input: Record<string, unknown>) => Promise<unknown>,
    options: { searchHint: string; alwaysLoad: boolean }
  ): unknown
}

function isClaudeAgentSdkModule(value: unknown): value is ClaudeAgentSdkModule {
  if (!value || typeof value !== 'object') return false
  const module = value as Record<string, unknown>
  return typeof module.query === 'function'
    && typeof module.createSdkMcpServer === 'function'
    && typeof module.tool === 'function'
}

export {
  type ClaudeAgentModelInfo,
  type ClaudeAgentPermissionResult,
  type ClaudeAgentQuery,
  type ClaudeAgentSdkMessage,
  type ClaudeAgentSdkModule,
  isClaudeAgentSdkModule,
}
