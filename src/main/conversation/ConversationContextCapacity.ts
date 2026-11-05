import type { ModelTurnDelta } from '@velaros-ai/velaros/model'

import type { ConversationModelLimits } from './WorkbenchConversationTypes'

/** 未声明容量时的试探预算；真实超限后按服务商反馈收紧，不冒充模型规格。 */
const ProvisionalContextTokens = 1_000_000
const MaximumOutputTokens = 12_000
const SafetyTokens = 4_096
const RejectedInputRatio = 0.9

/** 同一模型路由的容量状态；保持对象身份，让运行时恢复与用量投影读到同一份最新上限。 */
export class ConversationContextCapacity implements ConversationModelLimits {
  public contextTokens: number
  public outputTokens: number
  public inputTokens: number
  // 容量合同的可枚举字段只含三个数；可信度是 Workbench 的展示信息。
  #provisional: boolean

  public constructor(contextWindow?: number) {
    this.contextTokens = contextWindow ?? ProvisionalContextTokens
    this.outputTokens = 0
    this.inputTokens = 0
    this.#provisional = !contextWindow
    this.resize(this.contextTokens)
  }

  public get contextWindowEstimated(): boolean {
    return this.#provisional
  }

  /** 识别服务商明确的容量反馈；普通限流、鉴权或网络错误不改变容量。 */
  public reject(
    failure: Extract<ModelTurnDelta, { type: 'error' }>,
    attemptedInputTokens: number
  ): boolean {
    const { message } = failure
    // 只取明确标识为最大容量的数字，不能把本次请求的 token 数误记成模型上限。
    const reported =
      /maximum context (?:length|window)(?: is| of|:)?\s*([\d,]+)\s*tokens/iu.exec(message) ??
      /(?:context (?:length|window|limit)|max(?:imum)?[_ ]context[_ ](?:length|tokens))\s*[:=]\s*([\d,]+)/iu.exec(
        message
      )
    const inputMaximum =
      /prompt is too long:.{0,100}tokens\s*>\s*([\d,]+)\s*(?:maximum|max)\b/iu.exec(message) ??
      /(?:maximum (?:number of )?input tokens(?: allowed)?|input token limit)(?: is| of|:)?\s*\(?([\d,]+)\)?/iu.exec(
        message
      ) ??
      /input token count.{0,100}maximum number of tokens allowed\s*\(?([\d,]+)\)?/iu.exec(message)
    const value = Number((reported ?? inputMaximum)?.[1]?.replaceAll(',', ''))
    if (Number.isSafeInteger(value) && value > 0) {
      const window = reported ? value : value + this.outputTokens
      if (window <= this.contextTokens) {
        const inputCeiling = reported
          ? window
          : Math.max(1, value - Math.min(SafetyTokens, Math.floor(value / 4)))
        this.resize(window, inputCeiling)
        this.#provisional = false
      }
      return true
    }
    if (failure.code !== 'context-limit') return false

    // 未报具体上限时，从被拒请求附近收紧，避免骤降到统一的小窗口；恢复仍由 Platform 有界重组。
    const input = Math.max(
      1,
      Math.floor(Math.min(this.inputTokens, attemptedInputTokens) * RejectedInputRatio)
    )
    this.resize(Math.min(this.contextTokens - 1, input + this.outputTokens + SafetyTokens), input)
    this.#provisional = true
    return true
  }

  private resize(window: number, inputCeiling = window): void {
    this.contextTokens = window
    this.outputTokens = Math.min(MaximumOutputTokens, Math.floor(window / 4))
    this.inputTokens = Math.min(
      inputCeiling,
      window - this.outputTokens - Math.min(SafetyTokens, Math.floor(window / 4))
    )
  }
}
