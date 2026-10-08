import { type ReactElement } from 'react'

import {
  ChatContextUsageGauge,
  formatChatContextUsagePercent,
  resolveChatContextUsageTone,
} from '@velaros-ai/ui/conversation'

import { useWorkbenchI18n } from '../../i18n/WorkbenchLocalizationProvider'
import type { StandaloneContextUsageEstimate } from '../standaloneWorkbenchChatRuntime'

import styles from '../../styles/WorkbenchContextUsageIndicator.module.css'

/** 最近一次真实模型请求的用量；容量由主进程按声明或服务商反馈校准，执行中保留最近记录。 */
export function WorkbenchContextUsageIndicator({
  usage,
}: {
  usage: Nullable<StandaloneContextUsageEstimate>
}): Nullable<ReactElement> {
  const { t, locale } = useWorkbenchI18n()

  // 首轮用量还未回报时保留空仪表，避免运行期间改变输入框布局。
  const percentLabel = usage
    ? formatChatContextUsagePercent(usage.percent)
    : t('workbench.contextUsagePending')
  const capacityNote = usage?.contextWindowEstimated ? ` · ${t('workbench.contextCapacityProvisional')}` : ''
  const detail = usage
    ? `${percentLabel} · ${formatCompactTokens(locale, usage.estimatedTokens)} / ${formatCompactTokens(locale, usage.usableContextWindow)} ${t('workbench.tokenUnit')}${capacityNote}`
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
