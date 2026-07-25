import { type CSSProperties, type ReactElement } from 'react'

import { isPresent } from '@velaros/core'
import { Text } from '@velaros/ui/primitives/display/Text'

import styles from '../../styles/workbenchPageStyles'

export interface HistoryTimelineItem {
  id: string
  title: string
  subtitle?: LooseOptional<string>
  meta?: LooseOptional<string>
  timestamp?: LooseOptional<number>
  special?: boolean
  badges?: LooseOptional<string[]>
}

export type HistoryTimelineBucket = 'today' | 'week' | 'month' | 'older'
export type HistoryTimelinePalette = Record<HistoryTimelineBucket, string>

const DefaultTimelinePalette: HistoryTimelinePalette = {
  today: 'var(--status-violet)',
  week: 'var(--status-blue)',
  month: 'var(--status-green)',
  older: 'var(--muted-foreground)',
}
const DayMs = 86_400_000

function resolveTimelineBucket(timestamp: number, now: number): HistoryTimelineBucket {
  const elapsed = now - timestamp
  if (elapsed < DayMs) return 'today'
  if (elapsed < 7 * DayMs) return 'week'
  if (elapsed < 30 * DayMs) return 'month'
  return 'older'
}

export function HistoryTimeline({
  items,
  selectedId,
  onSelect,
  palette,
}: {
  items: HistoryTimelineItem[]
  selectedId: Nullable<string>
  onSelect: (id: string) => void
  palette?: Partial<HistoryTimelinePalette>
}): ReactElement {
  const now = Date.now()
  const colors = { ...DefaultTimelinePalette, ...palette }

  return (
    <ol className={styles.historyTimeline}>
      {items.map((item) => {
        const color = isPresent(item.timestamp)
          ? colors[resolveTimelineBucket(item.timestamp, now)]
          : DefaultTimelinePalette.today
        return (
          <li
            key={item.id}
            className={styles.historyTimelineItem}
            style={{ '--timeline-node-color': color } as CSSProperties}
          >
            <button
              type="button"
              className={styles.historyTimelineRow}
              data-active={selectedId === item.id}
              onClick={() => onSelect(item.id)}
            >
              <span className={styles.historyTimelineRail} aria-hidden>
                <span
                  className={styles.historyTimelineDot}
                  data-special={item.special ? 'true' : undefined}
                />
              </span>
              <span className={styles.historyTimelineBody}>
                <span className={styles.historyTimelinePrimaryRow}>
                  {item.badges?.map((badge) => (
                    <span key={badge} className={styles.historyTimelineBadge}>
                      {badge}
                    </span>
                  ))}
                  <Text truncate className={styles.historyTimelinePrimary}>
                    {item.title}
                  </Text>
                </span>
                {(!!item.subtitle || !!item.meta) && (
                  <span className={styles.historyTimelineMetaRow}>
                    {!!item.subtitle && (
                      <Text truncate className={styles.historyTimelineSecondary}>
                        {item.subtitle}
                      </Text>
                    )}
                    {!!item.meta && (
                      <Text truncate className={styles.historyTimelineMeta}>
                        {item.meta}
                      </Text>
                    )}
                  </span>
                )}
              </span>
            </button>
          </li>
        )
      })}
    </ol>
  )
}
