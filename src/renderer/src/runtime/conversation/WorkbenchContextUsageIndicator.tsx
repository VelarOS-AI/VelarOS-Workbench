import { type ReactElement } from 'react'

import {
  ChatContextUsageGauge,
  formatChatContextUsagePercent,
  resolveChatContextUsageTone,
} from '@velaros-ai/ui/conversation'

import { useWorkbenchI18n } from '../../i18n'
import type { StandaloneContextUsageEstimate } from '../standaloneWorkbenchChatRuntime'

/**
 * Workbench 的上下文用量仪表。
 *
 * 数**不在这里算**：main 侧的请求编译器每轮送核前都会算一次并经 `context-usage-estimate`
 * 事件发出来，那才是真正决定压缩与送核的那把尺子。渲染层重算一遍只会得到第二个数——
 * 它和门禁用的那个必然在边角上分叉，而用户看到的偏偏是错的那个。
 *
 * 顺带的收益是包体：`estimateContextUsage` 住在 `@velaros-ai/agent/chat` 这个桶里，
 * 为两个数把整条流式管线拖进 renderer 启动块要多花 2 MB 多。
 *
 * 像素与色阶归共享组件，两端因此长得一模一样。
 */
export function WorkbenchContextUsageIndicator({
  usage,
}: {
  usage: Nullable<StandaloneContextUsageEstimate>
}): Nullable<ReactElement> {
  const { t, locale } = useWorkbenchI18n()
  if (!usage) return null

  const percentLabel = formatChatContextUsagePercent(usage.percent)
  const usedLabel = formatCompactTokens(locale, usage.estimatedTokens)
  const totalLabel = formatCompactTokens(locale, usage.usableContextWindow)

  return (
    <ChatContextUsageGauge
      variant="icon"
      tone={resolveChatContextUsageTone(usage.percent)}
      ringPercent={usage.percent}
      label={percentLabel}
      ariaLabel={`${t('workbench.contextUsage')}: ${percentLabel}, ${usedLabel} / ${totalLabel}`}
      tooltip={{
        title: t('workbench.contextUsageEstimate'),
        meta: `${percentLabel} · ${usedLabel} / ${totalLabel} ${t('workbench.tokenUnit')}`,
      }}
    />
  )
}

function formatCompactTokens(locale: string, tokens: number): string {
  if (tokens < 1000) return String(Math.round(tokens))
  return `${new Intl.NumberFormat(locale, {
    maximumFractionDigits: tokens < 10_000 ? 1 : 0,
  }).format(tokens / 1000)}K`
}
