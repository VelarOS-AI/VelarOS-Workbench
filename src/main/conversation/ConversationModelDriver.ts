import type {
  ModelDriver,
  ModelInputEstimate,
  ModelTurnDelta,
  ModelTurnRequest,
} from '@velaros-ai/model'

import type { ConversationContextCapacity } from './ConversationContextCapacity'

/** Workbench 的容量试探策略；请求编码和超限后的上下文重组由 Platform 负责。 */
export class ConversationModelDriver implements ModelDriver {
  public readonly id: string
  public readonly nativeTools: boolean

  public constructor(
    private readonly driver: ModelDriver,
    public readonly limits: ConversationContextCapacity
  ) {
    this.id = driver.id
    this.nativeTools = Boolean(driver.nativeTools)
  }

  public estimate(request: ModelTurnRequest): Promise<ModelInputEstimate> {
    return this.driver.estimate(request)
  }

  public async *stream(
    request: ModelTurnRequest,
    signal: AbortSignal
  ): AsyncIterable<ModelTurnDelta> {
    // 超限会让底层估算器清空校准，提前保留这次请求实际使用的估算。
    const estimate = await this.driver.estimate(request)
    signal.throwIfAborted()
    for await (const delta of this.driver.stream(request, signal)) {
      signal.throwIfAborted()
      if (delta.type === 'error' && this.limits.reject(delta, estimate.tokens))
        // 带明确输入上限的超长提示也进入同一恢复路径，不按瞬时服务故障重放原请求。
        yield { type: 'error', code: 'context-limit', message: delta.message }
      else yield delta
    }
  }
}
