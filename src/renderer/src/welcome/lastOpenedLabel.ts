/** 最近项目「最后打开时间」的展示文案（相对时间，超一周落回日期）。 */

const MinuteMs = 60_000
const HourMs = 3_600_000
const DayMs = 86_400_000
const WeekMs = 7 * DayMs

export function lastOpenedLabel(lastOpenedAt: number, now: number = Date.now()): string {
  const elapsed = now - lastOpenedAt
  if (elapsed < MinuteMs) return '刚刚'
  if (elapsed < HourMs) return `${Math.floor(elapsed / MinuteMs)} 分钟前`
  if (elapsed < DayMs) return `${Math.floor(elapsed / HourMs)} 小时前`
  if (elapsed < WeekMs) return `${Math.floor(elapsed / DayMs)} 天前`

  return new Date(lastOpenedAt).toLocaleDateString('zh-CN')
}
