import type { ReactElement, ReactNode } from 'react'

import { Text } from '@velaros-ai/ui/primitives/display/Text'

import styles from '../../styles/workbenchPageStyles'

/** 设置里的一行：左边名字与说明，右边控件。 */
export function SettingRow({
  title,
  description,
  children,
}: {
  title: string
  description?: string
  children: ReactNode
}): ReactElement {
  return (
    <div className={styles.workbenchSettingsRow}>
      <div className={styles.workbenchSettingsRowMeta}>
        <Text className={styles.workbenchSettingsRowTitle}>{title}</Text>
        {!!description && (
          <Text tone="caption" className={styles.workbenchSettingsRowDescription}>
            {description}
          </Text>
        )}
      </div>
      <div className={styles.workbenchSettingsRowControl}>{children}</div>
    </div>
  )
}

/** 设置里只读的小标签（语言、规则来源、按键）。 */
export function WorkbenchSettingsPill({
  children,
  tone = 'default',
}: {
  children: ReactNode
  tone?: 'default' | 'success' | 'warning'
}): ReactElement {
  return (
    <span className={styles.workbenchSettingsPill} data-tone={tone}>
      {children}
    </span>
  )
}
