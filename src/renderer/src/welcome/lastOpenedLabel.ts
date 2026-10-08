/** 最近项目「最后打开时间」的展示文案：一分钟内是 `justNow`，一周内是相对时间（昨天、3 小时前……），再早是日期。 */
import { type AppLocale } from '@velaros-ai/ui/conversation/contracts'

const MinuteMs = 60_000
const HourMs = 3_600_000
const DayMs = 86_400_000
const WeekMs = 7 * DayMs

export function lastOpenedLabel(
  lastOpenedAt: number,
  locale: AppLocale,
  justNow: string,
  now: number = Date.now()
): string {
  const elapsed = now - lastOpenedAt
  if (elapsed < MinuteMs) return justNow
  if (elapsed >= WeekMs) return new Date(lastOpenedAt).toLocaleDateString(locale)

  const relative = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' })
  if (elapsed < HourMs) return relative.format(-Math.floor(elapsed / MinuteMs), 'minute')
  if (elapsed < DayMs) return relative.format(-Math.floor(elapsed / HourMs), 'hour')
  return relative.format(-Math.floor(elapsed / DayMs), 'day')
}
