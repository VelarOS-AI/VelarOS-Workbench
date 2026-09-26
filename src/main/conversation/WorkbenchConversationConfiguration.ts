import type { AgentModelResolverApi } from '@velaros-ai/model'
import { createAiSdkModelDriver } from '@velaros-ai/model'

import type { WorkbenchConversationSendRequest } from '../../shared/workbenchConversation'

import type { ConversationRunConfiguration } from './WorkbenchConversationTypes'

/** 模型没报窗口时按这么大算。 */
const DefaultContextTokens = 128_000
/** 输出预留的上限；小窗口按四分之一留。 */
const MaxOutputTokens = 12_000
/** 输入上限再扣这么多安全余量。 */
const SafetyTokens = 4_096

/**
 * 按这一轮请求里的模型选择建模型驱动（与 Desktop 的会话配置同一算法）。Workbench 是自带密钥：服务商的
 * 密钥与地址随选择一起来，托管服务商（VelarOS Cloud）由模型组合里登记的云运行时代为鉴权。
 */
export function createWorkbenchConversationConfiguration(
  resolver: Pick<AgentModelResolverApi, 'resolve'>
): (
  request: WorkbenchConversationSendRequest,
  signal: AbortSignal
) => Promise<ConversationRunConfiguration> {
  return async (request, signal) => {
    signal.throwIfAborted()
    const selection = { ...request.model, reasoningLevel: request.reasoningLevel }
    const resolved = await resolver.resolve(
      selection,
      {
        providerRuntimeConfigs: [
          {
            provider: selection.provider,
            enabled: true,
            apiKey: selection.apiKey,
            baseURL: selection.baseURL,
            defaultModel: selection.model,
          },
        ],
        openRouter: { useFreeModelsForDebug: false },
      },
      signal
    )
    signal.throwIfAborted()
    const contextTokens = resolved.contextWindow ?? DefaultContextTokens
    const outputTokens = Math.min(MaxOutputTokens, Math.floor(contextTokens / 4))
    const model = createAiSdkModelDriver({
      id: `${resolved.providerId}/${resolved.model}`,
      model: resolved.provider(resolved.model, {
        ...resolved.modelRequestOptions,
        runtimeContext: {
          ...resolved.modelRequestOptions?.runtimeContext,
          sessionId: request.sessionId,
        },
      }),
      limits: {
        contextTokens,
        outputTokens,
        inputTokens: contextTokens - outputTokens - SafetyTokens,
      },
    })
    return {
      model,
      provider: resolved.providerId,
      imageInput: resolved.supportedInputModalities.includes('image'),
    }
  }
}
