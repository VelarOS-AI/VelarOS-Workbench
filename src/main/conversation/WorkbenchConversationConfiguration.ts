import { createHash } from 'node:crypto'

import type { AgentModelResolverApi } from '@velaros-ai/velaros/model'
import { createAiSdkModelDriver } from '@velaros-ai/velaros/model'

import type { WorkbenchConversationSendRequest } from '../../shared/workbenchConversation'

import { ConversationContextCapacity } from './ConversationContextCapacity'
import { ConversationModelDriver } from './ConversationModelDriver'
import type { ConversationRunConfiguration } from './WorkbenchConversationTypes'

const CapacityCacheEntries = 128

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
  const capacities = new Map<string, ConversationContextCapacity>()
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
            apiKey: selection.apiKey ?? '',
            baseURL: selection.baseURL ?? '',
            defaultModel: selection.model,
          },
        ],
        openRouter: { useFreeModelsForDebug: false },
      },
      signal
    )
    signal.throwIfAborted()
    // 端点、凭据或模型元数据变化后重新试探；缓存只保存摘要，不能跨会话或路由串用容量。
    const key = createHash('sha256')
      .update(
        JSON.stringify([
          request.sessionId,
          selection,
          resolved.providerId,
          resolved.model,
          resolved.providerModel,
          resolved.contextWindow,
          resolved.modelRequestOptions,
        ])
      )
      .digest('hex')
    const capacity = capacities.get(key) ?? new ConversationContextCapacity(resolved.contextWindow)
    capacities.delete(key)
    capacities.set(key, capacity)
    if (capacities.size > CapacityCacheEntries) capacities.delete(capacities.keys().next().value!)
    const driver = createAiSdkModelDriver({
      id: resolved.model.startsWith(`${resolved.providerId}/`)
        ? resolved.model
        : `${resolved.providerId}/${resolved.model}`,
      model: resolved.provider(resolved.model, {
        ...resolved.modelRequestOptions,
        runtimeContext: {
          ...resolved.modelRequestOptions?.runtimeContext,
          sessionId: request.sessionId,
        },
      }),
      limits: {
        contextTokens: capacity.contextTokens,
        outputTokens: capacity.outputTokens,
        inputTokens: capacity.inputTokens,
      },
    })
    return {
      model: new ConversationModelDriver(driver, capacity),
      provider: resolved.providerId,
      imageInput: resolved.supportedInputModalities.includes('image'),
    }
  }
}
