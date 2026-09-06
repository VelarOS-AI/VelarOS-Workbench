import type { ModelProviderValidationKind } from '@velaros-ai/model/catalog'
import {
  DefaultProviderModels,
  getResolvedProviderModel,
  getSharedProviderSuggestedModels,
  ModelProviderOperationalManifests,
} from '@velaros-ai/model/catalog'
import type { ChatProviderId, ProviderModelCatalogEntry } from '@velaros-ai/model/contracts'

import type { WorkbenchManagedModelProvider } from '@shared/workbenchModel'
import { getWorkbenchManagedModelProviderLabel } from '@shared/workbenchModel'

export interface StandaloneWorkbenchModelProviderPreset {
  id: ChatProviderId
  label: string
  description: string
  defaultBaseURL: string
  defaultModel: string
  completionModel: string
  apiKeyOptional: boolean
  baseURLConfigurable: boolean
  managedByCloud: boolean
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

const AllStandaloneWorkbenchModelProviderPresets: readonly StandaloneWorkbenchModelProviderPreset[] =
  ModelProviderOperationalManifests
    .filter((manifest) =>
      !manifest.debugOnly
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
        label: manifest.id === 'velar' || manifest.id === 'velar-dev'
          ? getWorkbenchManagedModelProviderLabel(manifest.id === 'velar-dev' ? 'velar-dev' : 'velar')
          : manifest.label,
        description: manifest.description,
        defaultBaseURL: manifest.defaultBaseURL,
        defaultModel,
        completionModel: resolveCompletionModel(models, defaultModel),
        apiKeyOptional: manifest.apiKeyOptional ?? false,
        baseURLConfigurable: manifest.baseURLConfigurable ?? false,
        managedByCloud: manifest.managedByCloud ?? false,
        validationKind: manifest.validationKind,
        ...(manifest.defaultApiKeyEnv
          ? { apiKeyEnvironmentName: manifest.defaultApiKeyEnv }
          : {}),
        models,
      }
    })

/** 自带密钥或本地服务的 provider；Cloud 托管 provider 必须从在线授权快照加入。 */
export const StandaloneWorkbenchModelProviderPresets: readonly StandaloneWorkbenchModelProviderPreset[] =
  AllStandaloneWorkbenchModelProviderPresets.filter((provider) => !provider.managedByCloud)

const DefaultProviderId: ChatProviderId = 'openrouter'

export function getStandaloneWorkbenchModelProviderPreset(
  provider: string
): StandaloneWorkbenchModelProviderPreset {
  return (
    AllStandaloneWorkbenchModelProviderPresets.find((preset) => preset.id === provider)
    ?? StandaloneWorkbenchModelProviderPresets.find((preset) => preset.id === DefaultProviderId)
    ?? StandaloneWorkbenchModelProviderPresets[0]!
  )
}

export function listStandaloneWorkbenchVisibleModelProviderPresets(
  managedModels: readonly WorkbenchManagedModelProvider[]
): readonly StandaloneWorkbenchModelProviderPreset[] {
  const managed = managedModels.map((config) => {
    const preset = getStandaloneWorkbenchModelProviderPreset(config.providerId)
    const models = config.models
      .filter((model) => model.status === 'available')
      .map((model) => model.id)
    const defaultModel =
      (config.defaultModel && models.includes(config.defaultModel) ? config.defaultModel : undefined)
      ?? models[0]
      ?? preset.defaultModel
    return {
      ...preset,
      label: getWorkbenchManagedModelProviderLabel(config.providerId),
      defaultModel,
      completionModel: resolveCompletionModel(models, defaultModel),
      models,
    }
  })
  return [...managed, ...StandaloneWorkbenchModelProviderPresets]
}

export function createStandaloneWorkbenchModelProviderOptions(
  managedModels: readonly WorkbenchManagedModelProvider[],
  disabledDescription: (providerLabel: string) => string
): Array<{ value: ChatProviderId; label: string; description: string; disabled: boolean }> {
  return listStandaloneWorkbenchVisibleModelProviderPresets(managedModels).map((provider) => {
    const disabled = provider.managedByCloud
      && !managedModels.find((entry) => entry.providerId === provider.id)?.enabled
    return {
      value: provider.id,
      label: provider.label,
      description: disabled ? disabledDescription(provider.label) : provider.description,
      disabled,
    }
  })
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
  modelId: string,
  managedProvider?: WorkbenchManagedModelProvider
): Array<{
  value: ChatProviderId
  label: string
  defaultModel: string
  models: Array<{ value: string; label: string }>
}> {
  const provider = managedProvider
    ? listStandaloneWorkbenchVisibleModelProviderPresets([managedProvider])[0]!
    : getStandaloneWorkbenchModelProviderPreset(providerId)
  const model = resolveStandaloneWorkbenchProviderModel(provider.id, modelId, 'agent')
  return [{
    value: provider.id,
    label: provider.label,
    defaultModel: model,
    models: [{
      value: model,
      label: managedProvider?.models.find((entry) => entry.id === model)?.label ?? model,
    }],
  }]
}

export function createStandaloneWorkbenchProviderModelOptions(
  remoteModels: readonly ProviderModelCatalogEntry[],
  configuredModels: readonly string[],
  retainConfiguredModels = true
): Array<{ value: string; label: string }> {
  const options: Array<{ value: string; label: string }> = []
  const seen = new Set<string>()
  for (const model of remoteModels) {
    const value = model.id.trim()
    if (!value || seen.has(value)) continue
    seen.add(value)
    options.push({ value, label: model.label.trim() || value })
  }
  if (retainConfiguredModels) {
    for (const configuredModel of configuredModels) {
      const value = configuredModel.trim()
      if (!value || seen.has(value)) continue
      seen.add(value)
      options.push({ value, label: value })
    }
  }
  return options
}
