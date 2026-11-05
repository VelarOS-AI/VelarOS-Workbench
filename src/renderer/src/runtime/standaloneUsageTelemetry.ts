import type { ConversationView } from '@velaros-ai/ui/conversation'
import {
  isFiniteNumber,
  isNonBlankString,
  optionalWhen,
  toOptional,
} from '@velaros-ai/velaros/core'

/**
 * 主 Agent 与子 Agent 每次模型调用的供应方用量（`usage-telemetry` 运行时事件）。
 *
 * 共享会话视图按执行时间窗从这里归属用量，给回答末尾算整轮约价（Desktop 同样把它交给
 * `runtime.usageTelemetry`）。丢掉它，约价就只能拿可见问答文字去估——一次上百轮的执行只数到
 * 最后一段回答，低估几个数量级。
 */
type StandaloneUsageTelemetry = ConversationView['runtime']['usageTelemetry'][number] & {
  requestId?: string
  agentSessionId?: string
  agentRole?: 'parent' | 'child'
  coverage?: 'known' | 'unknown' | 'inflight'
}

/**
 * 会话最多保留一万次请求（含全部子任务）；超过时界面明确显示仅保留最近记录，原始事件日志不裁剪。
 */
const StandaloneUsageTelemetryLimit = 10000

const UsageSources = new Set<StandaloneUsageTelemetry['source']>([
  'provider',
  'provider-count',
  'gateway-cost',
  'local-estimate',
])
const UsageConfidences = new Set<StandaloneUsageTelemetry['confidence']>(['high', 'medium', 'low'])

function readTokenCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

function readUsageSource(value: unknown): StandaloneUsageTelemetry['source'] {
  return UsageSources.has(value as StandaloneUsageTelemetry['source'])
    ? (value as StandaloneUsageTelemetry['source'])
    : 'provider'
}

function readUsageConfidence(value: unknown): StandaloneUsageTelemetry['confidence'] {
  return UsageConfidences.has(value as StandaloneUsageTelemetry['confidence'])
    ? (value as StandaloneUsageTelemetry['confidence'])
    : 'high'
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
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
    requestId: typeof payload.requestId === 'string' ? payload.requestId : undefined,
    agentSessionId: typeof payload.agentSessionId === 'string' ? payload.agentSessionId : undefined,
    agentRole:
      payload.agentRole === 'parent' || payload.agentRole === 'child'
        ? payload.agentRole
        : undefined,
    coverage:
      payload.coverage === 'known' ||
      payload.coverage === 'unknown' ||
      payload.coverage === 'inflight'
        ? payload.coverage
        : undefined,
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
    ...entries.filter((current) =>
      entry.requestId
        ? current.requestId !== entry.requestId
        : !(
            current.turn === entry.turn &&
            current.timestamp === entry.timestamp &&
            !current.requestId
          )
    ),
    entry,
  ].slice(-StandaloneUsageTelemetryLimit)
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

/**
 * 与 Desktop 的持久化指纹缓存一致：不可变输入不变时复用派生结果。
 * 每个持久化器独占缓存，弱引用不保留已删除会话；返回值只供序列化，不得修改。
 */
export function createStandaloneUsageTelemetrySerializer(): (
  entries: readonly StandaloneUsageTelemetry[]
) => ReadonlyArray<Readonly<Record<string, unknown>>> {
  const cache = new WeakMap<
    readonly StandaloneUsageTelemetry[],
    ReadonlyArray<Readonly<Record<string, unknown>>>
  >()
  return (entries) => {
    const cached = cache.get(entries)
    if (cached) return cached
    const serialized = serializeStandaloneUsageTelemetry(entries)
    cache.set(entries, serialized)
    return serialized
  }
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
  serializeStandaloneUsageTelemetry,
  StandaloneUsageTelemetryLimit,
}
export type { StandaloneUsageTelemetry }

/** 按请求身份去重后的真实供应商计数；缺失不当作零参与完整命中率。 */
export function summarizeStandaloneUsage(entries: readonly StandaloneUsageTelemetry[]) {
  const unique = new Map(entries.map((entry, i) => [entry.requestId ?? `legacy:${i}`, entry]))
  const rows = [...unique.values()]
  const cacheKnown = rows.filter(
    (item) =>
      item.coverage !== 'inflight' &&
      isFiniteNumber(item.inputTokens) &&
      item.inputTokens >= 0 &&
      isFiniteNumber(item.cacheReadInputTokens) &&
      item.cacheReadInputTokens >= 0
  )
  return {
    requests: rows.length,
    input: rows.reduce((sum, item) => sum + (item.inputTokens ?? 0), 0),
    output: rows.reduce((sum, item) => sum + (item.outputTokens ?? 0), 0),
    cacheRead: rows.reduce((sum, item) => sum + (item.cacheReadInputTokens ?? 0), 0),
    cacheKnownRequests: cacheKnown.length,
    cacheKnownInputTokens: cacheKnown.reduce((sum, item) => sum + item.inputTokens!, 0),
    cacheKnownReadTokens: cacheKnown.reduce((sum, item) => sum + item.cacheReadInputTokens!, 0),
    missing: rows.filter(
      (item) =>
        item.inputTokens === null ||
        item.outputTokens === null ||
        item.coverage === 'unknown' ||
        item.coverage === 'inflight'
    ).length,
    cacheMissing: rows.filter(
      (item) => item.cacheReadInputTokens === undefined || item.inputTokens === null
    ).length,
  }
}
