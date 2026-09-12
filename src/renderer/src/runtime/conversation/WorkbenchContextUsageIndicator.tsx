import { type ReactElement } from 'react'

import {
  ChatContextUsageGauge,
  formatChatContextUsagePercent,
  resolveChatContextUsageTone,
} from '@velaros-ai/ui/conversation'

import { useWorkbenchI18n } from '../../i18n'
import type { StandaloneContextUsageEstimate } from '../standaloneWorkbenchChatRuntime'

import styles from './WorkbenchContextUsageIndicator.module.css'

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

  /*
   * 还没跑过任何一轮时**照样在场**，只是空表。
   *
   * 用量数出自 main 每轮送核前的那次估算，新会话自然还没有；如果这时整格隐身，仪表就变成
   * 「聊过才出现」的幽灵控件——用户第一次打开会话根本不知道有这块表，输入框右侧还会在首轮
   * 结束后突然多出一个控件、把旁边的按钮挤动一下。空表既守住了位置，也如实说明「尚未估算」。
   */
  const percentLabel = usage
    ? formatChatContextUsagePercent(usage.percent)
    : t('workbench.contextUsagePending')
  const detail = usage
    ? `${percentLabel} · ${formatCompactTokens(locale, usage.estimatedTokens)} / `
      + `${formatCompactTokens(locale, usage.usableContextWindow)} ${t('workbench.tokenUnit')}`
    : t('workbench.contextUsagePendingHint')

  // 包一层只为给共享仪表一个 Workbench 自己的样式作用域（外圈描边在这层下收掉，见样式文件）。
  return (
    <span className={styles.gauge}>
      <ChatContextUsageGauge
        variant="icon"
        tone={usage ? resolveChatContextUsageTone(usage.percent) : 'safe'}
        ringPercent={usage?.percent ?? 0}
        label={percentLabel}
        ariaLabel={`${t('workbench.contextUsage')}: ${detail}`}
        tooltip={{
          title: t('workbench.contextUsageEstimate'),
          meta: detail,
        }}
      />
    </span>
  )
}

function formatCompactTokens(locale: string, tokens: number): string {
  if (tokens < 1000) return String(Math.round(tokens))
  return `${new Intl.NumberFormat(locale, {
    maximumFractionDigits: tokens < 10_000 ? 1 : 0,
  }).format(tokens / 1000)}K`
}
