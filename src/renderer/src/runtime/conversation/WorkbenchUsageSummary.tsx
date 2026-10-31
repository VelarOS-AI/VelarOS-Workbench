import { useState } from 'react'
import { ChartBarIcon } from '@phosphor-icons/react'
import type { ReactElement } from 'react'

import {
  Popover,
  PopoverAnchor,
  PopoverContent,
} from '@velaros-ai/ui/primitives/overlays/Popover'

import { useWorkbenchI18n } from '../../i18n/WorkbenchLocalizationProvider'
import {
  type StandaloneUsageTelemetry,
  StandaloneUsageTelemetryLimit,
  summarizeStandaloneUsage,
} from '../standaloneUsageTelemetry'

import styles from '../../styles/WorkbenchNotebook.module.css'

export function WorkbenchUsageSummary({
  entries,
  startedAt,
}: {
  entries: readonly StandaloneUsageTelemetry[]
  startedAt: number | null
}): ReactElement {
  const [open, setOpen] = useState(false)
  const { locale } = useWorkbenchI18n()
  const zh = locale === 'zh-CN'
  const title = zh ? '本次任务用量' : 'Task usage'
  const current = entries.filter((entry) => !startedAt || entry.timestamp >= startedAt)
  const groups = [
    [zh ? '主 Agent' : 'Parent', current.filter((entry) => entry.agentRole !== 'child')],
    [
      zh ? '子 Agent' : 'Children',
      current.filter((entry) => entry.agentRole === 'child'),
    ],
    [zh ? '合计' : 'Total', current],
  ] as const
  const format = (value: number) => value.toLocaleString(locale)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverAnchor asChild>
        <button
          type="button"
          className={styles.trigger}
          title={title}
          aria-label={title}
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          <ChartBarIcon size={16} />
        </button>
      </PopoverAnchor>
      <PopoverContent
        align="end"
        side="top"
        sideOffset={4}
        widthStrategy="content"
        className={styles.popover}
      >
        <section className={styles.panel} aria-label={title}>
          <strong>{title}</strong>
          {groups.map(([name, items]) => {
            const stats = summarizeStandaloneUsage(items)
            const ratio =
              stats.input > 0 && !stats.cacheMissing
                ? `${((stats.cacheRead / stats.input) * 100).toFixed(1)}%`
                : '—'
            return (
              <article className={styles.item} key={name}>
                <header>
                  <strong>{name}</strong>
                  <span>
                    {format(stats.requests)} {zh ? '次请求' : 'requests'}
                  </span>
                </header>
                <p>
                  {zh ? '输入 / 输出' : 'Input / output'}: {format(stats.input)} /{' '}
                  {format(stats.output)}
                  <br />
                  {zh ? '缓存读取' : 'Cache read'}: {format(stats.cacheRead)} ({ratio})
                </p>
                {!!stats.missing && (
                  <p>
                    {zh
                      ? `有 ${stats.missing} 次用量尚未完整报告`
                      : `${stats.missing} requests have incomplete usage`}
                  </p>
                )}
                {!!stats.cacheMissing && (
                  <p>
                    {zh
                      ? `有 ${stats.cacheMissing} 次缺少缓存计数`
                      : `${stats.cacheMissing} requests lack cache counts`}
                  </p>
                )}
              </article>
            )
          })}
          <p>
            {zh
              ? '包含所有层级子任务；缓存比例按输入 token 计算。'
              : 'Includes descendant agents; cache ratio is weighted by input tokens.'}
          </p>
          {entries.length >= StandaloneUsageTelemetryLimit && (
            <p>
              {zh
                ? '仅显示最近 10,000 次请求，完整记录保存在事件日志中。'
                : 'Only the latest 10,000 requests are shown; the event journal retains all records.'}
            </p>
          )}
        </section>
      </PopoverContent>
    </Popover>
  )
}
