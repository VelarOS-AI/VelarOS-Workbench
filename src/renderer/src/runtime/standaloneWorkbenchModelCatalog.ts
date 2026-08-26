import {
  DefaultProviderModels,
  getResolvedProviderModel,
  getSharedProviderSuggestedModels,
  ModelProviderOperationalManifests,
} from '@velaros-ai/model/catalog'
import type { ChatProviderId } from '@velaros-ai/model/contracts'

export interface StandaloneWorkbenchModelProviderPreset {
  id: ChatProviderId
  label: string
  description: string
  defaultBaseURL: string
  defaultModel: string
  completionModel: string
  apiKeyOptional: boolean
  apiKeyEnvironmentName?: string
  models: readonly string[]
}

const CompletionModelHint = /(?:coder|codestral|code|mini|flash|haiku|fast|lite|small)/iu
const MetaModelHint = /(?:\/auto$|\/free$|^auto$)/iu

function resolveCompletionModel(models: readonly string[], defaultModel: string): string {
  return (
    models.find((model) => !MetaModelHint.test(model) && CompletionModelHint.test(model))
    ?? models.find((model) => !MetaModelHint.test(model))
    ?? defaultModel
  )
}

export const StandaloneWorkbenchModelProviderPresets: readonly StandaloneWorkbenchModelProviderPreset[] =
  ModelProviderOperationalManifests
    .filter((manifest) =>
      !manifest.debugOnly
      && !manifest.managedByCloud
      && manifest.id !== 'custom'
    )
    .map((manifest) => {
      const models = getSharedProviderSuggestedModels(manifest.id)
      const defaultModel = getResolvedProviderModel(
        manifest.id,
        DefaultProviderModels[manifest.id] ?? models[0]
      )
      return {
        id: manifest.id,
        label: manifest.label,
        description: manifest.description,
        defaultBaseURL: manifest.defaultBaseURL,
        defaultModel,
        completionModel: resolveCompletionModel(models, defaultModel),
        apiKeyOptional: manifest.apiKeyOptional ?? false,
        ...(manifest.defaultApiKeyEnv
          ? { apiKeyEnvironmentName: manifest.defaultApiKeyEnv }
          : {}),
        models,
      }
    })

const DefaultProviderId: ChatProviderId = 'openrouter'

export function getStandaloneWorkbenchModelProviderPreset(
  provider: string
): StandaloneWorkbenchModelProviderPreset {
  return (
    StandaloneWorkbenchModelProviderPresets.find((preset) => preset.id === provider)
    ?? StandaloneWorkbenchModelProviderPresets.find((preset) => preset.id === DefaultProviderId)
    ?? StandaloneWorkbenchModelProviderPresets[0]!
  )
}

export function resolveStandaloneWorkbenchProviderModel(
  provider: string,
  model: string | undefined,
  kind: 'agent' | 'completion'
): string {
  const preset = getStandaloneWorkbenchModelProviderPreset(provider)
  const candidate = model?.trim() ?? ''
  if (candidate && preset.models.includes(candidate)) return candidate
  return kind === 'completion' ? preset.completionModel : preset.defaultModel
}
