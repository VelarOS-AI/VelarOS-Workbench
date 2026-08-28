import type { ModelProviderValidationKind } from '@velaros-ai/model/catalog'
import {
  DefaultProviderModels,
  getResolvedProviderModel,
  getSharedProviderSuggestedModels,
  ModelProviderOperationalManifests,
} from '@velaros-ai/model/catalog'
import type { ChatProviderId, ProviderModelCatalogEntry } from '@velaros-ai/model/contracts'

export interface StandaloneWorkbenchModelProviderPreset {
  id: ChatProviderId
  label: string
  description: string
  defaultBaseURL: string
  defaultModel: string
  completionModel: string
  apiKeyOptional: boolean
  validationKind: ModelProviderValidationKind
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
        validationKind: manifest.validationKind,
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
  // 远端厂商目录是当前可用模型的权威；静态目录只提供首次配置默认值。
  // 因此持久化或动态选择得到的非空模型不能再被静态推荐表回退掉。
  if (candidate) return candidate
  return kind === 'completion' ? preset.completionModel : preset.defaultModel
}

export function createStandaloneWorkbenchConfiguredModelSelectorProviders(
  providerId: string,
  modelId: string
): Array<{
  value: ChatProviderId
  label: string
  defaultModel: string
  models: Array<{ value: string; label: string }>
}> {
  const provider = getStandaloneWorkbenchModelProviderPreset(providerId)
  const model = resolveStandaloneWorkbenchProviderModel(provider.id, modelId, 'agent')
  return [{
    value: provider.id,
    label: provider.label,
    defaultModel: model,
    models: [{ value: model, label: model }],
  }]
}

export function createStandaloneWorkbenchProviderModelOptions(
  remoteModels: readonly ProviderModelCatalogEntry[],
  configuredModels: readonly string[]
): Array<{ value: string; label: string }> {
  const options: Array<{ value: string; label: string }> = []
  const seen = new Set<string>()
  for (const model of remoteModels) {
    const value = model.id.trim()
    if (!value || seen.has(value)) continue
    seen.add(value)
    options.push({ value, label: model.label.trim() || value })
  }
  for (const configuredModel of configuredModels) {
    const value = configuredModel.trim()
    if (!value || seen.has(value)) continue
    seen.add(value)
    options.push({ value, label: value })
  }
  return options
}
