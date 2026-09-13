import { isNonBlankString, optionalWhen, toOptional } from '@velaros-ai/core'
import type { ConversationView } from '@velaros-ai/ui/conversation'

/**
 * 主 Agent 每次模型调用的供应方用量（`usage-telemetry` 运行时事件）。
 *
 * 共享会话视图按执行时间窗从这里归属用量，给回答末尾算整轮约价（Desktop 同样把它交给
 * `runtime.usageTelemetry`）。丢掉它，约价就只能拿可见问答文字去估——一次上百轮的执行只数到
 * 最后一段回答，低估几个数量级。
 */
type StandaloneUsageTelemetry = ConversationView['runtime']['usageTelemetry'][number]

/**
 * 会话里留存的条数上限：一次长目标执行能跑到两三百轮，留四百条保证最近几轮执行完整；更早的执行被
 * 挤掉一部分时，约价会标成下限或不显示，不会显示错数。
 */
const StandaloneUsageTelemetryLimit = 400

const UsageSources = new Set<StandaloneUsageTelemetry['source']>([
  'provider',
  'provider-count',
  'gateway-cost',
  'local-estimate',
])
const UsageConfidences = new Set<StandaloneUsageTelemetry['confidence']>([
  'high',
  'medium',
  'low',
])

function readTokenCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

function readUsageSource(value: unknown): StandaloneUsageTelemetry['source'] {
  return UsageSources.has(value as StandaloneUsageTelemetry['source'])
    ? value as StandaloneUsageTelemetry['source']
    : 'provider'
}

function readUsageConfidence(value: unknown): StandaloneUsageTelemetry['confidence'] {
  return UsageConfidences.has(value as StandaloneUsageTelemetry['confidence'])
    ? value as StandaloneUsageTelemetry['confidence']
    : 'high'
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

/**
 * 从 `usage-telemetry` 运行时事件里收一条用量；模型与时间戳缺失的一律当没有。只留计价要用的字段，
 * 结束原因之类的诊断不进会话状态。
 */
function readStandaloneUsageTelemetry(value: unknown): StandaloneUsageTelemetry | null {
  const payload = asRecord(value)
  if (payload.kind !== 'usage-telemetry') return null
  const model = typeof payload.model === 'string' ? payload.model : null
  const timestamp = readTokenCount(payload.timestamp)
  if (model === null || timestamp === null) return null

  const turn = payload.turn
  const visibleOutputTokens = readTokenCount(payload.visibleOutputTokens)
  const cachedInputTokens = readTokenCount(payload.cachedInputTokens)
  const cacheReadInputTokens = readTokenCount(payload.cacheReadInputTokens)
  const cacheWriteInputTokens = readTokenCount(payload.cacheWriteInputTokens)
  const costUsd = readTokenCount(payload.costUsd)
  return {
    kind: 'usage-telemetry',
    turn: typeof turn === 'number' && Number.isInteger(turn) && turn > 0 ? turn : null,
    provider: optionalWhen(isNonBlankString, payload.provider)?.trim(),
    model,
    inputTokens: readTokenCount(payload.inputTokens),
    outputTokens: readTokenCount(payload.outputTokens),
    totalTokens: readTokenCount(payload.totalTokens),
    reasoningTokens: readTokenCount(payload.reasoningTokens),
    visibleOutputTokens: toOptional(visibleOutputTokens),
    cachedInputTokens: toOptional(cachedInputTokens),
    cacheReadInputTokens: toOptional(cacheReadInputTokens),
    cacheWriteInputTokens: toOptional(cacheWriteInputTokens),
    costUsd: toOptional(costUsd),
    source: readUsageSource(payload.source),
    confidence: readUsageConfidence(payload.confidence),
    timestamp,
  }
}

/** 追加一条用量：同一轮同一时刻的重复事件只留一条（与 Desktop 同一口径），超出上限丢最旧的。 */
function appendStandaloneUsageTelemetry(
  entries: readonly StandaloneUsageTelemetry[],
  entry: StandaloneUsageTelemetry
): readonly StandaloneUsageTelemetry[] {
  return [
    ...entries.filter(
      (current) => !(current.turn === entry.turn && current.timestamp === entry.timestamp)
    ),
    entry,
  ].slice(-StandaloneUsageTelemetryLimit)
}

/**
 * 回溯截断对话后，只留仍在会话里的那些执行的用量：最后一条保留下来的运行标记之后的用量属于被
 * 截掉的执行，留着只会占上限。
 */
function retainStandaloneUsageTelemetryThrough(
  entries: readonly StandaloneUsageTelemetry[],
  keptUntil: number | null
): readonly StandaloneUsageTelemetry[] {
  if (keptUntil === null) return []
  return entries.filter((entry) => entry.timestamp <= keptUntil)
}

/** 落盘形状：去掉固定的 `kind` 与空字段（本地存储配额紧，每条都在每个会话里重复）。 */
function serializeStandaloneUsageTelemetry(
  entries: readonly StandaloneUsageTelemetry[]
): Array<Record<string, unknown>> {
  return entries.map((entry) =>
    Object.fromEntries(
      Object.entries(entry).filter(
        ([key, value]) => key !== 'kind' && value !== null && value !== undefined
      )
    )
  )
}

/** 恢复落盘的用量；形状不对的条目丢掉。 */
function restoreStandaloneUsageTelemetry(value: unknown): readonly StandaloneUsageTelemetry[] {
  if (!Array.isArray(value)) return []
  return value
    .map((candidate) =>
      readStandaloneUsageTelemetry({ ...asRecord(candidate), kind: 'usage-telemetry' })
    )
    .filter((entry): entry is StandaloneUsageTelemetry => entry !== null)
    .slice(-StandaloneUsageTelemetryLimit)
}

export {
  appendStandaloneUsageTelemetry,
  readStandaloneUsageTelemetry,
  restoreStandaloneUsageTelemetry,
  retainStandaloneUsageTelemetryThrough,
  serializeStandaloneUsageTelemetry,
  StandaloneUsageTelemetryLimit,
}
export type { StandaloneUsageTelemetry }
