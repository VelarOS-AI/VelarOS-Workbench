import type { AgentProviderRuntimeConfig, ChatProviderId } from '@velaros-ai/model'

export type AuxiliaryModelTaskId =
  | 'thinkingTranslation'
  | 'gitCommitMessage'
  | 'subAgentGuidanceRelay'
  | 'sessionHandoffBrief'
  | 'chatSuggestions'
  | 'webAgentDispatch'
  | 'editorTabCompletion'

export interface AuxiliaryModelConfig {
  provider: 'chat-config' | ChatProviderId
  model: string
  enabled?: boolean
}

export type AuxiliaryModelConfigs = Record<AuxiliaryModelTaskId, AuxiliaryModelConfig>

export interface AppResourcePluginRecord {
  id: string
  status: 'available' | 'missing' | 'installing' | 'failed'
}

export interface AppResourcePluginCatalog {
  generatedAt: number
  plugins: AppResourcePluginRecord[]
}

export interface WorkspaceCheckpointFileDiff {
  root: string
  path: string
  patch: string
  additions: number
  deletions: number
  status: 'added' | 'deleted' | 'modified'
  binary: boolean
}

export type { AgentProviderRuntimeConfig }
