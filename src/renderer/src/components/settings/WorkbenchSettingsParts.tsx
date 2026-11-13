import {
  cloneElement,
  type CSSProperties,
  isValidElement,
  type ReactElement,
  type ReactNode,
  useId,
  useState,
} from 'react'
import { CaretRightIcon } from '@phosphor-icons/react'

import { Text } from '@velaros-ai/ui/primitives/display/Text'
import { Input } from '@velaros-ai/ui/primitives/forms/Input'
import { Select } from '@velaros-ai/ui/primitives/forms/Select'
import { Switch } from '@velaros-ai/ui/primitives/forms/Switch'

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
  const controlId = useId()
  const titleId = `${controlId}-title`
  const descriptionId = description ? `${controlId}-description` : undefined
  const directControl =
    isValidElement<{ id?: string }>(children) &&
    (children.type === Input || children.type === Select || children.type === Switch)
  return (
    <div
      className={styles.workbenchSettingsRow}
      role="group"
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
    >
      <div className={styles.workbenchSettingsRowMeta}>
        <label
          id={titleId}
          htmlFor={directControl ? (children.props.id ?? controlId) : undefined}
          className={styles.workbenchSettingsRowTitle}
        >
          {title}
        </label>
        {!!description && (
          <Text
            id={descriptionId}
            tone="caption"
            className={styles.workbenchSettingsRowDescription}
          >
            {description}
          </Text>
        )}
      </div>
      <div className={styles.workbenchSettingsRowControl}>
        {directControl ? cloneElement(children, { id: children.props.id ?? controlId }) : children}
      </div>
    </div>
  )
}

/** Mount expensive settings only when their disclosure is opened. */
export function SettingsDisclosure({
  title,
  description,
  defaultOpen = false,
  onExpandedChange,
  children,
}: {
  title: string
  description?: string
  defaultOpen?: boolean
  onExpandedChange?: (expanded: boolean) => void
  children: ReactNode
}): ReactElement {
  const [expanded, setExpanded] = useState(defaultOpen)
  return (
    <details
      className={styles.workbenchSettingsDisclosure}
      open={expanded}
      onToggle={(event) => {
        const next = event.currentTarget.open
        setExpanded(next)
        onExpandedChange?.(next)
      }}
    >
      <summary className={styles.workbenchSettingsDisclosureSummary}>
        <span className={styles.workbenchSettingsDisclosureCopy}>
          <span className={styles.workbenchSettingsDisclosureTitle}>{title}</span>
          {description && (
            <span className={styles.workbenchSettingsDisclosureDescription}>{description}</span>
          )}
        </span>
        <CaretRightIcon
          size={18}
          className={styles.workbenchSettingsDisclosureCaret}
          aria-hidden="true"
        />
      </summary>
      {expanded && <div className={styles.workbenchSettingsDisclosureContent}>{children}</div>}
    </details>
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

/** Native range behavior with a consistent, borderless track and filled value. */
export function SettingsSlider({
  min,
  max,
  step,
  value,
  label,
  onChange,
}: {
  min: number
  max: number
  step: number
  value: number
  label: string
  onChange: (value: number) => void
}): ReactElement {
  const progress = Math.max(0, Math.min(100, ((value - min) / (max - min)) * 100))
  return (
    <input
      type="range"
      min={min}
      max={max}
      step={step}
      value={value}
      aria-label={label}
      className={styles.workbenchSettingsSlider}
      style={{ '--settings-range-progress': `${progress}%` } as CSSProperties}
      onChange={(event) => onChange(Number(event.currentTarget.value))}
    />
  )
}
